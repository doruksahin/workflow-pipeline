# Foundation Rules

These rules govern every LLM pipeline script. They are not aspirational — they are enforced by the type system, code review, and the framework itself.

See also: [docs/foundations/](../foundations/index.md) for how step-pipeline implements these rules in practice.

---

## 1. Certainty

Inputs and outputs must be obvious. The pipeline should never leave you guessing what went in or what came out.

### Structured Output

Every step — LLM or script — produces typed, validated output. No raw strings as final results. No `any`.

- **LLM steps**: raw text is parsed via `parser()` into a typed `ParseResult<T>`. Parse errors are surfaced with the raw snippet for debugging.
- **Script steps**: transform function has typed `TInput => TOutput`. TypeScript enforces the contract.
- **Pipeline result**: discriminated union `{ status: 'ok', output: T } | { status: 'aborted', manifest }`. Consumer must handle both branches.

### No Fallbacks

No `|| []`, no `?? {}`, no `?.` chains on guaranteed data. If a value must exist, make the type require it.

- **Result types have zero optional fields.** `StepOk`, `StepError`, `StepManifestEntry`, `PipelineRunOptions` — all fields required.
- **Config types require explicit values.** `label`, `onRetry`, `retry` on LlmStepConfig are all required. No hidden defaults on the consumer side.
- **The only legitimate `?.` / `??`**: system boundaries where we don't control the shape (external NDJSON streams, comparing two manifests that may have different steps).

### Throw, Don't Silence

Errors propagate. Always.

- Steps return `StepError` (expected failures) or throw (unexpected crashes). Runner catches throws and wraps them.
- Parse failures include the raw snippet and validation error list.
- Every re-thrown error uses `{ cause: err }` to preserve the chain.
- Safe stringify everywhere: `err instanceof Error ? err.message : String(err)`.
- Fixture writes are the one exception — they're non-fatal because filesystem failure shouldn't crash a successful pipeline. But they're **logged** via `pipelineLogger.error()`.

### Source-of-Truth Types

One file defines every shared type. Import, don't duplicate.

- `types.ts` is the canonical source. All interfaces, type aliases, and runtime constants (`VALID_CONFIDENCE`, `SILENT_LOGGER`) live here.
- No primitive type duplication. If `Confidence = 'high' | 'medium' | 'low'` exists in types.ts, don't redeclare it elsewhere.
- Change a type in one place, TypeScript catches every consumer that needs updating.

---

## 2. Scripts

Scripts should be systematic. Each one does one thing well, is extendable, and leaves a reproducible trail.

### Single Responsibility Principle

Each file has exactly one job. The file name screams what it does.

| File | Job |
|------|-----|
| `types.ts` | Define types |
| `constants.ts` | Named constants |
| `errors.ts` | Error classes |
| `factory.ts` | Create steps from config |
| `runner.ts` | Execute pipeline sequences |
| `aftermath.ts` | Write/parse failure reports |
| `fixture-writer.ts` | Persist step I/O to disk |
| `compare.ts` | Diff two manifests |
| `callers/*.ts` | LLM callers (one per transport) |

If a file does two things, split it.

### Extendable

- Steps are pluggable via the `Step<TInput, TOutput>` interface. Bring your own logic.
- LLM callers are pluggable via `LlmCaller` type. Bring your own transport.
- Pipeline events and logger are opt-in — consumers wire them to their own observability stack.

### Screaming Architecture

A new developer should understand the system from file names alone, without reading code:

```
src/
  types.ts            "types live here"
  factory.ts          "steps are created here"
  runner.ts           "pipelines run here"
  aftermath.ts        "failure reports are written here"
  fixture-writer.ts   "step I/O is persisted here"
  errors.ts           "error classes live here"
  compare.ts          "runs are compared here"
  constants.ts        "tunables live here"
```

### Fixtures

Every run persists its I/O for reproducibility and debugging:

```
{fixtureDir}/{runId}/{stepName}/
  prompt.txt      LLM input
  raw.txt         LLM raw output (before parsing)
  actual.json     Typed, parsed output
  meta.json       Model, duration, attempts
```

### llm-aftermath.md

Every pipeline run (success or abort) writes a human-readable aftermath report:

```
{fixtureDir}/{runId}/llm-aftermath.md
```

Contains: run ID, pipeline name, status, step table (name/kind/status/duration), error details, and optional resume command.

### Resume

Pipelines can resume from a failed step:

```typescript
pipeline.run(input, ctx, {
  resumeFrom: 'classify',  // skip completed steps, start here
  // ...
})
```

Consumer reads previous output from fixtures, provides it as input. The aftermath file records which step failed and what was completed.

---

## 3. Scalability — Code Quality

### Primitives First

Write the small, reusable building blocks first. Compose pipelines from them.

- `findNodeById`, `findNearestAncestorByType` — primitives that many steps can reuse.
- `createLlmStep`, `createScriptStep` — factory primitives that compose into pipelines.
- `writeStepFixture`, `readStepFixture` — fixture primitives used by both factory and runner.

No premature abstractions. Three similar lines > a premature helper.

### CLAUDE.md — Progressive Disclosure

Every important submodule should have a `CLAUDE.md` that tells you:

1. **What this module does** (one sentence)
2. **Quick reference** (how to build, test, run)
3. **Structure** (file tree with one-liner per file)
4. **Key types** (the interfaces that matter)

Deep details go in sub-documents linked from CLAUDE.md. Don't dump everything at the top level.

```
project/
  CLAUDE.md              "start here"
  docs/foundation-rules/ "the rules"
  docs/foundations/       "how rules are implemented"
  src/pipeline-builder.md "API guide"
```

---

## 4. Traceable

### No Magic Numbers

Every tunable is a named constant in `constants.ts`. No raw numbers in logic.

```typescript
// constants.ts
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000
export const MAX_RAW_FIXTURE_LENGTH = 50_000
export const ERROR_PREVIEW_LENGTH = 500
```

If you need a number in code, give it a name first.

### Config File for Everything

Make configuration explicit. No buried defaults.

- **Framework tunables**: `constants.ts` (retry config, fixture limits, heartbeat interval)
- **Step config**: `LlmStepConfig`, `ScriptStepConfig` (model, retry, parser, prompt assembler)
- **Run options**: `PipelineRunOptions` (events, heartbeat, resume, logger)
- **Caller config**: `ClaudeCallerOptions`, `StreamCallerOptions` (timeout, buffer size)

Every configurable value has a type and a home. Nothing is buried in implementation.

### Verbose Logging

Three levels of observability, all structured:

1. **Events** — typed `PipelineEvent` union for TUI/activity panels
2. **Logger** — `PipelineLogger` interface (debug/info/warn/error with structured data)
3. **Tool tracing** — `ToolCallTrace` for stream callers (per-tool-call timing and I/O)

All opt-in. `SILENT_LOGGER` and `onEvent: () => {}` for zero noise. But when you turn them on, you get structured, timestamped, machine-parseable output.

---

## Compliance Status

All identified gaps have been resolved:

- ~~**Gap A**: Callers use `console.log`~~ — Replaced with `logger.info()` via `PipelineLogger` on caller options.
- ~~**Gap B**: Caller defaults duplicated~~ — `DEFAULT_CALLER_TIMEOUT_MS` and `DEFAULT_CALLER_MAX_BUFFER` centralized in `constants.ts`.
- ~~**Gap C**: No root CLAUDE.md~~ — Created with progressive disclosure (8 sections, links to deeper docs).
- ~~**Gap D**: No root README.md~~ — Created with motivation, install, quick example, features.
- ~~**Gap E**: Caller options have `?` fields~~ — All fields required. `DEFAULT_CLAUDE_CALLER_OPTIONS` and `DEFAULT_STREAM_CALLER_OPTIONS` for convenience.
- ~~**Gap F**: `PipelineLogger.data` optional~~ — Made required. All call sites pass structured data.
