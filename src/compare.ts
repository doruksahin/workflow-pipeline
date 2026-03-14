/**
 * Run comparison — diff two pipeline manifests.
 *
 * diffRuns()       — structured diff of step timings and statuses.
 * renderRunDiff()  — aligned text table for human consumption.
 */

import type { PipelineManifest, StepKind, StepStatus } from './types.js'

// ── Types ────────────────────────────────────────────────────────────────────

export interface StepDiff {
  step: string
  kind: StepKind
  statusBefore: StepStatus
  statusAfter: StepStatus
  elapsedMsBefore: number
  elapsedMsAfter: number
  deltaMs: number
  deltaPercent: number
}

export interface RunDiff {
  runIdBefore: string
  runIdAfter: string
  steps: StepDiff[]
  totalDeltaMs: number
}

// ── Diff ─────────────────────────────────────────────────────────────────────

export function diffRuns(before: PipelineManifest, after: PipelineManifest): RunDiff {
  const beforeMap = new Map(before.steps.map((s) => [s.name, s]))
  const afterMap = new Map(after.steps.map((s) => [s.name, s]))

  // Union of all step names, preserving order from `after` first, then any extras from `before`
  const allNames = new Set([...after.steps.map((s) => s.name), ...before.steps.map((s) => s.name)])

  const steps: StepDiff[] = []
  let totalBefore = 0
  let totalAfter = 0

  for (const name of allNames) {
    const b = beforeMap.get(name)
    const a = afterMap.get(name)

    const elapsedBefore = b?.elapsedMs ?? 0
    const elapsedAfter = a?.elapsedMs ?? 0
    const delta = elapsedAfter - elapsedBefore
    const deltaPercent = elapsedBefore > 0 ? (delta / elapsedBefore) * 100 : 0

    totalBefore += elapsedBefore
    totalAfter += elapsedAfter

    steps.push({
      step: name,
      kind: a?.kind ?? b?.kind ?? 'script',
      statusBefore: b?.status ?? 'skipped',
      statusAfter: a?.status ?? 'skipped',
      elapsedMsBefore: elapsedBefore,
      elapsedMsAfter: elapsedAfter,
      deltaMs: delta,
      deltaPercent,
    })
  }

  return {
    runIdBefore: before.runId,
    runIdAfter: after.runId,
    steps,
    totalDeltaMs: totalAfter - totalBefore,
  }
}

// ── Render ───────────────────────────────────────────────────────────────────

export function renderRunDiff(diff: RunDiff): string {
  const lines: string[] = []

  const header = 'Step'
  const colBefore = 'Before'
  const colAfter = 'After'
  const colDelta = 'Delta'

  // Compute column widths
  const nameWidth = Math.max(header.length, ...diff.steps.map((s) => s.step.length))
  const beforeWidth = Math.max(colBefore.length, ...diff.steps.map((s) => formatMs(s.elapsedMsBefore).length))
  const afterWidth = Math.max(colAfter.length, ...diff.steps.map((s) => formatMs(s.elapsedMsAfter).length))
  const deltaWidth = Math.max(colDelta.length, ...diff.steps.map((s) => formatDelta(s).length))

  // Header
  lines.push(
    `${pad(header, nameWidth)}  ${padL(colBefore, beforeWidth)}  ${padL(colAfter, afterWidth)}  ${padL(colDelta, deltaWidth)}`,
  )

  // Separator
  const sep = '\u2500'
  lines.push(sep.repeat(nameWidth + beforeWidth + afterWidth + deltaWidth + 6))

  // Rows
  for (const s of diff.steps) {
    lines.push(
      `${pad(s.step, nameWidth)}  ${padL(formatMs(s.elapsedMsBefore), beforeWidth)}  ${padL(formatMs(s.elapsedMsAfter), afterWidth)}  ${padL(formatDelta(s), deltaWidth)}`,
    )
  }

  // Total separator + row
  lines.push(sep.repeat(nameWidth + beforeWidth + afterWidth + deltaWidth + 6))

  const totalBefore = diff.steps.reduce((sum, s) => sum + s.elapsedMsBefore, 0)
  const totalAfter = diff.steps.reduce((sum, s) => sum + s.elapsedMsAfter, 0)
  const totalDelta = formatSignedMs(diff.totalDeltaMs)

  lines.push(
    `${pad('Total', nameWidth)}  ${padL(formatMs(totalBefore), beforeWidth)}  ${padL(formatMs(totalAfter), afterWidth)}  ${padL(totalDelta, deltaWidth)}`,
  )

  return lines.join('\n')
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

function formatSignedMs(ms: number): string {
  const sign = ms >= 0 ? '+' : ''
  return `${sign}${(ms / 1000).toFixed(1)}s`
}

function formatDelta(s: StepDiff): string {
  const signed = formatSignedMs(s.deltaMs)
  if (s.elapsedMsBefore === 0) return signed
  return `${signed} (${s.deltaPercent >= 0 ? '+' : ''}${Math.round(s.deltaPercent)}%)`
}

function pad(str: string, width: number): string {
  return str.padEnd(width)
}

function padL(str: string, width: number): string {
  return str.padStart(width)
}
