# step-pipeline

Type-safe pipeline framework for composing LLM + script steps into reproducible workflows.

## Motivation

LLM calls are expensive and flaky — you need retry logic with exponential backoff and fixture persistence to avoid wasting API credits on repeated failures. Every pipeline run should be fully reproducible with logged inputs, outputs, and metadata. This framework handles the plumbing (retry, fixture I/O, event emission, parallel execution, run comparison) so step authors can focus on prompt assembly and parsing logic.

## Install

```bash
# Not yet published to npm. Use a local link:
pnpm link /path/to/llm-pipeline
```

> Requires Node >= 22. ESM only.

## Quick Example

```typescript
import {
  createScriptStep,
  createLlmStep,
  PipelineBuilder,
  SILENT_LOGGER,
  type LlmCaller,
} from 'step-pipeline'

// Script step: pure transform
const gatherFiles = createScriptStep({
  name: 'gather-files',
  description: 'Scan directory for files',
  transform: (dir: string) => ({ files: ['a.ts', 'b.ts', 'c.ts'] }),
})

// Mock LLM caller
const mockCaller: LlmCaller = async (prompt, label) => ({
  raw: '["utils", "components", "tests"]',
  elapsedMs: 120,
  stderr: '',
})

// LLM step: prompt + parse
const categorize = createLlmStep({
  name: 'categorize',
  description: 'Classify files into categories',
  model: 'claude-sonnet-4-5',
  retry: { maxRetries: 3, baseDelayMs: 1000, backoffMultiplier: 2, retryOnParseError: true },
  caller: mockCaller,
  promptAssembler: (input: { files: string[] }) =>
    `Classify these files into categories: ${input.files.join(', ')}`,
  parser: (raw) => ({ result: { categories: JSON.parse(raw) }, errors: [] }),
  label: 'categorize-files',
  onRetry: () => {},
})

// Build and run
const pipeline = new PipelineBuilder<string>()
  .step(gatherFiles)
  .step(categorize)
  .build('classify-pipeline')

const result = await pipeline.run(
  '/src',
  {
    runId: 'run-001',
    fixtureDir: './fixtures',
    saveFixtures: true,
    logger: console,
  },
  {
    onEvent: () => {},
    heartbeatIntervalMs: 0,
    resumeFrom: null,
    pipelineLogger: SILENT_LOGGER,
  }
)

if (result.status === 'ok') {
  console.log(result.output.categories) // ["utils", "components", "tests"]
}
```

## Features

- **Typed step chaining** — Full type inference from input through every `.step()` call to final output.
- **LLM retry with backoff** — Exponential backoff with configurable max retries and parse-error retry.
- **Fixture persistence** — Auto-save prompts, raw outputs, parsed results, and metadata per step.
- **Aftermath reports** — Markdown report with all steps, timings, errors, and retry counts.
- **Pipeline events** — Lifecycle hooks for pipeline/step start/done/heartbeat.
- **Parallel execution** — Execute multiple independent steps concurrently with `parallel()`.
- **Resume from failure** — Skip successful steps and retry from the first failed step.
- **Run comparison** — Diff two pipeline runs by comparing outputs, timings, and step statuses.
- **Pluggable callers** — Bring your own LLM client (Claude CLI, streaming, or custom).

## Documentation

| Doc | What it covers |
|-----|----------------|
| [Cookbook](docs/cookbook.md) | **Start here.** Turn a `claude -p` script into a pipeline step in 3 minutes. |
| [Callers Guide](docs/callers.md) | Claude CLI, Claude Stream, and custom LLM callers. |
| [Primitives](docs/primitives.md) | `conditional()`, `asStep()`, `withMiddleware()` — composition beyond linear chains. |
| [API Reference](src/pipeline-builder.md) | Full `PipelineBuilder`, `createLlmStep`, `createScriptStep` reference. |
| [Design Principles](docs/foundations/index.md) | The 7 rules governing the codebase. |
| [Changelog](CHANGELOG.md) | Version history. |

## API Overview

**Step creation:** `createLlmStep()`, `createScriptStep()`
**Pipeline composition:** `PipelineBuilder`, `parallel()`, `conditional()`, `asStep()`, `withMiddleware()`
**Execution:** `.run()`, `PipelineRunOptions`
**Fixtures:** `writeStepFixture()`, `readStepFixture()`
**Aftermath:** `writeAftermath()`, `parseAftermath()`
**Comparison:** `diffRuns()`, `renderRunDiff()`
**Errors:** `StepExecutionError`, `ParseError`, `PipelineAbortedError`, `ParallelBranchError`
**Callers:** `LlmCaller`, `claude-cli`, `claude-stream`

## Exports

| Path | Exports |
|------|---------|
| `.` | Core types, factories, runner, constants, errors, fixtures, aftermath, comparison |
| `./callers/claude-cli` | Claude CLI subprocess caller |
| `./callers/claude-stream` | Claude streaming API caller |

## Project Structure

```
src/
├── index.ts              # Barrel export
├── types.ts              # All framework types (Step, Pipeline, PipelineResult, etc.)
├── constants.ts          # DEFAULT_RETRY, FIXTURE_FILES, error preview length, etc.
├── factory.ts            # createLlmStep, createScriptStep
├── runner.ts             # PipelineBuilder, parallel, execution logic
├── errors.ts             # StepExecutionError, ParseError, PipelineAbortedError, etc.
├── fixture-writer.ts     # writeStepFixture, readStepFixture (JSON + raw text)
├── aftermath.ts          # writeAftermath, parseAftermath (run summary Markdown)
├── compare.ts            # diffRuns, renderRunDiff (compare two runs)
├── callers/
│   ├── claude-cli.ts     # Subprocess caller for `claude` CLI
│   └── claude-stream.ts  # Stream-JSON NDJSON caller with tool-call tracing
└── __tests__/            # Vitest tests for all modules
```

## Development

```bash
pnpm install && pnpm build && pnpm test
```

## Design Principles

Every step is a pure function with one contract: `execute(input, ctx) => Promise<StepResult<TOutput>>`. The framework handles retry, fixtures, events, and orchestration — step authors write prompts and parsers. See [`docs/foundations/index.md`](docs/foundations/index.md) for full rationale.
