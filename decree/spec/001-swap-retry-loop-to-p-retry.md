---
status: approved
date: 2026-05-02
references:
- PRD-001
- ADR-0001
---

# SPEC-001 Swap Retry Loop to p-retry

## Overview

Replace the hand-rolled retry loop in `src/factory.ts` (`createLlmStep`) with [`p-retry`](https://npm.im/p-retry). The swap follows ADR-0001's bedrock + swap + lock-in pattern: characterization tests pinning current observable behavior, atomic swap with old code deletion, property-based lock-in tests preventing future drift.

Public API unchanged: `RetryConfig` shape, `onRetry` callback, parse-error retry semantics all preserved.

## Technical Design

### Bedrock — characterization tests

File: `src/__tests__/factory.retry.characterization.test.ts` (new).

Tests against the current (bespoke) implementation. Must pass on `main` *before* the swap commit:

| Test | What it pins |
|------|--------------|
| `attempts maxRetries+1 times when caller always fails` | Attempt count contract |
| `stops on first success` | Early-exit contract |
| `does not retry parse errors when retryOnParseError=false` | Parse-error abort path |
| `retries parse errors when retryOnParseError=true` | Parse-error retry path |
| `calls onRetry once per failed attempt with attempt number` | Callback invocation contract |
| `final error has shape { name: 'StepExecutionError', cause: ... }` | Error envelope contract |
| `delay grows roughly exponentially (band assertion)` | Backoff shape — band, not exact ms |

The delay test must use a band assertion (`expect(delay).toBeGreaterThanOrEqual(baseDelay * factor^n * 0.5)` style) rather than exact ms, so it survives `p-retry`'s jitter.

### Swap — production change

File: `src/factory.ts`.

Replace the inline `for` loop in `createLlmStep`'s execute with:

```ts
import pRetry, { AbortError } from 'p-retry'

const result = await pRetry(
  async () => {
    const llmResult = await caller(prompt, label)
    const parsed = parser(llmResult.raw)
    if (parsed.errors.length === 0) return { parsed, llmResult }
    if (!retryOnParseError) throw new AbortError(parsed.errors.join('; '))
    throw new ParseError(parsed.errors.join('; '))
  },
  {
    retries: maxRetries,
    factor: backoffMultiplier,
    minTimeout: baseDelayMs,
    onFailedAttempt: (err) => onRetry({ attempt: err.attemptNumber, error: err }),
  },
)
```

Delete the bespoke loop entirely in the same commit. All bedrock tests must still pass.

### Lock-in — property + snapshot tests

File: `src/__tests__/factory.retry.lockin.test.ts` (new).

Property tests via `fast-check`:

```ts
it('caller invoked between 1 and maxRetries+1 times across random failure patterns', async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 0, max: 5 }), // maxRetries
    fc.integer({ min: 0, max: 7 }), // failuresBeforeSuccess
    async (maxRetries, failuresBeforeSuccess) => {
      let attempts = 0
      const caller: LlmCaller = async () => {
        attempts++
        if (attempts <= failuresBeforeSuccess) throw new Error('fail')
        return { raw: 'ok', elapsedMs: 1, stderr: '' }
      }
      // ... build a step, execute, assert attempts ≤ maxRetries + 1
    },
  ))
})
```

Snapshot test: invoke `createLlmStep` with a fixed config, fail-then-succeed pattern, snapshot the resulting `StepResult` shape and the `onRetry` invocation log.

## Testing Strategy

- **Bedrock commit:** add the characterization tests; run `pnpm test` to confirm green on current code.
- **Swap commit:** add `p-retry` to dependencies (`pnpm add p-retry`), make the change, run `pnpm test` — bedrock tests pass.
- **Lock-in commit:** add `fast-check` to dev dependencies (`pnpm add -D fast-check`), add property + snapshot tests, run `pnpm test`.

After all three commits land, run the consumer regression check: in `jira-task-to-md`, `pnpm workflow feature-from-jira ATT-XXX` against a frozen baseline. Expect `git diff output/` to be empty (or show only documented behavior changes — e.g., timing fields if they're not normalized).

## Acceptance Criteria

### Commit 1 — Bedrock

- [ ] `src/__tests__/factory.retry.characterization.test.ts` exists with the seven tests listed above
- [ ] All seven tests pass against the current (bespoke) implementation
- [ ] No production code changed
- [ ] Commit message: `feat: characterization tests for retry loop`
- [ ] `pnpm build && pnpm test` green

### Commit 2 — Swap

- [ ] `p-retry` added to dependencies in `package.json`
- [ ] `pnpm-lock.yaml` regenerated
- [ ] Bespoke retry loop in `src/factory.ts` deleted
- [ ] Replaced with `pRetry()` call as designed above
- [ ] All bedrock tests still pass (or relaxed band assertions documented in commit message)
- [ ] Commit message: `refactor: swap retry loop → p-retry`
- [ ] `pnpm build && pnpm test` green

### Commit 3 — Lock-in

- [ ] `fast-check` added to devDependencies
- [ ] `src/__tests__/factory.retry.lockin.test.ts` exists with at least one property test and one snapshot test
- [ ] Commit message: `test: lock-in — property + snapshot tests for retry`
- [ ] `pnpm build && pnpm test` green

### Verification

- [ ] Lines removed from `src/factory.ts`: ≥ 40 (target ~50)
- [ ] No public-API change — `git diff src/types.ts src/index.ts` is empty (or only adds new exports)
- [ ] Consumer regression: in `jira-task-to-md`, baseline-vs-post-swap run produces zero meaningful diff
- [ ] `decree status SPEC-001 implement` once all boxes checked
