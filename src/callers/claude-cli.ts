/**
 * Claude CLI caller — wraps `claude -p` into an LlmCaller.
 *
 * Ships as a convenience export. Consumers can provide their own LlmCaller instead.
 */
import { execSync } from 'node:child_process'
import { execa } from 'execa'

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
 *   import { createClaudeCaller, DEFAULT_CLAUDE_CALLER_OPTIONS } from 'workflow-pipeline/callers/claude-cli'
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

export async function callClaudeAsync(
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

  const result = await execa('claude', ['-p', '--output-format', 'stream-json', '--verbose'], {
    input: prompt,
    timeout: timeoutMs,
    maxBuffer,
    reject: false,
    env: { ...process.env, CLAUDECODE: '' },
  })

  const elapsedMs = Date.now() - startTime

  if (result.timedOut) {
    throw new Error(`claude -p timed out after ${timeoutMs}ms (${label})`)
  }
  if (result.isCanceled) {
    throw new Error(`claude -p was cancelled (${label})`)
  }
  if (result.isMaxBuffer) {
    throw new Error(`claude -p output exceeded ${maxBuffer} bytes (${label})`)
  }
  if (result.exitCode !== 0) {
    throw new Error(`claude -p exited with code ${String(result.exitCode)} (${label})`)
  }

  // ── Envelope parsing (preserved from bespoke implementation) ─────────────────
  const toolCalls: ToolCallTrace[] = []
  const pendingTools = new Map<string, { trace: ToolCallTrace; startMs: number }>()
  let finalText = ''
  let sessionId: string | undefined

  const lines = result.stdout.split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }

    // Forward the raw NDJSON line — this is the pipeline's public protocol.
    // NOTE: events now fire post-hoc (after process completes) rather than
    // in real-time during subprocess execution. The observable contract —
    // that all NDJSON lines are emitted — is preserved.
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

  return { raw: finalText, elapsedMs, stderr: result.stderr }
}
