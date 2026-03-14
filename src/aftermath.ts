/**
 * Pipeline aftermath — write and read llm-aftermath.md files for resume support.
 *
 * When a pipeline fails, the aftermath file captures:
 * - Which steps completed successfully
 * - Which step failed and why
 * - An optional resume command (configurable by consumer)
 *
 * On resume, parseAftermath() extracts this data for pipeline state recovery.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { AFTERMATH_FILENAME } from './constants.js'
import type { PipelineManifest } from './types.js'

// ── Data Types ────────────────────────────────────────────────────────────────

/**
 * Structured data extracted from aftermath markdown.
 * Used by pipeline runner to determine which steps were completed and which failed.
 */
export interface AftermathData {
  /** Pipeline run ID. */
  runId: string
  /** Human-readable pipeline name. */
  pipelineName: string
  /** List of step names that completed successfully. */
  completedSteps: string[]
  /** Step name that failed, or null if all steps completed. */
  failedStep: string | null
}

/**
 * Options for aftermath writing.
 */
export interface AftermathOptions {
  /** Optional callback to generate a resume command. Omits resume section if not provided. */
  resumeCommand?: (runId: string, fixtureDir: string) => string
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Write pipeline aftermath markdown file.
 *
 * Creates {fixtureDir}/{runId}/llm-aftermath.md with:
 * - Header: pipeline name, run ID, status
 * - Step table: name, kind, status, duration
 * - Error section (if failedStep is provided)
 * - Resume section (if resumeCommand callback is provided)
 *
 * @param fixtureDir Base fixture directory
 * @param runId Pipeline run identifier
 * @param manifest Pipeline execution manifest with all steps and timings
 * @param failedStep Name of step that failed, or null if all completed
 * @param errorMsg Error message from the failed step
 * @param options Optional configuration (resume command callback)
 * @returns Absolute path to the written aftermath file
 */
export function writeAftermath(
  fixtureDir: string,
  runId: string,
  manifest: PipelineManifest,
  failedStep: string | null,
  errorMsg: string,
  options?: AftermathOptions,
): string {
  const runDir = join(fixtureDir, runId)
  mkdirSync(runDir, { recursive: true })

  const filePath = join(runDir, AFTERMATH_FILENAME)

  // ── Header ──────────────────────────────────────────────────────────────────

  const lines: string[] = []

  lines.push(`# Pipeline Aftermath: ${manifest.pipelineName}`)
  lines.push('')
  lines.push(`**Run ID:** \`${manifest.runId}\``)
  lines.push(`**Status:** ${manifest.status === 'ok' ? '\u2713 Completed' : '\u2717 Aborted'}`)
  lines.push(`**Started:** ${manifest.startedAt}`)
  lines.push(`**Completed:** ${manifest.completedAt}`)
  lines.push('')

  // ── Step Table ──────────────────────────────────────────────────────────────

  lines.push('## Steps')
  lines.push('')
  lines.push('| Step | Kind | Status | Duration |')
  lines.push('|------|------|--------|----------|')

  for (const step of manifest.steps) {
    const statusIcon = step.status === 'ok' ? '\u2713' : step.status === 'error' ? '\u2717' : '\u2298'
    const durationStr = `${step.elapsedMs}ms`
    lines.push(`| ${step.name} | ${step.kind} | ${statusIcon} ${step.status} | ${durationStr} |`)
  }

  lines.push('')

  // ── Error Section ───────────────────────────────────────────────────────────

  if (failedStep !== null) {
    lines.push('## Error')
    lines.push('')
    lines.push(`**Step:** \`${failedStep}\``)
    lines.push('')
    lines.push('```')
    lines.push(errorMsg)
    lines.push('```')
    lines.push('')
  }

  // ── Resume Section (only if callback provided) ──────────────────────────────

  if (options?.resumeCommand) {
    const cmd = options.resumeCommand(runId, fixtureDir)
    lines.push('## Resume')
    lines.push('')
    lines.push('To resume this pipeline from the failure point:')
    lines.push('')
    lines.push('```bash')
    lines.push(cmd)
    lines.push('```')
    lines.push('')
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  const content = lines.join('\n')
  writeFileSync(filePath, content, 'utf-8')

  return filePath
}

// ── Read & Parse ──────────────────────────────────────────────────────────────

/**
 * Parse aftermath markdown file and extract structured data.
 *
 * Reads {filePath}, parses the step table to determine:
 * - which steps completed (status = ok)
 * - which step failed (status = error)
 *
 * @param filePath Absolute path to llm-aftermath.md
 * @returns Structured aftermath data for pipeline state recovery
 * @throws If file cannot be read or table format is invalid
 */
export function parseAftermath(filePath: string): AftermathData {
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')

  // ── Extract runId from header ───────────────────────────────────────────────

  const runIdMatch = content.match(/\*\*Run ID:\*\* `([^`]+)`/)
  if (!runIdMatch) {
    throw new Error(`Could not find Run ID in aftermath file: ${filePath}`)
  }
  const runId = runIdMatch[1]

  // ── Extract pipelineName from title ─────────────────────────────────────────

  const titleMatch = content.match(/^# Pipeline Aftermath: (.+)$/m)
  if (!titleMatch) {
    throw new Error(`Could not find pipeline name in aftermath file: ${filePath}`)
  }
  const pipelineName = titleMatch[1]

  // ── Parse step table ───────────────────────────────────────────────────────

  const completedSteps: string[] = []
  let failedStep: string | null = null

  const tableStart = lines.findIndex((line) => line.includes('| Step | Kind | Status | Duration |'))
  if (tableStart === -1) {
    throw new Error(`Could not find step table in aftermath file: ${filePath}`)
  }

  // Table format: | Step | Kind | Status | Duration |
  // Status column contains: checkmark ok, x error, or empty-set skipped
  for (let i = tableStart + 2; i < lines.length; i++) {
    const line = lines[i]

    // Stop at next section or empty line
    if (!line.startsWith('|') || line.includes('---')) {
      break
    }

    const parts = line.split('|').map((part) => part.trim())
    if (parts.length < 4) {
      continue
    }

    const stepName = parts[1]
    const statusCell = parts[3]

    // Status cell format: "checkmark ok", "x error", "empty-set skipped"
    if (statusCell.includes('\u2713')) {
      completedSteps.push(stepName)
    } else if (statusCell.includes('\u2717')) {
      failedStep = stepName
    }
    // skipped steps are neither completed nor failed — they never ran
  }

  return {
    runId,
    pipelineName,
    completedSteps,
    failedStep,
  }
}
