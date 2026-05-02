# workflow-pipeline

Type-safe pipeline framework. Steps are pure functions; the framework handles retry, fixtures, events, resume, and parallelism.

## Commands

```bash
pnpm build       # tsc → dist/
pnpm test        # vitest run (one test file per source file)
pnpm test:watch  # vitest watch
```

ESM only · Node ≥ 22 · ES2022 · `Node16` resolution (use `.js` extensions in relative imports).

## Layout

```
src/
├── types.ts          # SSOT — Step, Pipeline, StepResult, PipelineContext, ParseResult, LlmCaller
├── factory.ts        # createLlmStep, createScriptStep
├── runner.ts         # PipelineBuilder, parallel()
├── conditional.ts    # conditional(), asStep(), withMiddleware()
├── constants.ts      # DEFAULT_RETRY, FIXTURE_FILES, timeouts
├── errors.ts         # StepExecutionError, ParseError, PipelineAbortedError, ParallelBranchError
├── fixture-writer.ts # writeStepFixture, readStepFixture
├── aftermath.ts      # writeAftermath, parseAftermath (resume support)
├── compare.ts        # diffRuns, renderRunDiff
└── callers/          # claude-cli, claude-stream
```

## Rules that won't be obvious from code

1. **`types.ts` is SSOT.** Don't redefine `Step`, `Pipeline`, `StepResult` elsewhere — import.
2. **Throw, don't silence.** Steps return `StepError` or throw — never `null`/default fallbacks.
3. **No magic numbers.** Tunables live in `constants.ts`.
4. **One file = one job.** Don't co-locate factory + runner, errors + types, etc.
5. **Fixtures are first-class.** Every step run writes prompt, raw, parsed, meta to `fixtureDir`.
6. **Vitest globals are on.** No `import { describe, it } from 'vitest'` needed.

Full rationale: [docs/foundations/index.md](docs/foundations/index.md).

## Docs

| Doc | Read when |
|-----|-----------|
| [docs/cookbook.md](docs/cookbook.md) | Authoring a new step |
| [docs/callers.md](docs/callers.md) | Custom LLM callers |
| [docs/primitives.md](docs/primitives.md) | `conditional`, `asStep`, `withMiddleware` |
| [src/pipeline-builder.md](src/pipeline-builder.md) | Full API reference |
| [docs/foundations/index.md](docs/foundations/index.md) | The 7 design rules |
