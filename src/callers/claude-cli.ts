/**
 * Claude CLI caller — wraps `claude -p` into an LlmCaller.
 *
 * Ships as a convenience export. Consumers can provide their own LlmCaller instead.
 */
import { execSync, spawn } from 'node:child_process'

import { DEFAULT_CALLER_MAX_BUFFER, DEFAULT_CALLER_TIMEOUT_MS } from '../constants.js'
import type { LlmCaller, PipelineContext, PipelineLogger } from '../types.js'
import { SILENT_LOGGER } from '../types.js'
import { createToolEmitters } from '../cli.js'
import type { ToolCallTrace } from './claude-stream.js'
import { processMessage } from './claude-stream.js'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ClaudeCallerOptions {
  /** Maximum time for a single `claude -p` call (ms). */
  timeoutMs: number
  /** Maximum buffer size for LLM response (bytes). */
  maxBuffer: number
  /** Structured logger for caller lifecycle events. */
  logger: PipelineLogger
}

export interface CallClaudeResult {
  raw: string
  elapsedMs: number
  stderr: string
}

// ── Defaults ─────────────────────────────────────────────────────────────────

/** Sensible defaults. Consumers spread to override individual fields. */
export const DEFAULT_CLAUDE_CALLER_OPTIONS: ClaudeCallerOptions = {
  timeoutMs: DEFAULT_CALLER_TIMEOUT_MS,
  maxBuffer: DEFAULT_CALLER_MAX_BUFFER,
  logger: SILENT_LOGGER,
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create an LlmCaller that uses `claude -p` CLI.
 *
 * Usage:
 *   import { createClaudeCaller, DEFAULT_CLAUDE_CALLER_OPTIONS } from 'step-pipeline/callers/claude-cli'
 *   const caller = createClaudeCaller(DEFAULT_CLAUDE_CALLER_OPTIONS)
 *   const caller = createClaudeCaller({ ...DEFAULT_CLAUDE_CALLER_OPTIONS, timeoutMs: 300_000 })
 */
export function createClaudeCaller(opts: ClaudeCallerOptions): LlmCaller {
  return (prompt: string, label: string, ctx?: PipelineContext) => callClaudeAsync(prompt, label, opts, ctx)
}

// ── Sync Call ────────────────────────────────────────────────────────────────

export function callClaude(prompt: string, label: string, opts: ClaudeCallerOptions): CallClaudeResult {
  const { timeoutMs, maxBuffer, logger } = opts
  const startTime = Date.now()

  logger.info('Calling claude -p', { label, timeoutMs, maxBuffer })

  let raw: string

  try {
    const envelope = execSync('claude -p --output-format json', {
      input: prompt,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer,
      env: { ...process.env, CLAUDECODE: '' },
    })

    const parsed = JSON.parse(envelope)
    if (typeof parsed.result !== 'string') {
      throw new Error(`Unexpected envelope shape — missing "result" string field`)
    }
    raw = parsed.result
  } catch (err) {
    throw new Error(`claude -p failed (${label}): ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    })
  }

  const elapsedMs = Date.now() - startTime

  logger.info('claude -p completed', { label, elapsedMs })

  return { raw, elapsedMs, stderr: '' }
}

// ── Async Call ───────────────────────────────────────────────────────────────

export function callClaudeAsync(
  prompt: string,
  label: string,
  opts: ClaudeCallerOptions,
  ctx?: PipelineContext,
): Promise<CallClaudeResult> {
  const { timeoutMs, maxBuffer, logger } = opts
  const startTime = Date.now()

  logger.info('Calling claude -p', { label, timeoutMs, maxBuffer, outputFormat: 'stream-json' })

  // Always wire tool emitters when ctx is available (runner always provides it)
  let onToolStart: (trace: ToolCallTrace) => void = () => {}
  let onToolCall: (trace: ToolCallTrace) => void = () => {}
  if (ctx?.onEvent && ctx?.currentStep) {
    const emitters = createToolEmitters(ctx.onEvent, ctx.currentStep)
    onToolStart = emitters.onToolStart
    onToolCall = emitters.onToolCall
  }

  return new Promise<CallClaudeResult>((resolve, reject) => {
    let settled = false

    // Always stream-json — every pipeline consumer gets real-time tool visibility
    const child = spawn('claude', ['-p', '--output-format', 'stream-json', '--verbose'], {
      env: { ...process.env, CLAUDECODE: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const stderrChunks: Buffer[] = []
    let totalSize = 0
    let buffer = ''
    let finalText = ''
    let sessionId: string | undefined
    const toolCalls: ToolCallTrace[] = []
    const pendingTools = new Map<string, { trace: ToolCallTrace; startMs: number }>()

    child.stdout.on('data', (chunk: Buffer) => {
      totalSize += chunk.length
      if (totalSize > maxBuffer) {
        child.kill()
        if (!settled) {
          settled = true
          reject(new Error(`claude -p output exceeded ${maxBuffer} bytes (${label})`))
        }
        return
      }

      buffer += chunk.toString('utf8')
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)
        if (!line) continue

        let msg: unknown
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }

        // Always forward the raw NDJSON line — this is the pipeline's public protocol
        if (ctx?.onEvent && ctx?.currentStep) {
          ctx.onEvent({
            type: 'step:output-line',
            step: ctx.currentStep,
            line,
            timestamp: Date.now(),
          })
        }

        const sid = processMessage(
          msg as Parameters<typeof processMessage>[0],
          toolCalls,
          pendingTools,
          onToolStart,
          onToolCall,
          (text) => { finalText = text },
          () => {},
        )
        if (sid) sessionId = sid
      }
    })

    child.stderr.on('data', (chunk: Buffer) => { stderrChunks.push(chunk) })

    const timer = setTimeout(() => {
      child.kill()
      if (!settled) { settled = true; reject(new Error(`claude -p timed out after ${timeoutMs}ms (${label})`)) }
    }, timeoutMs)

    child.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      if (code !== 0) { settled = true; reject(new Error(`claude -p exited with code ${code} (${label})`)); return }
      const elapsedMs = Date.now() - startTime
      const stderrText = Buffer.concat(stderrChunks).toString('utf8')
      logger.info('claude -p completed', { label, elapsedMs, outputFormat: 'stream-json', sessionId })

      // Emit session ID so TUI can display it for debugging
      if (sessionId && ctx?.onEvent && ctx?.currentStep) {
        ctx.onEvent({
          type: 'step:session',
          step: ctx.currentStep,
          sessionId,
          timestamp: Date.now(),
        })
      }

      settled = true
      resolve({ raw: finalText, elapsedMs, stderr: stderrText })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      if (!settled) { settled = true; reject(new Error(`claude -p failed (${label}): ${err.message}`, { cause: err })) }
    })

    // Write prompt to stdin and close
    child.stdin.write(prompt)
    child.stdin.end()
  })
}
