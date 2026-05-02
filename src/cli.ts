/**
 * CLI helpers for emitting pipeline events as NDJSON to stdout.
 *
 * Usage in consumer:
 *   import { createNdjsonEmitter, createTracingCaller } from 'workflow-pipeline/cli'
 *   const emit = createNdjsonEmitter()
 *   const result = await pipeline.run(input, ctx, {
 *     onEvent: emit,
 *     heartbeatIntervalMs: 5_000,
 *     resumeFrom: null,
 *     pipelineLogger: SILENT_LOGGER,
 *   })
 */

import { writeSync } from 'node:fs'
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from './constants.js'
import type { ToolCallTrace } from './callers/claude-stream.js'
import type {
  PipelineEvent,
  PipelineRunOptions,
  PipelineLogger,
  ToolStartEvent,
  ToolDoneEvent,
  StepRetryEvent,
} from './types.js'
import { SILENT_LOGGER } from './types.js'

/**
 * Write a line directly to a file descriptor, bypassing Node.js stream buffering.
 * Falls back to stream.write() for non-fd streams (e.g. test doubles).
 */
function writeLine(stream: NodeJS.WritableStream, line: string): void {
  const fd = 'fd' in stream ? (stream as { fd: number }).fd : undefined
  if (fd !== undefined) {
    writeSync(fd, line)
  } else {
    stream.write(line)
  }
}

/**
 * Create an NDJSON event emitter that writes to a stream (defaults to stdout).
 * Uses synchronous fd writes to bypass Node.js stream buffering — events
 * reach pipe consumers (like the TUI) immediately, not batched.
 * Returns an onEvent callback for PipelineRunOptions.
 */
export function createNdjsonEmitter(stream: NodeJS.WritableStream = process.stdout): (event: PipelineEvent) => void {
  return (event: PipelineEvent) => {
    writeLine(stream, JSON.stringify(event) + '\n')
  }
}

/**
 * Create a PipelineLogger that emits NDJSON log entries.
 * Each line is { type: "log", level, msg, data, timestamp }.
 * Uses synchronous fd writes for immediate delivery.
 */
export function createNdjsonLogger(stream: NodeJS.WritableStream = process.stdout): PipelineLogger {
  const write = (level: string, msg: string, data: Record<string, unknown>) => {
    writeLine(stream, JSON.stringify({ type: 'log', level, msg, data, timestamp: Date.now() }) + '\n')
  }
  return {
    debug: (msg, data) => write('debug', msg, data),
    info: (msg, data) => write('info', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
  }
}

/**
 * Create a retry callback for LlmStepConfig that emits step:retry events.
 */
export function createRetryEmitter(
  emit: (event: PipelineEvent) => void,
  stepName: string,
): (attempt: number, maxAttempts: number, errors: string[], delayMs: number) => void {
  return (attempt, maxAttempts, errors, delayMs) => {
    const event: StepRetryEvent = {
      type: 'step:retry',
      step: stepName,
      attempt,
      maxAttempts,
      errors,
      delayMs,
      timestamp: Date.now(),
    }
    emit(event)
  }
}

/**
 * Create tool callbacks for StreamCallerOptions that emit tool:start and tool:done events.
 */
export function createToolEmitters(
  emit: (event: PipelineEvent) => void,
  stepName: string,
): { onToolStart: (trace: ToolCallTrace) => void; onToolCall: (trace: ToolCallTrace) => void } {
  return {
    onToolStart(trace) {
      const event: ToolStartEvent = {
        type: 'tool:start',
        step: stepName,
        toolId: trace.id,
        toolName: trace.name,
        inputSummary: summarizeToolInput(trace.input),
        timestamp: Date.now(),
      }
      emit(event)
    },
    onToolCall(trace) {
      const event: ToolDoneEvent = {
        type: 'tool:done',
        step: stepName,
        toolId: trace.id,
        toolName: trace.name,
        elapsedMs: trace.elapsedMs,
        outputSummary: truncate(trace.result, 200),
        isError: false,
        timestamp: Date.now(),
      }
      emit(event)
    },
  }
}

/**
 * Summarize tool input as "key=value, key=value" (truncated per value).
 */
function summarizeToolInput(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v)
      return `${k}=${truncate(s, 80)}`
    })
    .join(', ')
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen) + '…'
}

/**
 * Convenience helper that creates a complete PipelineRunOptions for NDJSON output.
 * Sets up event emitter, logger, heartbeat, and no resume.
 */
export function createNdjsonRunOptions(stream: NodeJS.WritableStream = process.stdout): PipelineRunOptions {
  return {
    onEvent: createNdjsonEmitter(stream),
    heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
    resumeFrom: null,
    pipelineLogger: createNdjsonLogger(stream),
  }
}
