# No Magic Numbers

Every tunable value lives in `src/constants.ts` as a named export. No inline `5000`, no hardcoded `2 * 1024 * 1024` scattered across files.

## constants.ts

```typescript
// Retry defaults
export const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 2,
  baseDelayMs: 1_000,
  backoffMultiplier: 2,
  retryOnParseError: true,
}

// Fixture filenames
export const FIXTURE_FILES = {
  prompt: 'prompt.txt',
  raw: 'raw.txt',
  actual: 'actual.json',
  meta: 'meta.json',
} as const

// Pipeline output files
export const MANIFEST_FILENAME = 'manifest.json'
export const AFTERMATH_FILENAME = 'llm-aftermath.md'

// Raw output limits
export const MAX_RAW_FIXTURE_LENGTH = 50_000   // chars
export const ERROR_PREVIEW_LENGTH = 500        // chars

// Heartbeat
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000

// Caller defaults
export const DEFAULT_CALLER_TIMEOUT_MS = 180_000          // ms
export const DEFAULT_CALLER_MAX_BUFFER = 2 * 1024 * 1024  // bytes (2 MB)
```

Caller option defaults are bundled in the caller files themselves:

```typescript
// callers/claude-cli.ts
export const DEFAULT_CLAUDE_CALLER_OPTIONS: ClaudeCallerOptions = {
  timeoutMs: DEFAULT_CALLER_TIMEOUT_MS,
  maxBuffer: DEFAULT_CALLER_MAX_BUFFER,
  logger: SILENT_LOGGER,
}

// callers/claude-stream.ts
export const DEFAULT_STREAM_CALLER_OPTIONS: StreamCallerOptions = {
  timeoutMs: DEFAULT_CALLER_TIMEOUT_MS,
  maxBuffer: DEFAULT_CALLER_MAX_BUFFER,
  logger: SILENT_LOGGER,
  onToolCall() {},
}
```

## Rules

1. **If it's a number, it's a constant.** Timeouts, buffer sizes, retry counts, interval durations — all named.

2. **Caller defaults are framework tunables too.** `DEFAULT_CALLER_TIMEOUT_MS` and `DEFAULT_CALLER_MAX_BUFFER` live in `constants.ts`. Both callers import them — no duplication.

3. **Consumers override via config, not by editing constants.** `DEFAULT_RETRY` is the starting point. Consumers pass their own `RetryConfig`. `DEFAULT_HEARTBEAT_INTERVAL_MS` is the fallback. Consumers pass `heartbeatIntervalMs: 0` to disable.

4. **String constants too.** Filenames like `manifest.json` and `llm-aftermath.md` are constants. If a consumer needs to find these files, they import `MANIFEST_FILENAME` — no hardcoded strings.
