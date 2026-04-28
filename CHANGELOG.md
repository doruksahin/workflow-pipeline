# Changelog

All notable changes to step-pipeline are documented here.

## [0.2.0] — 2026-04-28

### Added

- **`conditional(name, config)`** — Route to one of N branches based on a router function. Supports fallback branch. Records selected branch in manifest. ([docs](docs/primitives.md#conditional))
- **`asStep(pipeline, options?)`** — Wrap a `Pipeline<T,U>` as a `Step<T,U>` for subworkflows. Child pipeline substeps appear in parent manifest. Scoped fixture isolation. ([docs](docs/primitives.md#asstep))
- **`withMiddleware(step, hooks)`** — Before/after/onError hooks for cross-cutting concerns. Stackable. Catches hook errors with diagnostic messages. ([docs](docs/primitives.md#withmiddleware))
- **`EnrichableStep` interface** — Typed manifest enrichment (replaces duck-typing). Steps implement `getManifestEnrichment()` for the runner to read.
- **`StepManifestEnrichment` type** — `{ branch?: string; substeps?: StepManifestEntry[] }`
- **`StepKind` values** — `'conditional'` and `'pipeline'` added to the union.
- **`StepManifestEntry` fields** — Optional `branch` and `substeps` for conditional/pipeline steps.
- New subpath exports: `step-pipeline/conditional`, `step-pipeline/middleware`, `step-pipeline/as-step`
- Callers guide, primitives guide, cookbook, and changelog documentation

### Fixed

- Middleware `after` hook no longer uses `as` cast — uses discriminant narrowing instead
- Runner manifest enrichment uses typed `EnrichableStep` interface instead of string-based property checks
- `conditional()` validates fallback key at construction time (fail fast, not runtime)
- `conditional()` wraps router errors in `StepExecutionError` with context
- `withMiddleware()` catches before/after hook errors and returns `StepError` with diagnostic message

### Tests

- 24 new tests across 3 files (conditional, as-step, middleware)
- Total: 90 tests passing

## [0.1.0] — 2026-03-15

### Added

- Core framework: `Step<TInput, TOutput>`, `PipelineBuilder`, `PipelineContext`, `PipelineManifest`
- Step factories: `createLlmStep()`, `createScriptStep()`
- `parallel()` — concurrent named-record step execution
- Claude callers: `claude-cli` (subprocess), `claude-stream` (NDJSON with tool tracing)
- Fixture persistence: `writeStepFixture()`, `readStepFixture()`
- Aftermath reports: `writeAftermath()`, `parseAftermath()`
- Run comparison: `diffRuns()`, `renderRunDiff()`
- Pipeline events: typed `PipelineEvent` union with lifecycle, heartbeat, tool, and fixture events
- Error classes: `StepExecutionError`, `ParseError`, `PipelineAbortedError`, `ParallelBranchError`
- `resumeFrom` support — skip completed steps and restart from a named step
- 7 foundation docs covering design principles
- Full API reference in `src/pipeline-builder.md`

### Tests

- 62 tests across 7 files
