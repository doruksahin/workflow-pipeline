# workflow-pipeline

Type-safe pipeline framework for composing LLM + script steps into reproducible workflows. Handles retry, fixtures, events, parallel execution, and resume — so your code stays focused on prompts and parsers.

> v0.1.0 · ESM · Node ≥ 22 · Not on npm yet — use `pnpm link`.

## Install

```bash
pnpm link /path/to/workflow-pipeline
```

## Example

```typescript
import {
  createScriptStep,
  createLlmStep,
  PipelineBuilder,
} from 'workflow-pipeline'

const gather = createScriptStep({
  name: 'gather',
  description: 'List files',
  transform: (dir: string) => ({ files: ['a.ts', 'b.ts'] }),
})

const classify = createLlmStep({
  name: 'classify',
  description: 'Tag files',
  model: 'claude-sonnet-4-5',
  caller: myLlmCaller,
  promptAssembler: ({ files }) => `Tag: ${files.join(', ')}`,
  parser: (raw) => ({ result: { tags: JSON.parse(raw) }, errors: [] }),
})

const pipeline = new PipelineBuilder<string>()
  .step(gather)
  .step(classify)
  .build('demo')

const result = await pipeline.run('/src', ctx, runOptions)
```

## What you get

- Typed step chaining — types flow end-to-end through `.step()`
- LLM retry with exponential backoff (parse errors retried too)
- Fixture persistence per step (prompt, raw, parsed, meta)
- Aftermath markdown report per run
- `parallel()`, `conditional()`, `asStep()`, `withMiddleware()` for composition
- Resume from failure; diff two runs
- Bring-your-own LLM caller (Claude CLI, stream, custom)

## Docs

- [Cookbook](docs/cookbook.md) — turn a `claude -p` script into a step in 3 minutes
- [Callers](docs/callers.md) — CLI, stream, custom transports
- [Primitives](docs/primitives.md) — `conditional`, `asStep`, `withMiddleware`
- [API Reference](src/pipeline-builder.md)
- [Design Principles](docs/foundations/index.md) — the 7 rules
- [Changelog](CHANGELOG.md)

## Develop

```bash
pnpm install && pnpm build && pnpm test
```
