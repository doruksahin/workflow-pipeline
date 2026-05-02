# Fixtures & Aftermath

Every run is reproducible. Inputs, outputs, raw LLM responses, and failures are persisted to disk. You can replay, debug, or diff any run after the fact.

## Fixture Layout

When `ctx.saveFixtures` is true, each step writes to `{fixtureDir}/{runId}/{stepName}/`:

```
fixtures/
└── run-2024-01-15-abc/
    ├── manifest.json              ← pipeline-level: all step timings/statuses
    ├── llm-aftermath.md           ← human-readable run report
    ├── collect-files/
    │   └── actual.json            ← script step output
    ├── classify/
    │   ├── prompt.txt             ← assembled prompt sent to LLM
    │   ├── raw.txt                ← raw LLM response (truncated to 50K chars)
    │   ├── actual.json            ← parsed output
    │   └── meta.json              ← model, duration, token counts
    └── map-to-library/
        ├── prompt.txt
        ├── raw.txt
        ├── actual.json
        └── meta.json
```

## What Each File Contains

| File | Written by | Content |
|------|-----------|---------|
| `prompt.txt` | `createLlmStep` | Full prompt string passed to LLM caller |
| `raw.txt` | `createLlmStep` | Raw LLM text response (before parsing) |
| `actual.json` | Both factories | Typed output as JSON |
| `meta.json` | `createLlmStep` | `{ model, durationMs }` |
| `manifest.json` | Runner | `PipelineManifest` — step names, kinds, statuses, timings |
| `llm-aftermath.md` | Runner | Markdown report with step table, error details, resume command |

## Reading Fixtures Back

```typescript
import { readStepFixture } from 'workflow-pipeline'

// Unchecked (existing behavior)
const output = readStepFixture<ClassifyOutput>('/fixtures/run-001/classify')

// With runtime validation (opt-in type safety)
const output = readStepFixture<ClassifyOutput>(
  '/fixtures/run-001/classify',
  isClassifyOutput,  // (data: unknown) => data is ClassifyOutput
)
```

The validator is optional. Without it, `readStepFixture` uses `as T` (trust the fixture). With it, a failed validation throws immediately instead of producing garbage downstream.

## Aftermath

The aftermath file is written on **every** pipeline completion — success or abort.

### On Abort

```markdown
# Pipeline Aftermath: classify-and-map

**Run ID:** `run-001`
**Status:** ✗ Aborted

## Steps

| Step | Kind | Status | Duration |
|------|------|--------|----------|
| collect-files | script | ✓ ok | 120ms |
| classify | llm | ✗ error | 15000ms |
| map-to-library | llm | ⊘ skipped | 0ms |

## Error

**Step:** `classify`

```
Parse failed after 3 attempt(s): missing 'elements' array
```

## Resume

```bash
pnpm figma:sync --resume run-001 --from classify
```
```

### On Success

Same format, all steps show `✓ ok`, no Error section.

### Parsing for Resume

```typescript
import { parseAftermath } from 'workflow-pipeline'

const data = parseAftermath('/fixtures/run-001/llm-aftermath.md')
// { runId, pipelineName, completedSteps: ['collect-files'], failedStep: 'classify' }
```

## Resume Support

`Pipeline.run()` accepts `options.resumeFrom`:

```typescript
const result = await pipeline.run(input, ctx, {
  resumeFrom: 'classify',  // skip collect-files, start at classify
})
```

Steps before `resumeFrom` are marked `'skipped'` in the manifest. The consumer provides the correct input for the resumed step (typically read from the previous run's fixtures).
