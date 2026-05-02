# workflow-pipeline

Type-safe pipeline framework for composing LLM + script steps into reproducible workflows with fixture persistence, retry, and failure recovery.

## Quick Reference

```bash
# Build
pnpm build                          # tsc → dist/

# Test
pnpm test                           # vitest run
pnpm test:watch                     # vitest watch mode
```

**Package**: `workflow-pipeline` v0.1.0 (ESM, Node >= 22)

**Exports**:

| Export Path | What it exports |
|-------------|-----------------|
| `.` | Core types, factories, runner, constants, errors, fixtures, aftermath, compare |
| `./callers/claude-cli` | `createClaudeCaller`, `callClaude`, `callClaudeAsync` |
| `./callers/claude-stream` | `createClaudeStreamCaller` (NDJSON parser + tool tracing) |

## Structure

```
workflow-pipeline/
├── package.json              # ESM package, Node >= 22, exports: . + callers
├── tsconfig.json             # ES2022, Node16 resolution, strict, declarations to dist/
├── vitest.config.ts          # Test discovery: src/__tests__/**/*.test.ts
├── src/
│   ├── index.ts              # Main export — types, factories, runner, constants
│   ├── types.ts              # Source-of-truth types: Step, Pipeline, StepResult, PipelineContext
│   ├── factory.ts            # Step factories: createLlmStep, createScriptStep
│   ├── runner.ts             # PipelineBuilder (type-safe chain), parallel() for concurrent steps
│   ├── constants.ts          # Named constants: DEFAULT_RETRY, FIXTURE_FILES, timeouts
│   ├── errors.ts             # Error classes: StepExecutionError, ParseError, PipelineAbortedError
│   ├── fixture-writer.ts     # Step I/O persistence: writeStepFixture, readStepFixture
│   ├── aftermath.ts          # Pipeline run report: writeAftermath, parseAftermath (resume support)
│   ├── compare.ts            # Manifest diffing: diffRuns, renderRunDiff (timing + delta table)
│   ├── pipeline-builder.md  # Full API guide: creating steps, composing pipelines, fixtures
│   ├── callers/
│   │   ├── index.ts          # Re-exports both callers
│   │   ├── claude-cli.ts     # createClaudeCaller — spawns `claude -p`, captures JSON envelope
│   │   └── claude-stream.ts  # createClaudeStreamCaller — NDJSON parser, tool call tracing
│   └── __tests__/            # One test file per source file
│       ├── aftermath.test.ts
│       ├── compare.test.ts
│       ├── errors.test.ts
│       ├── factory.test.ts
│       ├── fixture-writer.test.ts
│       ├── runner.test.ts
│       └── types.test.ts
└── docs/
    ├── foundations/
    │   └── index.md          # 7 design rules that govern the codebase
    └── foundation-rules/
        └── index.md          # How to write LLM pipeline scripts (certainty, SRP, reproducibility)
```

## Key Types

Simplified signatures — see `src/types.ts` for full JSDoc and field details.

```typescript
// Step contract — every step implements this
interface Step<TInput, TOutput> {
  readonly name: string
  readonly description: string
  readonly kind: StepKind                // 'llm' | 'script' | 'parallel'
  execute(input: TInput, ctx: PipelineContext): Promise<StepResult<TOutput>>
}

// Step result — discriminated union (no optional fields)
type StepResult<T> = StepOk<T> | StepError

interface StepOk<T> {
  status: 'ok'
  output: T
  elapsedMs: number
  meta: StepMeta                        // model, attempts, promptLength, rawLength
}

interface StepError {
  status: 'error'
  error: string
  elapsedMs: number
  retries: number
}

// Pipeline interface
interface Pipeline<TInput, TOutput> {
  readonly name: string
  run(input: TInput, ctx: PipelineContext, options: PipelineRunOptions): Promise<PipelineResult<TOutput>>
}

// Pipeline result — discriminated union
type PipelineResult<TOutput> =
  | { status: 'ok'; output: TOutput; manifest: PipelineManifest; elapsedMs: number }
  | { status: 'aborted'; manifest: PipelineManifest; elapsedMs: number }

// Parse result — return type of every LLM step parser
interface ParseResult<T> {
  result: T
  errors: string[]                      // Empty array = success
}

// LLM caller — injectable transport
type LlmCaller = (prompt: string, label: string) => Promise<LlmCallerResult>

interface LlmCallerResult {
  raw: string                           // Raw LLM response text
  elapsedMs: number
  stderr: string
}

// Pipeline context — shared state across all steps
interface PipelineContext<TLogger = unknown> {
  runId: string                         // Unique ID for this pipeline run
  fixtureDir: string                    // Root directory for fixture output
  saveFixtures: boolean                 // Whether to persist fixtures to disk
  logger: TLogger                       // Consumers bring their own logger type
}
```

## Docs

| Document | When to read |
|----------|--------------|
| [docs/cookbook.md](docs/cookbook.md) | Migrating an existing `claude -p` script to a pipeline step |
| [docs/callers.md](docs/callers.md) | Claude CLI, Claude Stream, and custom LLM callers |
| [docs/primitives.md](docs/primitives.md) | `conditional()`, `asStep()`, `withMiddleware()` — composition primitives |
| [src/pipeline-builder.md](src/pipeline-builder.md) | Full API reference: step creation, composition, running, fixtures |
| [docs/foundations/index.md](docs/foundations/index.md) | Design principles: structured I/O, error handling, SRP, reproducibility, observability |
| [docs/foundation-rules/index.md](docs/foundation-rules/index.md) | Rules for writing LLM pipeline scripts: certainty, scripts, scalability, traceability |
| [CHANGELOG.md](CHANGELOG.md) | Version history |

## TypeScript

- **Target**: ES2022
- **Module resolution**: Node16 — use `.js` extensions in relative imports
- **Strict mode**: enabled
- **Declarations**: emitted to `dist/` alongside `.js` files

## Testing

- **Runner**: Vitest with globals (`describe`, `it`, `expect`, `vi` — no imports needed)
- **Run**: `pnpm test` or `pnpm test:watch`
- **Discovery**: `src/__tests__/**/*.test.ts`
- **Coverage**: one test file per source file

## Design Rules

The 7 rules from `docs/foundations/index.md` — these are enforced by the type system, code review, and the framework itself:

| # | Rule | Enforced by |
|---|------|-------------|
| 1 | **Structured I/O** | `Step<TInput, TOutput>` interface, `ParseResult<T>`, no `any` |
| 2 | **Throw, Don't Silence** | `StepError` result type, error classes with `cause`, no fallbacks |
| 3 | **Source-of-Truth Types** | Single `types.ts` file, imports not duplication |
| 4 | **Single Responsibility** | One file = one job (types, factory, runner, aftermath, compare) |
| 5 | **Fixtures & Aftermath** | `fixture-writer.ts`, `aftermath.ts`, `manifest.json`, `llm-aftermath.md` |
| 6 | **Observability** | `PipelineEvent` union, `PipelineLogger` interface, tool call tracing |
| 7 | **No Magic Numbers** | `constants.ts` — every tunable is a named constant |
