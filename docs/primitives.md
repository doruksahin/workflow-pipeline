# Composition Primitives

**TL;DR:** Three primitives extend step-pipeline beyond linear chains. `conditional()` routes input to one of N branches. `asStep()` nests a pipeline inside another. `withMiddleware()` wraps any step with before/after hooks.

## Overview

| Primitive | What it does | Import from |
|-----------|-------------|-------------|
| `conditional(name, config)` | Route to one branch based on input | `step-pipeline/conditional` |
| `asStep(pipeline, options?)` | Wrap a pipeline as a single step | `step-pipeline/as-step` |
| `withMiddleware(step, hooks)` | Add before/after/onError hooks | `step-pipeline/middleware` |

All three return a `Step<TInput, TOutput>` — they compose with `PipelineBuilder.step()` like any other step.

---

## conditional()

Route to one of N branches based on a router function.

```typescript
import { conditional } from 'step-pipeline/conditional'

const route = conditional<WorkflowInput, IngestOutput>('route-source', {
  router: (input) => input.source.kind,  // returns a branch key
  branches: {
    'jira': jiraIngestStep,              // Step<WorkflowInput, IngestOutput>
    'prompt': promptIngestStep,          // Step<WorkflowInput, IngestOutput>
    'markdown': markdownIngestStep,      // Step<WorkflowInput, IngestOutput>
  },
  fallback: 'prompt',                    // optional: used when router returns unknown key
})
```

### Type constraint

All branches must share `<TInput, TOutput>`. TypeScript enforces this at compile time. If you need different input shapes, use a discriminated union.

### Manifest output

```json
{ "name": "route-source", "kind": "conditional", "status": "ok", "branch": "jira" }
```

### Guardrails

- If `fallback` points to a key not in `branches`, throws at construction time (fail fast)
- If router throws, wraps the error in `StepExecutionError` with context
- Emits `step:start` / `step:done` events for the selected branch

---

## asStep()

Nest a pipeline inside a parent pipeline. The parent sees one step; the manifest shows substeps.

```typescript
import { asStep } from 'step-pipeline/as-step'

const implementFlow = new PipelineBuilder<ImplementInput>()
  .step(decomposeStep)
  .step(bundleStep)
  .step(scheduleStep)
  .build('implement')

// Use in parent:
const feature = new PipelineBuilder<FeatureInput>()
  .step(analyzeStep)
  .step(asStep(implementFlow))   // ← one step, three substeps
  .step(verifyStep)
  .build('feature')
```

### Manifest nesting

```json
{
  "name": "implement",
  "kind": "pipeline",
  "status": "ok",
  "substeps": [
    { "name": "decompose", "kind": "llm", "status": "ok", "elapsedMs": 20000 },
    { "name": "bundle", "kind": "script", "status": "ok", "elapsedMs": 5000 },
    { "name": "schedule", "kind": "script", "status": "ok", "elapsedMs": 2000 }
  ]
}
```

### Child context isolation

Child pipeline gets a scoped `fixtureDir` (defaults to `{parentDir}/{pipelineName}/`). Override with `asStep(pipeline, { fixtureSubdir: 'custom' })`.

### Error mapping

If a substep fails, `asStep()` returns `StepError` with the failing substep name: `"Child pipeline "implement" aborted at step "decompose": parse error"`.

### Event propagation

Child events flow through the parent's `onEvent` — the Electron dashboard sees substep activity in real time.

---

## withMiddleware()

Wrap any step with before/after/onError hooks for cross-cutting concerns.

```typescript
import { withMiddleware } from 'step-pipeline/middleware'

const validated = withMiddleware(analyzeStep, {
  before: async (input, ctx) => {
    schema.parse(input)  // throws if invalid
    return input
  },
  after: async (output, result, ctx) => {
    ctx.logger.info(`Step cost: $${estimateCost(result.meta)}`)
    return output
  },
  onError: (error, ctx) => {
    if (error.error.includes('rate limit')) return cachedResult
    return undefined  // propagate all other errors
  },
})
```

### Hooks

| Hook | When | Return | On throw |
|------|------|--------|----------|
| `before` | Before `step.execute()` | Transformed input | Returns `StepError` with "Middleware before hook failed" |
| `after` | After successful execution | Transformed output | Returns `StepError` with "Middleware after hook failed" |
| `onError` | After failed execution | `StepResult` to recover, or `undefined` to propagate | N/A (synchronous) |

### Stacking

Middleware wraps are composable. Inner runs first on the way in, outer first on the way out:

```typescript
const step = withMiddleware(withMiddleware(inner, m1), m2)

// Execution: m2.before → m1.before → inner.execute → m1.after → m2.after
```

### Common middleware patterns

**Gap detection:**
```typescript
function withGaps<TIn, TOut>(step: Step<TIn, TOut>): Step<TIn, TOut> {
  return withMiddleware(step, {
    after: async (output, result, ctx) => {
      const gaps = extractGaps(result)
      if (gaps.blocking.length > 0) throw new GapHaltError(gaps)
      return output
    },
  })
}
```

**Zod validation:**
```typescript
function withValidation<TIn, TOut>(step: Step<TIn, TOut>, schemas: { input?: ZodSchema; output?: ZodSchema }) {
  return withMiddleware(step, {
    before: (input) => { schemas.input?.parse(input); return input },
    after: (output) => { schemas.output?.parse(output); return output },
  })
}
```

**Cost tracking:**
```typescript
function withCost<TIn, TOut>(step: Step<TIn, TOut>): Step<TIn, TOut> {
  return withMiddleware(step, {
    after: (output, result, ctx) => {
      console.log(`${step.name}: ${result.meta.promptLength} prompt chars, ${result.elapsedMs}ms`)
      return output
    },
  })
}
```

---

## Composing Primitives Together

All three primitives return `Step<T, U>`, so they compose freely:

```typescript
// Conditional with middleware on one branch:
const route = conditional('route', {
  router: (input) => input.kind,
  branches: {
    'fast': withMiddleware(fastStep, { after: logOutput }),
    'slow': withGaps(slowLlmStep),
  },
})

// Subworkflow with middleware on the parent step:
const safeImplement = withMiddleware(asStep(implementFlow), {
  before: (input) => { validateImplementInput(input); return input },
})

// Full workflow:
const workflow = new PipelineBuilder<Input>()
  .step(route)
  .step(safeImplement)
  .step(verifyStep)
  .build('my-workflow')
```
