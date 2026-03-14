/**
 * Step-scoped fixture writing for pipeline runs.
 *
 * Handles automatic path construction, metadata, and raw output truncation.
 * Fixture I/O is inlined — no external dependency.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { FIXTURE_FILES, MAX_RAW_FIXTURE_LENGTH } from './constants.js'

// ── Fixture Artifacts ────────────────────────────────────────────────────────

export interface FixtureArtifacts {
  prompt?: string
  raw?: string
  actual?: unknown
}

export interface StepFixtureArtifacts extends FixtureArtifacts {
  meta?: {
    model: string
    durationMs: number
  }
}

// ── Inlined saveFixture (was fixture-io.ts) ──────────────────────────────────

function saveFixture(dir: string, artifacts: FixtureArtifacts): void {
  mkdirSync(dir, { recursive: true })

  if (artifacts.prompt !== undefined) {
    writeFileSync(resolve(dir, FIXTURE_FILES.prompt), artifacts.prompt, 'utf8')
  }

  if (artifacts.raw !== undefined) {
    writeFileSync(resolve(dir, FIXTURE_FILES.raw), artifacts.raw, 'utf8')
  }

  if (artifacts.actual !== undefined) {
    writeFileSync(resolve(dir, FIXTURE_FILES.actual), JSON.stringify(artifacts.actual, null, 2), 'utf8')
  }
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Write step-scoped fixtures to disk.
 *
 * Constructs path `{fixtureDir}/{runId}/{stepName}/`, saves artifacts,
 * and optionally saves meta.json. Truncates raw output to MAX_RAW_FIXTURE_LENGTH.
 *
 * @param fixtureDir — root fixture directory
 * @param runId — session run identifier
 * @param stepName — pipeline step name
 * @param artifacts — prompt, raw, actual, and optional meta
 * @returns absolute path to the step fixture directory
 */
export function writeStepFixture(
  fixtureDir: string,
  runId: string,
  stepName: string,
  artifacts: StepFixtureArtifacts,
): string {
  const stepPath = resolve(fixtureDir, runId, stepName)

  // Truncate raw output if needed
  const truncatedArtifacts: FixtureArtifacts = {
    prompt: artifacts.prompt,
    actual: artifacts.actual,
    raw:
      artifacts.raw && artifacts.raw.length > MAX_RAW_FIXTURE_LENGTH
        ? artifacts.raw.slice(0, MAX_RAW_FIXTURE_LENGTH)
        : artifacts.raw,
  }

  // Save artifacts
  saveFixture(stepPath, truncatedArtifacts)

  // Save meta.json if present
  if (artifacts.meta) {
    mkdirSync(stepPath, { recursive: true })
    writeFileSync(resolve(stepPath, FIXTURE_FILES.meta), JSON.stringify(artifacts.meta, null, 2), 'utf8')
  }

  return stepPath
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read step-scoped fixture actual.json and parse as type T.
 *
 * @param fixturePath — absolute path to step fixture directory (from writeStepFixture return)
 * @param validate — optional type guard. When provided, throws if data fails validation.
 * @returns parsed actual.json as type T
 * @throws Error with step context if actual.json not found or validation fails
 */
export function readStepFixture<T>(fixturePath: string, validate?: (data: unknown) => data is T): T {
  const actualPath = resolve(fixturePath, FIXTURE_FILES.actual)

  try {
    const content = readFileSync(actualPath, 'utf8')
    const data: unknown = JSON.parse(content)
    if (validate && !validate(data)) {
      throw new Error('Fixture validation failed')
    }
    return data as T
  } catch (err) {
    const stepContext = fixturePath.split('/').slice(-2).join('/')
    throw new Error(
      `Failed to read step fixture [${stepContext}]: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}
