# Throw, Don't Silence

Errors propagate. No fallbacks, no `|| []`, no `?? {}` on internal data. When something fails, the caller knows immediately.

## Two Rules

1. **No fallbacks on internal data.** If a step expects `FileSet`, it gets `FileSet`. No defensive `input.files ?? []` — that hides upstream bugs.

2. **Throw at system boundaries, return errors internally.** Steps return `StepResult` (which can be `StepError`). The runner checks `.status` and aborts the pipeline. But at true system boundaries (file I/O, LLM calls, JSON parse), throw — the factory catches and wraps.

## Error Hierarchy

```
StepExecutionError      — step failed (wraps cause with step context)
├── ParallelBranchError — multiple branches failed (carries per-branch Map)
ParseError              — LLM output didn't match schema (carries raw snippet)
PipelineAbortedError    — unrecoverable pipeline failure (carries manifest)
```

Every error carries **what** (message), **where** (step name), and **why** (cause/snippet). Debuggable from the message alone.

## Safe Error Stringify

Never use `(err as Error).message` — it loses type, stack, and cause. Always use:

```typescript
err instanceof Error ? err.message : String(err)
```

And preserve the original error as `cause`:

```typescript
throw new Error(`Failed to read fixture: ${err instanceof Error ? err.message : String(err)}`, {
  cause: err,
})
```

## How Errors Flow

```
LLM call throws          → factory catches → returns StepError
Parse returns errors      → factory retries or returns StepError
Script transform throws   → factory catches → returns StepError
Step throws unexpectedly  → runner catches → returns StepError with context
Step returns StepError    → runner marks step 'error', skips remaining, writes aftermath
Parallel branch fails     → parallel() collects ALL branch errors, returns StepError
```

### Factory: Catch and Wrap

```typescript
// In createLlmStep — LLM call failure
try {
  const result = await caller(prompt, label)
  raw = result.raw
} catch (err) {
  return {
    status: 'error',
    error: err instanceof Error ? err.message : String(err),
    elapsedMs: Date.now() - startMs,
    retries: attempt - 1,
  }
}

// In createScriptStep — transform failure
try {
  const output = await transform(input, ctx)
  return { status: 'ok', output, elapsedMs: ..., meta: { ... } }
} catch (err) {
  return {
    status: 'error',
    error: err instanceof Error ? err.message : String(err),
    elapsedMs: ...,
    retries: 0,
  }
}
```

### Runner: Catch Unexpected Throws

Steps should return `StepError`, but if a step throws (bug in step code), the runner catches it:

```typescript
let result: StepResult<unknown>
try {
  result = await step.execute(current, ctx)
} catch (err) {
  if (hbTimer) clearInterval(hbTimer)
  result = {
    status: 'error',
    error: `Step "${step.name}" threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
    elapsedMs: Date.now() - stepStart,
    retries: 0,
  }
}
```

### Runner: Check and Abort

```typescript
if (result.status === 'error') {
  // Mark remaining steps as 'skipped'
  // Write aftermath + manifest
  // Emit pipeline:done event with status 'aborted'
  return { status: 'aborted', manifest, elapsedMs }
}
```

### Parallel: Collect All

```typescript
// Collects every branch error into Map<string, Error>
const branchErrors = new Map<string, Error>()
// Uses entries index for identity (not '(unknown)')
// Error message includes ALL branches:
// "2 parallel branch(es) failed: classify: timeout; map: parse failed"
```

## Fixture Write Protection

Fixture writes (prompt, raw, actual, meta, manifest, aftermath) are **non-fatal**. A failing filesystem should not crash a pipeline that was otherwise succeeding.

```typescript
// Factory: protected fixture writes
if (ctx.saveFixtures) {
  try {
    writeStepFixture(ctx.fixtureDir, ctx.runId, name, { prompt })
  } catch {
    // Non-fatal — step execution continues
  }
}

// Runner: protected fixture writes
if (ctx.saveFixtures) {
  try {
    writeAftermath(...)
    writeManifest(...)
  } catch (fixtureErr) {
    log.error('Failed to write fixtures', {
      error: fixtureErr instanceof Error ? fixtureErr.message : String(fixtureErr),
    })
  }
}
```

## No Required Fields Left Behind

`StepError` has no optional fields:

```typescript
interface StepError {
  status: 'error'
  error: string      // always present
  elapsedMs: number  // always present
  retries: number    // 0 for non-retryable failures
}
```

`StepManifestEntry` has no optional fields:

```typescript
interface StepManifestEntry {
  name: string
  kind: StepKind
  status: StepStatus
  elapsedMs: number
  retries: number   // 0 for successful or non-retryable steps
  error: string     // '' for successful steps
}
```

## What This Means for Consumers

- If a step can fail, it will tell you via `StepResult`. Check `.status`.
- If a pipeline aborts, the manifest tells you which step failed and which were skipped.
- Never catch and ignore errors from `pipeline.run()` — the aftermath file is your recovery path.
- All fields are always present — no `?.` chains needed when inspecting results.
