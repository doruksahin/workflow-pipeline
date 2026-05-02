# Wheel Audit — Detailed Analysis

Per-module evaluation of swap candidates.

## 1. Retry with exponential backoff

**Where:** `factory.ts` → `createLlmStep` retry loop.

**Current:** Hand-rolled `for` loop reading `retry: { maxRetries, baseDelayMs, backoffMultiplier, retryOnParseError }` and computing delays inline. Calls `onRetry` callback on each failed attempt.

**Library:** [`p-retry`](https://npm.im/p-retry) — 50M weekly downloads, single-purpose, zero deps beyond `retry`.

**Swap shape:**

```ts
import pRetry, { AbortError } from 'p-retry'

await pRetry(
  async () => {
    const raw = await caller(prompt, label)
    const parsed = parser(raw)
    if (parsed.errors.length === 0) return parsed.result
    if (!retryOnParseError) throw new AbortError(parsed.errors.join('; '))
    throw new ParseError(parsed.errors.join('; '))
  },
  {
    retries: maxRetries,
    factor: backoffMultiplier,
    minTimeout: baseDelayMs,
    onFailedAttempt: onRetry,
  },
)
```

**Keep:** `RetryConfig` type, `onRetry` callback shape, parse-error retry semantics (`AbortError` vs throw).

**Lose:** Nothing. `p-retry` handles backoff math, jitter, and abort-on-error better than the inline loop.

**Diff estimate:** ~50 lines removed from `factory.ts`.

## 2. Subprocess spawn for `claude -p`

**Where:** `callers/claude-cli.ts`.

**Current:** Manual `child_process.spawn`, stdout/stderr accumulation via `data` events, manual timeout via `setTimeout` + `kill('SIGTERM')`, exit-code branch.

**Library:** [`execa`](https://npm.im/execa) — Sindre Sorhus's wrapper. Industry standard. Used by Vite, ava, lerna, etc.

**Swap shape:**

```ts
import { execa } from 'execa'

const { stdout, stderr, exitCode, durationMs } = await execa('claude', ['-p', prompt], {
  timeout: timeoutMs,
  maxBuffer: maxBufferBytes,
  reject: false,
})
```

**Keep:** `LlmCaller` interface, custom envelope parsing (Claude's specific JSON output shape).

**Lose:** Nothing. `execa` cancels with the right signals, handles encoding edge cases, and reports `timedOut`/`killed` flags.

**Diff estimate:** ~40 lines removed from `claude-cli.ts`.

## 3. NDJSON streaming

**Where:** `callers/claude-stream.ts`.

**Current:** Manual line-buffering on the readable stream — accumulate chunks into a buffer, split on `\n`, `JSON.parse` each line, handle partial trailing lines.

**Library:** [`split2`](https://npm.im/split2) (15M weekly) — split a stream by newlines with optional per-line transform. Or [`ndjson`](https://npm.im/ndjson) (35K weekly, more featured).

**Swap shape (split2):**

```ts
import split2 from 'split2'

stream
  .pipe(split2(JSON.parse))
  .on('data', (msg) => {
    /* msg is already parsed */
  })
  .on('error', (err) => {
    /* malformed line */
  })
```

**Keep:** Tool-call tracing logic, custom event emission.

**Lose:** Nothing.

**Diff estimate:** ~30 lines removed from `claude-stream.ts`.

## What stays bespoke (and why)

### `PipelineBuilder` chained types

The `.step(s1).step(s2)` inference where each step's output type becomes the next step's input type is not a commodity. [Effect TS](https://effect.website) has similar machinery but adopting Effect is a far bigger commitment than the wheels we're trying to remove. Keep.

### `createLlmStep` / `createScriptStep`

Domain-specific factories. Their value is the *shape* of `Step<TInput, TOutput>` — that LLM steps split into prompt assembly, calling, and parsing as separate concerns. No library has this exact shape because it's tied to our retry-on-parse-error and fixture-format choices.

### Fixture writer / aftermath / run diff

Filesystem-native LLM batch reproducibility is the package's reason for existing. Replacing fixture-writer with a generic storage layer would be replacing the product, not implementing it. The filesystem IS the database here — that choice is load-bearing for the consumer's product flow (see consumer's `docs/orchestrator-evaluation/` for the cost of changing it).

### `parallel()`

Trivial wrapper over `Promise.all` with type plumbing. Adding a dep here is net negative.

## Implementation order (if executing)

1. `p-retry` — smallest blast radius, most isolated change
2. `execa` — touches one file, easy to verify against existing tests
3. `split2` — touches one file, mostly mechanical

Each swap should be its own commit. Run `pnpm test` after each — tests cover the affected callers and factories.

## Out of scope for this audit

- Replacing `vitest` with another runner (it's already the right choice)
- Adopting Effect TS or fp-ts (would invert the project, not refactor it)
- Replacing tsc with another bundler (zero gain, lots of risk)
