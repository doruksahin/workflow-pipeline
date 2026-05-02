# Cookbook: Turn Your Script into a Pipeline Step

**TL;DR:** If you have a script that calls `claude -p` and parses the output, you can convert it to a workflow-pipeline step in 3 minutes. You get retry, fixtures, events, and type-safe composition for free.

## Before and After

**Before** — a standalone script:

```typescript
import { execSync } from 'node:child_process'

const prompt = `Classify these files: ${files.join(', ')}`
const envelope = execSync('claude -p --output-format json', { input: prompt, encoding: 'utf8' })
const raw = JSON.parse(envelope).result
const output = JSON.parse(raw)
console.log(output)
```

**After** — a reusable pipeline step:

```typescript
import { createLlmStep, DEFAULT_RETRY } from 'workflow-pipeline'
import { createClaudeCaller, DEFAULT_CLAUDE_CALLER_OPTIONS } from 'workflow-pipeline/callers/claude-cli'

const caller = createClaudeCaller(DEFAULT_CLAUDE_CALLER_OPTIONS)

export const classifyStep = createLlmStep<FileSet, ClassifyOutput>({
  name: 'classify',
  description: 'Classify files into categories',
  model: 'opus',
  retry: DEFAULT_RETRY,
  caller,
  label: 'classify',
  promptAssembler: (input) => `Classify these files: ${input.files.join(', ')}`,
  parser: (raw) => {
    const parsed = JSON.parse(raw)
    return { result: parsed, errors: [] }
  },
  onRetry: () => {},
})
```

What you get for free: retry with exponential backoff, fixture persistence (prompt, raw output, parsed result saved to disk), real-time events (step:start, step:done, tool traces), timing metadata, and type-safe composition with other steps.

## Step-by-Step Migration

### Step 1: Define your input and output types

```typescript
// types.ts
interface FileSet {
  targetDir: string
  files: string[]
}

interface ClassifyOutput {
  elements: Array<{ name: string; category: string }>
  meta: { total: number; classified: number }
}
```

### Step 2: Extract your prompt assembly

Take whatever builds the prompt string and make it a pure function:

```typescript
// Before: inline string concatenation
const prompt = `Classify these files:\n${files.map(f => readFileSync(f, 'utf8')).join('\n')}`

// After: promptAssembler function
function buildClassifyPrompt(input: FileSet): string {
  const template = readFileSync(PROMPT_PATH, 'utf8')
  const fileBlocks = input.files.map(f => {
    const content = readFileSync(f, 'utf8')
    return `--- FILE: ${f} ---\n${content}\n--- END ---`
  })
  return [template, '\n\n', fileBlocks.join('\n\n')].join('')
}
```

### Step 3: Extract your output parser

Take whatever parses the LLM response and return `ParseResult<T>`:

```typescript
// Before: JSON.parse with no validation
const output = JSON.parse(raw)

// After: parser with error collection
function parseClassifyOutput(raw: string): ParseResult<ClassifyOutput> {
  const errors: string[] = []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { result: { elements: [], meta: { total: 0, classified: 0 } }, errors: ['Invalid JSON'] }
  }

  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.elements)) errors.push('Missing elements array')
  if (typeof obj.meta !== 'object') errors.push('Missing meta object')

  return { result: obj as ClassifyOutput, errors }
}
```

The `errors` array is key: if it's non-empty and `retryOnParseError` is true, the step retries automatically.

### Step 4: Wire it into createLlmStep

```typescript
import { createLlmStep, DEFAULT_RETRY } from 'workflow-pipeline'
import { createClaudeCaller, DEFAULT_CLAUDE_CALLER_OPTIONS } from 'workflow-pipeline/callers/claude-cli'

const caller = createClaudeCaller(DEFAULT_CLAUDE_CALLER_OPTIONS)

export const classifyStep = createLlmStep<FileSet, ClassifyOutput>({
  name: 'classify',
  description: 'Classify files into categories',
  model: 'opus',
  retry: DEFAULT_RETRY,
  caller,
  label: 'classify',
  promptAssembler: buildClassifyPrompt,
  parser: parseClassifyOutput,
  onRetry: (attempt, max, errors, delay) => {
    console.log(`[classify] Retry ${attempt}/${max}: ${errors.join('; ')}`)
  },
})
```

### Step 5: Compose into a pipeline

```typescript
import { PipelineBuilder } from 'workflow-pipeline'

const pipeline = new PipelineBuilder<string>()       // string = target directory
  .step(collectFilesStep)                             // string → FileSet
  .step(classifyStep)                                 // FileSet → ClassifyOutput
  .step(writeResultsStep)                             // ClassifyOutput → WriteResult
  .build('classify-pipeline')
```

TypeScript catches type mismatches at compile time. If `collectFilesStep` returns `FileSet` but `classifyStep` expects `DifferentType`, you get a build error — not a runtime surprise after a 30-second LLM call.

---

## Converting a Deterministic Script

Not everything calls an LLM. Use `createScriptStep` for pure transforms:

```typescript
// Before: inline script
const files = glob(targetDir, '**/*.tsx')
if (files.length === 0) throw new Error('No files found')

// After: script step
import { createScriptStep } from 'workflow-pipeline'

export const collectFilesStep = createScriptStep<string, FileSet>({
  name: 'collect-files',
  description: 'Gather .tsx files from target directory',
  transform(targetDir) {
    const files = glob(targetDir, '**/*.tsx')
    if (files.length === 0) throw new Error(`No .tsx files in ${targetDir}`)
    return { targetDir, files }
  },
})
```

`transform` can be sync or async. Throw to fail the step. Return value becomes the next step's input.

---

## Running Your Pipeline

```typescript
import { SILENT_LOGGER } from 'workflow-pipeline'

const result = await pipeline.run(
  '/path/to/target',
  {
    runId: `classify-${Date.now()}`,
    fixtureDir: './fixtures',
    saveFixtures: true,
    logger: console,
  },
  {
    onEvent: (event) => {
      if (event.type === 'step:start') console.log(`[${event.index + 1}/${event.total}] ${event.step}`)
    },
    heartbeatIntervalMs: 0,
    resumeFrom: null,
    pipelineLogger: SILENT_LOGGER,
  },
)

if (result.status === 'ok') {
  console.log(result.output)    // WriteResult
  console.log(result.manifest)  // timing, status per step
} else {
  console.error('Pipeline aborted:', result.manifest)
}
```

## What You Get

After migration, your pipeline run produces:

```
fixtures/
  classify-1714300000/
    collect-files/
      output.json         ← step output
    classify/
      prompt.txt          ← exact prompt sent to LLM
      raw.txt             ← raw LLM response
      output.json         ← parsed output
      meta.json           ← model, attempts, timing
    write-results/
      output.json
    manifest.json          ← full run: steps, timing, status
    llm-aftermath.md       ← human-readable run report
```

Every run is reproducible. When an LLM step fails, you can inspect the exact prompt and raw response without re-running.
