/**
 * Pipeline constants — no magic numbers.
 *
 * Every tunable has a named constant. If you need to change a default,
 * change it HERE, not in the code that references it.
 */

import type { RetryConfig } from './types.js'

// ── Default Retry ────────────────────────────────────────────────────────────

export const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 2,
  baseDelayMs: 1_000,
  backoffMultiplier: 2,
  retryOnParseError: true,
}

// ── Fixture Filenames ────────────────────────────────────────────────────────

export const FIXTURE_FILES = {
  prompt: 'prompt.txt',
  raw: 'raw.txt',
  actual: 'actual.json',
  meta: 'meta.json',
} as const

// ── Pipeline Output Files ────────────────────────────────────────────────────

export const MANIFEST_FILENAME = 'manifest.json'
export const AFTERMATH_FILENAME = 'llm-aftermath.md'

// ── Raw Output Truncation ────────────────────────────────────────────────────

/** Maximum length of raw LLM output saved to fixtures (chars). */
export const MAX_RAW_FIXTURE_LENGTH = 50_000

// ── Heartbeat ───────────────────────────────────────────────────────────────

/** Default heartbeat interval for step progress events (ms). 0 disables. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000

// ── Caller Defaults ─────────────────────────────────────────────────────────

/** Default timeout for a single LLM caller invocation (ms). */
export const DEFAULT_CALLER_TIMEOUT_MS = 180_000

/** Default maximum buffer for LLM caller response (bytes). 2 MB. */
export const DEFAULT_CALLER_MAX_BUFFER = 2 * 1024 * 1024

// ── Error Messages ──────────────────────────────────────────────────────────

/** Max chars of raw LLM output to include in error messages (e.g. ParseError snippet). */
export const ERROR_PREVIEW_LENGTH = 500
