/**
 * Claude Agent SDK caller — wraps `query()` as an LlmCaller.
 *
 * Provides typed permission modes, tool restriction, canUseTool filtering,
 * real-time streaming via step:output-line events, and per-session JSONL recording.
 *
 * This is the only file in step-pipeline that touches the SDK API.
 * If Anthropic changes the SDK, only this file needs updating.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { CanUseTool, PermissionMode, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { query } from '@anthropic-ai/claude-agent-sdk'

import type { LlmCaller, LlmCallerResult, PipelineContext, PipelineLogger } from '../types.js'
import { SILENT_LOGGER } from '../types.js'

// ── Types ────────────────────────────────────────────────────────────────────

export type { CanUseTool, PermissionMode }

export interface SdkCallerOptions {
  /** Working directory for the SDK session. */
  cwd: string
  /** Built-in tool names the session may use (e.g. ['Read', 'Grep', 'Glob']). */
  allowedTools?: string[]
  /** Permission mode — controls auto-approval of file edits and other operations. */
  permissionMode?: PermissionMode
  /** Maximum conversation turns before the SDK halts. */
  maxTurns?: number
  /** Custom system prompt override. */
  systemPrompt?: string
  /** Per-tool permission handler. Use bashAllowlist() for command filtering. */
  canUseTool?: CanUseTool
  /**
   * Directory for session JSONL files. One file per label:
   *   {sessionDir}/{label}/session.jsonl
   * Omit to skip recording.
   */
  sessionDir?: string
  /** Structured logger for caller lifecycle events. */
  logger?: PipelineLogger
}

/** One line in the JSONL session recording. */
export interface SessionRecord {
  timestamp: string
  type: string
  message: unknown
}

// ── bashAllowlist ─────────────────────────────────────────────────────────────

/**
 * Build a CanUseTool handler that allows all tools except Bash,
 * and for Bash only allows commands that start with one of the `allowed` prefixes.
 *
 * @example
 *   canUseTool: bashAllowlist(['npx tsc', 'npx vitest', 'npx eslint'])
 */
export function bashAllowlist(allowed: string[]): CanUseTool {
  return async (tool, input) => {
    if (tool !== 'Bash') return { behavior: 'allow', updatedInput: input }
    const cmd = (input as { command: string }).command
    const permitted = allowed.some((a) => cmd.startsWith(a) || cmd.includes(`npx ${a}`))
    if (permitted) return { behavior: 'allow', updatedInput: input }
    return { behavior: 'deny', message: `Blocked by bashAllowlist: ${cmd}` }
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create an LlmCaller backed by the Claude Agent SDK's `query()`.
 *
 * The returned caller:
 * - Streams SDK messages and emits step:output-line events to ctx.onEvent
 * - Records the full session as JSONL if sessionDir is set
 * - Returns { raw, elapsedMs, stderr } matching LlmCallerResult
 *
 * @example
 *   const caller = createSdkCaller({
 *     cwd: worktreePath,
 *     allowedTools: ['Read', 'Grep', 'Glob'],
 *     permissionMode: 'acceptEdits',
 *     maxTurns: 10,
 *   })
 */
export function createSdkCaller(opts: SdkCallerOptions): LlmCaller {
  return (prompt: string, label: string, ctx?: PipelineContext) =>
    callViaSdk(prompt, label, opts, ctx)
}

// ── Core call ────────────────────────────────────────────────────────────────

async function callViaSdk(
  prompt: string,
  label: string,
  opts: SdkCallerOptions,
  ctx?: PipelineContext,
): Promise<LlmCallerResult> {
  const {
    cwd,
    allowedTools,
    permissionMode,
    maxTurns,
    systemPrompt,
    canUseTool,
    sessionDir,
    logger = SILENT_LOGGER,
  } = opts

  const startMs = Date.now()
  logger.info('SDK caller: starting', { label, cwd, permissionMode, maxTurns })

  // Set up JSONL recording file if requested
  let sessionFile: string | null = null
  if (sessionDir) {
    const dir = join(sessionDir, label)
    mkdirSync(dir, { recursive: true })
    sessionFile = join(dir, 'session.jsonl')
    appendRecord(sessionFile, 'prompt', { prompt })
  }

  let raw = ''
  const stderrLines: string[] = []

  for await (const msg of query({
    prompt,
    options: {
      cwd,
      allowedTools,
      permissionMode,
      maxTurns,
      systemPrompt,
      canUseTool,
      // Isolate from project settings so the caller is deterministic
      settingSources: [],
    },
  })) {
    // Record every message to JSONL
    if (sessionFile) {
      appendRecord(sessionFile, msg.type, msg)
    }

    // Emit streaming line event for dashboard / runner visibility
    if (ctx?.onEvent && ctx?.currentStep) {
      ctx.onEvent({
        type: 'step:output-line',
        step: ctx.currentStep,
        line: JSON.stringify(msg),
        timestamp: Date.now(),
      })
    }

    // Extract final result text — discriminated union narrowing on type + subtype
    if (msg.type === 'result') {
      if (msg.subtype === 'success') {
        raw = msg.result
      } else {
        stderrLines.push(...msg.errors)
      }
    }
  }

  const elapsedMs = Date.now() - startMs
  logger.info('SDK caller: done', { label, elapsedMs, rawLength: raw.length })

  return {
    raw,
    elapsedMs,
    stderr: stderrLines.join('\n'),
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function appendRecord(file: string, type: string, message: unknown): void {
  const record: SessionRecord = {
    timestamp: new Date().toISOString(),
    type,
    message,
  }
  appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
}
