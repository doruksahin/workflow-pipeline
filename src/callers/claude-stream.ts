/**
 * Claude stream-json caller — parses `--output-format stream-json` NDJSON.
 *
 * Captures tool_use / tool_result blocks for tracing, extracts final text,
 * and optionally reports real-time per-tool callbacks.
 *
 * CAVEAT: The NDJSON message types below are a best-effort model of Claude Code's
 * stream-json format. The actual format may differ — in particular, tool_result
 * blocks may arrive as separate top-level NDJSON lines (type: 'user') rather than
 * as content blocks inside 'assistant' messages. Validate against real output
 * before relying on tool-call tracing in production.
 */
import { spawn } from 'node:child_process'

import split2 from 'split2'

import { DEFAULT_CALLER_MAX_BUFFER, DEFAULT_CALLER_TIMEOUT_MS } from '../constants.js'
import type { LlmCallerResult, PipelineLogger } from '../types.js'
import { SILENT_LOGGER } from '../types.js'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ToolCallTrace {
  id: string
  name: string
  input: Record<string, unknown>
  result: string
  elapsedMs: number
}

export interface StreamCallerResult extends LlmCallerResult {
  toolCalls: ToolCallTrace[]
  tokenUsage: { input: number; output: number }
}

export interface StreamCallerOptions {
  /** Maximum time for a single call (ms). */
  timeoutMs: number
  /** Maximum buffer size (bytes). */
  maxBuffer: number
  /** Structured logger for caller lifecycle events. */
  logger: PipelineLogger
  /** Real-time callback fired when a tool_use block is first encountered. Use () => {} for no-op. */
  onToolStart: (trace: ToolCallTrace) => void
  /** Real-time callback fired when a tool_result completes a trace. Use () => {} for no-op. */
  onToolCall: (trace: ToolCallTrace) => void
}

// ── Defaults ────────────────────────────────────────────────────────────────

/** Sensible defaults. Consumers spread to override individual fields. */
export const DEFAULT_STREAM_CALLER_OPTIONS: StreamCallerOptions = {
  timeoutMs: DEFAULT_CALLER_TIMEOUT_MS,
  maxBuffer: DEFAULT_CALLER_MAX_BUFFER,
  logger: SILENT_LOGGER,
  onToolStart() {},
  onToolCall() {},
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an LlmCaller that uses `claude -p --output-format stream-json`.
 *
 * Parses NDJSON lines, tracks tool_use/tool_result pairs, and returns
 * a StreamCallerResult (which satisfies LlmCallerResult).
 */
export function createClaudeStreamCaller(
  opts: StreamCallerOptions,
): (prompt: string, label: string) => Promise<StreamCallerResult> {
  return (prompt: string, label: string) =>
    callClaudeStream(prompt, label, opts)
}

// ── Stream Call ─────────────────────────────────────────────────────────────

function callClaudeStream(
  prompt: string,
  label: string,
  opts: StreamCallerOptions,
): Promise<StreamCallerResult> {
  const { timeoutMs, maxBuffer, logger, onToolStart, onToolCall } = opts
  const startTime = Date.now()

  logger.info('Calling claude -p stream-json', { label, timeoutMs, maxBuffer })

  return new Promise<StreamCallerResult>((resolve, reject) => {
    let settled = false

    const child = spawn('claude', ['-p', '--output-format', 'stream-json'], {
      env: { ...process.env, CLAUDECODE: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let totalSize = 0
    const stderrChunks: Buffer[] = []
    const toolCalls: ToolCallTrace[] = []
    const pendingTools = new Map<string, { trace: ToolCallTrace; startMs: number }>()
    let finalText = ''
    let tokenUsage: { input: number; output: number } = { input: 0, output: 0 }

    // Track raw byte count for maxBuffer enforcement before handing off to split2.
    child.stdout.on('data', (chunk: Buffer) => {
      totalSize += chunk.length
      if (totalSize > maxBuffer) {
        child.kill()
        if (!settled) {
          settled = true
          reject(new Error(`claude stream-json output exceeded ${maxBuffer} bytes (${label})`))
        }
      }
    })

    // Pipe stdout through split2(JSON.parse) to handle NDJSON line-buffering.
    const lines = child.stdout.pipe(split2(JSON.parse))

    lines.on('data', (msg: StreamMessage) => {
      processMessage(msg, toolCalls, pendingTools, onToolStart, onToolCall, (text) => {
        finalText = text
      }, (usage) => {
        tokenUsage = usage
      })
    })

    lines.on('error', (err: Error) => {
      // split2 emits an error when JSON.parse throws (malformed NDJSON line).
      // The stream continues after the error — observable as a skipped line.
      // We intentionally do not reject the promise here; the caller will
      // still resolve when the process exits cleanly.
      logger.info('claude stream-json parse error', { label, error: err.message })
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
    })

    const timer = setTimeout(() => {
      child.kill()
      if (!settled) {
        settled = true
        reject(new Error(`claude stream-json timed out after ${timeoutMs}ms (${label})`))
      }
    }, timeoutMs)

    child.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return

      if (code !== 0) {
        settled = true
        reject(new Error(`claude stream-json exited with code ${code} (${label})`))
        return
      }

      const elapsedMs = Date.now() - startTime
      const stderrText = Buffer.concat(stderrChunks).toString('utf8')

      logger.info('claude -p stream-json completed', { label, elapsedMs, toolCallCount: toolCalls.length })

      settled = true
      resolve({
        raw: finalText,
        elapsedMs,
        toolCalls,
        tokenUsage,
        stderr: stderrText,
      })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        reject(new Error(`claude stream-json failed (${label}): ${err.message}`, { cause: err }))
      }
    })

    child.stdin.write(prompt)
    child.stdin.end()
  })
}

// ── NDJSON Message Types ────────────────────────────────────────────────────

interface ContentBlockToolUse {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

interface ContentBlockToolResult {
  type: 'tool_result'
  tool_use_id: string
  content: string
}

interface ContentBlockText {
  type: 'text'
  text: string
}

type ContentBlock = ContentBlockToolUse | ContentBlockToolResult | ContentBlockText

/** External NDJSON boundary — optionals are legitimate here (we don't control the format). */
interface StreamMessage {
  type: 'assistant' | 'user' | 'result' | string
  message?: {
    content?: ContentBlock[]
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  result?: string
  session_id?: string
}

// ── Message Processor ───────────────────────────────────────────────────────

export function processMessage(
  msg: StreamMessage,
  toolCalls: ToolCallTrace[],
  pendingTools: Map<string, { trace: ToolCallTrace; startMs: number }>,
  onToolStart: (trace: ToolCallTrace) => void,
  onToolCall: (trace: ToolCallTrace) => void,
  setFinalText: (text: string) => void,
  setTokenUsage: (usage: { input: number; output: number }) => void,
): string | undefined {
  // Extract final text from result message
  if (msg.type === 'result') {
    if (typeof msg.result === 'string') {
      setFinalText(msg.result)
    } else if (msg.message?.content) {
      const textParts = msg.message.content
        .filter((b): b is ContentBlockText => b.type === 'text')
        .map((b) => b.text)
      if (textParts.length > 0) {
        setFinalText(textParts.join(''))
      }
    }

    // Extract token usage
    const usage = msg.message?.usage
    if (usage?.input_tokens !== undefined && usage?.output_tokens !== undefined) {
      setTokenUsage({ input: usage.input_tokens, output: usage.output_tokens })
    }
    return msg.session_id
  }

  // Process content blocks from assistant and user messages
  const content = msg.message?.content
  if (!content) return msg.session_id

  if (msg.type === 'assistant' || msg.type === 'user') {
    for (const block of content) {
      if (block.type === 'tool_use') {
        const trace: ToolCallTrace = {
          id: block.id,
          name: block.name,
          input: block.input,
          result: '',
          elapsedMs: 0,
        }
        pendingTools.set(block.id, { trace, startMs: Date.now() })
        toolCalls.push(trace)
        onToolStart(trace)
      }

      if (block.type === 'tool_result') {
        const pending = pendingTools.get(block.tool_use_id)
        if (pending) {
          pending.trace.result = block.content
          pending.trace.elapsedMs = Date.now() - pending.startMs
          pendingTools.delete(block.tool_use_id)
          onToolCall(pending.trace)
        }
      }
    }
  }

  return msg.session_id
}
