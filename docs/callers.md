# Callers Guide

**TL;DR:** A caller is a function that sends a prompt to an LLM and returns raw text. workflow-pipeline ships two Claude callers (`claude-cli` and `claude-stream`). You can write your own in ~10 lines. Every `createLlmStep` requires a caller.

## The LlmCaller Interface

```typescript
type LlmCaller = (prompt: string, label: string, ctx?: PipelineContext) => Promise<LlmCallerResult>

interface LlmCallerResult {
  raw: string       // Raw LLM response text
  elapsedMs: number // How long the call took
  stderr: string    // Stderr output (for diagnostics)
}
```

That's it. One function, three return fields. Everything else is optional.

## Built-in: Claude CLI Caller

The most common path. Spawns `claude -p --output-format stream-json` as a subprocess.

```typescript
import { createClaudeCaller, DEFAULT_CLAUDE_CALLER_OPTIONS } from 'workflow-pipeline/callers/claude-cli'

// Use defaults (180s timeout, 2MB buffer, silent logger)
const caller = createClaudeCaller(DEFAULT_CLAUDE_CALLER_OPTIONS)

// Override timeout for long-running prompts
const slowCaller = createClaudeCaller({
  ...DEFAULT_CLAUDE_CALLER_OPTIONS,
  timeoutMs: 300_000,  // 5 minutes
})

// With structured logging
const verboseCaller = createClaudeCaller({
  ...DEFAULT_CLAUDE_CALLER_OPTIONS,
  logger: myPipelineLogger,
})
```

### What it does under the hood

1. Spawns `claude -p --output-format stream-json --verbose`
2. Pipes prompt to stdin, closes stdin
3. Parses NDJSON lines as they arrive
4. Extracts tool_use/tool_result traces (emitted as `tool:start` / `tool:done` events)
5. Returns final text + elapsed time + stderr
6. Kills the process on timeout

### Options

| Option | Default | What it controls |
|--------|---------|-----------------|
| `timeoutMs` | `180_000` (3 min) | Max wait before killing the process |
| `maxBuffer` | `2 * 1024 * 1024` (2 MB) | Max stdout size before aborting |
| `logger` | `SILENT_LOGGER` | Structured logger for lifecycle events |

### Real-time tool tracing

When used inside a pipeline (via `createLlmStep`), the caller automatically emits `tool:start` and `tool:done` events for every tool call Claude makes. These propagate to the pipeline's `onEvent` callback — meaning your Electron dashboard or TUI can show live tool activity.

This happens automatically. No configuration needed.

## Built-in: Claude Stream Caller

Lower-level caller with explicit access to tool call traces and token usage. Same NDJSON parsing, but returns enriched results.

```typescript
import { createClaudeStreamCaller, DEFAULT_STREAM_CALLER_OPTIONS } from 'workflow-pipeline/callers/claude-stream'

const caller = createClaudeStreamCaller({
  ...DEFAULT_STREAM_CALLER_OPTIONS,
  onToolStart: (trace) => console.log(`Tool started: ${trace.name}`),
  onToolCall: (trace) => console.log(`Tool done: ${trace.name} (${trace.elapsedMs}ms)`),
})

const result = await caller('Analyze this code...', 'analyze')
// result.raw — final text
// result.toolCalls — all tool_use/tool_result pairs
// result.tokenUsage — { input: N, output: N }
```

### When to use which

| Use `claude-cli` when | Use `claude-stream` when |
|---|---|
| Building pipeline steps via `createLlmStep` | Need direct access to tool call traces |
| Want automatic event integration | Building custom tooling outside workflow-pipeline |
| Don't need token counts | Need per-call token usage tracking |

## Writing a Custom Caller

Any function matching `LlmCaller` works. Example with the Anthropic SDK:

```typescript
import Anthropic from '@anthropic-ai/sdk'
import type { LlmCaller } from 'workflow-pipeline'

const anthropic = new Anthropic()

export const sdkCaller: LlmCaller = async (prompt, label) => {
  const start = Date.now()
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250514',
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  })

  const raw = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')

  return { raw, elapsedMs: Date.now() - start, stderr: '' }
}
```

Example with a mock (for tests):

```typescript
const mockCaller: LlmCaller = async (prompt, label) => ({
  raw: JSON.stringify({ elements: [], meta: { count: 0 } }),
  elapsedMs: 1,
  stderr: '',
})
```

## Using a Caller in a Step

Every `createLlmStep` takes a `caller` field:

```typescript
import { createLlmStep, DEFAULT_RETRY } from 'workflow-pipeline'
import { createClaudeCaller, DEFAULT_CLAUDE_CALLER_OPTIONS } from 'workflow-pipeline/callers/claude-cli'

const caller = createClaudeCaller(DEFAULT_CLAUDE_CALLER_OPTIONS)

export const analyzeStep = createLlmStep<AnalyzeInput, AnalyzeOutput>({
  name: 'analyze',
  description: 'Gap analysis of requirements',
  model: 'opus',
  retry: DEFAULT_RETRY,
  caller,                    // ← inject here
  promptAssembler: buildPrompt,
  parser: parseOutput,
  label: 'analyze',
  onRetry: () => {},
})
```

The step handles calling the caller, retrying on failure, timing, and fixture persistence. You never call the caller directly in step code.

## Constants Reference

| Constant | Value | Import from |
|----------|-------|-------------|
| `DEFAULT_CALLER_TIMEOUT_MS` | `180_000` (3 min) | `workflow-pipeline` |
| `DEFAULT_CALLER_MAX_BUFFER` | `2 * 1024 * 1024` (2 MB) | `workflow-pipeline` |
| `DEFAULT_CLAUDE_CALLER_OPTIONS` | `{ timeoutMs, maxBuffer, logger: SILENT_LOGGER }` | `workflow-pipeline/callers/claude-cli` |
| `DEFAULT_STREAM_CALLER_OPTIONS` | `{ timeoutMs, maxBuffer, logger, onToolStart, onToolCall }` | `workflow-pipeline/callers/claude-stream` |
| `DEFAULT_RETRY` | `{ maxRetries: 2, baseDelayMs: 1000, backoff: 2, retryOnParseError: true }` | `workflow-pipeline` |
