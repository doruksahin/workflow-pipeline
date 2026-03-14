# Source-of-Truth Types

`src/types.ts` is the single source of truth for every shared type. No type is defined in two places. No file invents its own version of a shared concept.

## The File

```
types.ts defines:
├── LlmCallerResult, LlmCaller         — caller contract
├── RetryConfig                          — retry parameters
├── StepMeta                             — step metadata (model, attempts, lengths)
├── StepResult (StepOk | StepError)      — step output union
├── ParallelStepError                    — StepError with branch error map
├── PipelineContext                      — shared run state
├── Step                                 — step interface
├── LlmStepConfig, ScriptStepConfig      — factory config interfaces
├── StepKind, StepStatus                 — manifest enums
├── StepManifestEntry, PipelineManifest  — run record
├── PipelineResult                       — final pipeline output
├── Pipeline                             — runnable pipeline interface
├── PipelineEvent (5 event types)        — lifecycle events
├── PipelineRunOptions                   — required run config
├── PipelineLogger, SILENT_LOGGER        — framework logger interface + no-op
├── FixtureValidator                     — type guard for fixtures
├── ParallelSteps, StepOutputType        — parallel type helpers
├── ParseResult                          — parser return type
└── Confidence                           — shared enum
```

## Rules

1. **Import, don't duplicate.** Every file that needs `StepResult` imports it from `types.ts`. Nobody writes `type StepResult = ...` locally.

2. **Types flow downward.** `types.ts` imports nothing from the framework. Every other file imports from `types.ts`. No circular deps.

3. **Barrel re-exports everything.** `index.ts` re-exports every public type. Consumers import from `step-pipeline`, not from `step-pipeline/src/types`.

4. **Config interfaces live next to their domain types.** `LlmStepConfig` and `ScriptStepConfig` live in `types.ts` because they reference `Step`, `LlmCaller`, `RetryConfig`, and `ParseResult`. The factories that consume them import the config type — they don't define it.

5. **No optional fields on result types.** `StepOk`, `StepError`, `StepManifestEntry`, `LlmCallerResult` — all fields are required. Use zero values (`0`, `''`, `null`) instead of `undefined`.

## Why This Matters

When you add a field to `Step` (like `kind: StepKind`), you change it in one place. TypeScript then tells you everywhere that needs updating — factories need to provide it, runner can read it. No grep-and-pray.

```
Change Step.kind in types.ts
  → factory.ts: TS error — missing 'kind' in returned object
  → runner.ts: can now use step.kind instead of hardcoded 'script'
  → parallel(): TS error — missing 'kind' in returned object
```

When all fields are required, TypeScript catches missing data at compile time:

```
Remove optional from StepError.retries
  → factory.ts: TS error — missing 'retries' in LLM call failure return
  → runner.ts: TS error — missing 'retries' in manifest entry
  → parallel(): TS error — missing 'retries' in error return
```
