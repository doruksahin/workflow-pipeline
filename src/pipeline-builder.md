# PipelineBuilder

Type-safe engine for composing LLM + script steps into sequential workflows with fixture persistence, retry, and failure recovery.

> **Design principles:** See [docs/foundations/](../docs/foundations/index.md) for the rules that govern this codebase — structured I/O, error handling, type authority, SRP, reproducibility, observability, and constants.

## Core Concepts

**Step** — a unit of work: `execute(input, ctx) => Promise<StepResult<TOutput>>`. Two factories create steps:

- `createScriptStep()` — pure transform (sync or async)
- `createLlmStep()` — prompt assembly -> LLM call -> output parsing, with built-in retry

**PipelineBuilder** — chains steps. TypeScript enforces each step's input matches the previous step's output. Call `.build(name)` to get a runnable `Pipeline`.

**PipelineContext** — shared state passed to every step: `runId`, `fixtureDir`, `saveFixtures`, `logger`.

## Creating Steps

### Script Step

```typescript
import { createScriptStep } from 'step-pipeline'

const collectFiles = createScriptStep<string, FileSet>({
  name: 'collect-files',
  description: 'Gather .tsx files from target directory',
  transform(targetDir) {
    const files = glob(targetDir, '**/*.tsx')
    if (files.length === 0) throw new Error(`No .tsx files in ${targetDir}`)
    return { targetDir, files }
  },
})
```

`transform` receives `(input, ctx)`. Throw to fail the step. Return value becomes the next step's input.

### LLM Step

```typescript
import { createLlmStep, DEFAULT_RETRY } from 'step-pipeline'
import { createClaudeCaller, DEFAULT_CLAUDE_CALLER_OPTIONS } from 'step-pipeline/callers/claude-cli'

const classifyStep = createLlmStep<FileSet, ClassifyOutput>({
  name: 'classify',
  description: 'Classify elements into UI primitives',
  model: 'sonnet',
  retry: DEFAULT_RETRY,
  caller: createClaudeCaller(DEFAULT_CLAUDE_CALLER_OPTIONS),
  label: 'classify',

  promptAssembler(input) {
    return `Classify these files:\n${input.files.join('\n')}`
  },

  parser(raw) {
    const parsed = JSON.parse(raw)
    const errors: string[] = []
    if (!Array.isArray(parsed.elements)) errors.push('Missing elements array')
    return { result: parsed, errors }
  },

  onRetry(attempt, maxAttempts, errors, delayMs) {
    console.log(`Attempt ${attempt}/${maxAttempts} failed, retrying in ${delayMs}ms`)
  },
})
```

All `LlmStepConfig` fields are required — no hidden defaults. Pass `() => {}` for `onRetry` if you don't need retry logging.

#### LLM Caller

`caller` is an injectable function: `(prompt: string, label: string) => Promise<LlmCallerResult>` where `LlmCallerResult` is `{ raw: string; elapsedMs: number; stderr: string }`.

The package ships two callers for `claude -p`:

```typescript
// Standard — captures JSON envelope
import { createClaudeCaller, DEFAULT_CLAUDE_CALLER_OPTIONS } from 'step-pipeline/callers/claude-cli'
const caller = createClaudeCaller(DEFAULT_CLAUDE_CALLER_OPTIONS)
const caller = createClaudeCaller({ ...DEFAULT_CLAUDE_CALLER_OPTIONS, timeoutMs: 300_000 })

// Stream — parses NDJSON, traces tool calls
import { createClaudeStreamCaller, DEFAULT_STREAM_CALLER_OPTIONS } from 'step-pipeline/callers/claude-stream'
const caller = createClaudeStreamCaller({
  ...DEFAULT_STREAM_CALLER_OPTIONS,
  onToolCall(trace) { console.log(`Tool: ${trace.name}`) },
})
```

You can provide any function that matches the `LlmCaller` signature — OpenAI, HTTP endpoint, mock for testing, etc.

#### Retry

```typescript
import { DEFAULT_RETRY } from 'step-pipeline'
// { maxRetries: 2, baseDelayMs: 1000, backoffMultiplier: 2, retryOnParseError: true }

// Or custom:
const retry = { maxRetries: 3, baseDelayMs: 500, backoffMultiplier: 1.5, retryOnParseError: true }
```

LLM call failures (timeout, crash) are **not** retried — only parse errors are.

## Composing a Pipeline

```typescript
import { PipelineBuilder } from 'step-pipeline'

const pipeline = new PipelineBuilder<string>()   // <-- pipeline input type
  .step(collectFiles)     // string -> FileSet
  .step(classifyStep)     // FileSet -> ClassifyOutput
  .step(mapStep)          // ClassifyOutput -> MapOutput
  .build('classify-and-map')
```

Type errors at `.step()` mean the step's input doesn't match the previous step's output.

### Running

`Pipeline.run()` requires three arguments: input, context, and options.

```typescript
import { SILENT_LOGGER } from 'step-pipeline'
import type { PipelineContext, PipelineRunOptions } from 'step-pipeline'

const ctx: PipelineContext = {
  runId: 'my-run-001',
  fixtureDir: '/path/to/fixtures',
  saveFixtures: true,
  logger: myLogger,
}

const options: PipelineRunOptions = {
  onEvent(event) {
    if (event.type === 'step:start') console.log(`[${event.index + 1}/${event.total}] ${event.step}`)
  },
  heartbeatIntervalMs: 5_000,  // 0 disables
  resumeFrom: null,            // null = start from beginning
  pipelineLogger: SILENT_LOGGER,
}

const result = await pipeline.run('/path/to/target', ctx, options)

if (result.status === 'ok') {
  console.log(result.output)    // MapOutput
  console.log(result.manifest)  // step timings, statuses
} else {
  console.log(result.manifest)  // includes which step failed
}
```

All `PipelineRunOptions` fields are required — no hidden defaults. Use `SILENT_LOGGER` for no logging, `() => {}` for no events, `null` for no resume, `0` for no heartbeat.

See [docs/foundations/observability.md](../docs/foundations/observability.md) for full event and logger documentation.

### Parallel Steps

```typescript
import { parallel } from 'step-pipeline'

// Run multiple steps concurrently from the same input
const bothSteps = parallel('classify-both', {
  fast: classifyFastStep,   // Input -> FastOutput
  deep: classifyDeepStep,   // Input -> DeepOutput
})
// Result: { fast: FastOutput, deep: DeepOutput }

const pipeline = new PipelineBuilder<Input>()
  .step(bothSteps)
  .step(mergeStep)  // { fast, deep } -> MergedOutput
  .build('parallel-pipeline')
```

Fails if any branch fails. Collects ALL branch errors (not just the first).

## Fixtures

When `saveFixtures: true`, each step writes to `{fixtureDir}/{runId}/{stepName}/`:

| File | Written by | Content |
|------|-----------|---------|
| `prompt.txt` | LLM steps | Assembled prompt |
| `raw.txt` | LLM steps | Raw LLM response |
| `actual.json` | Both | Parsed/transformed output |
| `meta.json` | LLM steps | Model, duration |
| `manifest.json` | Runner | Full pipeline manifest (at run level) |
| `llm-aftermath.md` | Runner | Run report (success and abort) |

Fixture writes are protected — if a write fails, the step/pipeline continues. The error is logged via `pipelineLogger` but never crashes the pipeline.

Read fixtures back:

```typescript
import { readStepFixture } from 'step-pipeline'

// Without validation (existing behavior)
const output = readStepFixture<ClassifyOutput>('/fixtures/run-001/classify')

// With runtime type guard (opt-in safety)
const output = readStepFixture<ClassifyOutput>('/fixtures/run-001/classify', isClassifyOutput)
```

### Comparing Runs

```typescript
import { diffRuns, renderRunDiff } from 'step-pipeline'

const diff = diffRuns(previousManifest, currentManifest)
console.log(renderRunDiff(diff))
// Step            Before    After     Delta
// ─────────────────────────────────────────
// classify         12.3s     8.1s    -4.2s (-34%)
// map-to-library   15.0s    14.8s    -0.2s (-1%)
// ─────────────────────────────────────────
// Total            27.3s    22.9s    -4.4s
```

## Closure Pattern for Dynamic Config

When a step needs runtime config (like a target directory), use a factory function:

```typescript
function buildRewriteStep(targetDir: string): Step<MapOutput, RewriteOutput> {
  return createLlmStep<MapOutput, RewriteOutput>({
    name: 'rewrite',
    description: 'Rewrite files to use library components',
    model: 'opus',
    retry: DEFAULT_RETRY,
    caller: createClaudeCaller(DEFAULT_CLAUDE_CALLER_OPTIONS),
    label: 'rewrite',
    onRetry() {},
    promptAssembler(input) {
      const content = readFileSync(resolve(targetDir, input.file), 'utf8')
      return `Rewrite this:\n${content}`
    },
    parser: parseRewriteOutput,
  })
}

// Usage:
const pipeline = new PipelineBuilder<MapOutput>()
  .step(buildRewriteStep('/path/to/target'))
  .build('rewrite-pipeline')
```

## Error Hierarchy

```
StepExecutionError       — step failed during execution (wraps cause)
├── ParallelBranchError  — multiple parallel branches failed (carries per-branch Map)
ParseError               — LLM output didn't match schema (carries raw snippet)
PipelineAbortedError     — unrecoverable failure (carries full manifest)
```

## Step Result

Every step returns `StepResult<T>` — a discriminated union:

```typescript
// Success — all fields required
interface StepOk<T> {
  status: 'ok'
  output: T
  elapsedMs: number
  meta: StepMeta  // { model, attempts, promptLength, rawLength }
}

// Failure — all fields required
interface StepError {
  status: 'error'
  error: string
  elapsedMs: number
  retries: number
}
```

No optional fields. Script steps use `meta: { model: 'script', attempts: 1, promptLength: 0, rawLength: 0 }`.

## Full API

```typescript
// Types
Step, PipelineContext, PipelineResult, StepResult, StepOk, StepError,
ParallelStepError, StepMeta, LlmStepConfig, ScriptStepConfig,
LlmCaller, LlmCallerResult, RetryConfig, ParseResult, Confidence,
PipelineManifest, StepManifestEntry, Pipeline, ParallelSteps,
StepOutputType, StepKind, StepStatus, FixtureValidator,
PipelineEvent, PipelineStartEvent, PipelineDoneEvent,
StepStartEvent, StepDoneEvent, StepHeartbeatEvent,
PipelineRunOptions, PipelineLogger

// Runtime values
VALID_CONFIDENCE, SILENT_LOGGER, DEFAULT_RETRY, FIXTURE_FILES,
ERROR_PREVIEW_LENGTH, DEFAULT_HEARTBEAT_INTERVAL_MS,
MANIFEST_FILENAME, AFTERMATH_FILENAME, MAX_RAW_FIXTURE_LENGTH

// Factories
createLlmStep(config)       → Step (kind: 'llm')
createScriptStep(config)    → Step (kind: 'script')

// Runner
PipelineBuilder<TFirst>     .step(s).build(name) → Pipeline
parallel(name, steps)       → Step (kind: 'parallel', concurrent execution)

// Fixtures
writeStepFixture(dir, runId, step, artifacts) → path
readStepFixture<T>(path, validate?) → T

// Aftermath
writeAftermath(dir, runId, manifest, failedStep, error, options?) → path
parseAftermath(path) → AftermathData

// Compare
diffRuns(before, after) → RunDiff
renderRunDiff(diff) → string

// Errors
StepExecutionError, ParallelBranchError, ParseError, PipelineAbortedError

// Callers (step-pipeline/callers/claude-cli)
createClaudeCaller(opts: ClaudeCallerOptions) → LlmCaller
callClaude(prompt, label, opts: ClaudeCallerOptions) → CallClaudeResult
callClaudeAsync(prompt, label, opts: ClaudeCallerOptions) → Promise<CallClaudeResult>
DEFAULT_CLAUDE_CALLER_OPTIONS → ClaudeCallerOptions

// Callers (step-pipeline/callers/claude-stream)
createClaudeStreamCaller(opts: StreamCallerOptions) → (prompt, label) => Promise<StreamCallerResult>
DEFAULT_STREAM_CALLER_OPTIONS → StreamCallerOptions
```
