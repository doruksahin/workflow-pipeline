/**
 * Claude CLI caller — wraps `claude -p` into an LlmCaller.
 *
 * Ships as a convenience export. Consumers can provide their own LlmCaller instead.
 */
import { execSync, spawn } from 'node:child_process'

import { DEFAULT_CALLER_MAX_BUFFER, DEFAULT_CALLER_TIMEOUT_MS } from '../constants.js'
import type { LlmCaller, PipelineLogger } from '../types.js'
import { SILENT_LOGGER } from '../types.js'

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
  return (prompt: string, label: string) => callClaudeAsync(prompt, label, opts)
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
): Promise<CallClaudeResult> {
  const { timeoutMs, maxBuffer, logger } = opts
  const startTime = Date.now()

  logger.info('Calling claude -p', { label, timeoutMs, maxBuffer })

  return new Promise<CallClaudeResult>((resolve, reject) => {
    let settled = false

    const child = spawn('claude', ['-p', '--output-format', 'json'], {
      env: { ...process.env, CLAUDECODE: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const chunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let totalSize = 0

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
      chunks.push(chunk)
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
    })

    const timer = setTimeout(() => {
      child.kill()
      if (!settled) {
        settled = true
        reject(new Error(`claude -p timed out after ${timeoutMs}ms (${label})`))
      }
    }, timeoutMs)

    child.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return

      if (code !== 0) {
        settled = true
        reject(new Error(`claude -p exited with code ${code} (${label})`))
        return
      }

      const envelope = Buffer.concat(chunks).toString('utf8')
      const stderrText = Buffer.concat(stderrChunks).toString('utf8')

      let raw: string
      try {
        const parsed = JSON.parse(envelope)
        if (typeof parsed.result !== 'string') {
          throw new Error(`Unexpected envelope shape — missing "result" string field`)
        }
        raw = parsed.result
      } catch (err) {
        settled = true
        reject(
          new Error(`claude -p failed (${label}): ${err instanceof Error ? err.message : String(err)}`, {
            cause: err,
          }),
        )
        return
      }

      const elapsedMs = Date.now() - startTime

      logger.info('claude -p completed', { label, elapsedMs })

      settled = true
      resolve({ raw, elapsedMs, stderr: stderrText })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        reject(new Error(`claude -p failed (${label}): ${err.message}`, { cause: err }))
      }
    })

    // Write prompt to stdin and close
    child.stdin.write(prompt)
    child.stdin.end()
  })
}
