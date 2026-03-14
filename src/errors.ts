/**
 * Pipeline error hierarchy.
 *
 * Every error carries what/where/why — debuggable from the message alone.
 * No generic Error throws. Always one of these.
 */

import { ERROR_PREVIEW_LENGTH } from './constants.js'
import type { PipelineManifest } from './types.js'

// ── Step Execution Error ─────────────────────────────────────────────────────

/**
 * A step failed during execution (LLM call failure, timeout, etc.).
 * Wraps the original error with step context.
 */
export class StepExecutionError extends Error {
  readonly stepName: string
  declare readonly cause: Error
  readonly elapsedMs: number
  readonly retries: number

  constructor(stepName: string, message: string, cause: Error, elapsedMs: number, retries: number) {
    super(`[${stepName}] ${message}`, { cause })
    this.name = 'StepExecutionError'
    this.stepName = stepName
    this.elapsedMs = elapsedMs
    this.retries = retries
  }
}

// ── Parse Error ──────────────────────────────────────────────────────────────

/**
 * LLM output did not match the expected schema.
 * Carries the raw response snippet and individual validation errors.
 */
export class ParseError extends Error {
  readonly stepName: string
  readonly errors: string[]
  readonly rawSnippet: string

  constructor(stepName: string, errors: string[], rawOutput: string) {
    const summary = errors.length === 1 ? errors[0] : `${errors.length} validation errors`
    super(`[${stepName}] Parse failed: ${summary}`)
    this.name = 'ParseError'
    this.stepName = stepName
    this.errors = errors
    this.rawSnippet =
      rawOutput.length > ERROR_PREVIEW_LENGTH ? rawOutput.slice(0, ERROR_PREVIEW_LENGTH) + '...' : rawOutput
  }
}

// ── Pipeline Aborted Error ───────────────────────────────────────────────────

/**
 * Unrecoverable pipeline failure.
 * Carries the full manifest for aftermath/resume support.
 */
export class PipelineAbortedError extends Error {
  readonly failedStep: string
  readonly manifest: PipelineManifest

  constructor(failedStep: string, message: string, manifest: PipelineManifest) {
    super(`Pipeline aborted at step "${failedStep}": ${message}`)
    this.name = 'PipelineAbortedError'
    this.failedStep = failedStep
    this.manifest = manifest
  }
}

// ── Parallel Branch Error ───────────────────────────────────────────────────

/**
 * Multiple branches failed in a parallel step.
 * Carries per-branch errors for structured inspection.
 */
export class ParallelBranchError extends StepExecutionError {
  readonly branchErrors: ReadonlyMap<string, Error>

  constructor(stepName: string, branchErrors: Map<string, Error>) {
    const summary = [...branchErrors.entries()]
      .map(([branch, err]) => `  ${branch}: ${err.message}`)
      .join('\n')
    super(
      stepName,
      `${branchErrors.size} branch(es) failed:\n${summary}`,
      new AggregateError([...branchErrors.values()], `${branchErrors.size} parallel branch(es) failed`),
      0,
      0,
    )
    this.name = 'ParallelBranchError'
    this.branchErrors = branchErrors
  }
}
