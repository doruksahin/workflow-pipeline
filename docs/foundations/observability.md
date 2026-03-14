# Observability

The pipeline emits structured events, heartbeats, and structured log calls — all via `PipelineRunOptions`. Use `SILENT_LOGGER` and `() => {}` when you don't need observability.

## All Fields Required

`PipelineRunOptions` has no optional fields:

```typescript
interface PipelineRunOptions {
  onEvent: (event: PipelineEvent) => void   // () => {} for no events
  heartbeatIntervalMs: number               // 0 disables
  resumeFrom: string | null                 // null = start from beginning
  pipelineLogger: PipelineLogger            // SILENT_LOGGER for no logging
}
```

This is intentional — no hidden defaults. The consumer always knows exactly what's configured.

### Minimal Options (silent)

```typescript
import { SILENT_LOGGER } from 'step-pipeline'

const options: PipelineRunOptions = {
  onEvent() {},
  heartbeatIntervalMs: 0,
  resumeFrom: null,
  pipelineLogger: SILENT_LOGGER,
}
```

### Full Options (observable)

```typescript
const options: PipelineRunOptions = {
  onEvent(event) {
    if (event.type === 'step:start') console.log(`[${event.index + 1}/${event.total}] ${event.step}`)
  },
  heartbeatIntervalMs: 5_000,
  resumeFrom: null,
  pipelineLogger: console,
}
```

## Three Levels of Observability

| Level | Mechanism | Field | Use case |
|-------|-----------|-------|----------|
| 1. Events | `onEvent` callback | `PipelineRunOptions.onEvent` | TUI panels, progress bars |
| 2. Logging | `PipelineLogger` | `PipelineRunOptions.pipelineLogger` | Debug output, audit trails |
| 3. Tracing | Stream caller | `createClaudeStreamCaller({ onToolCall })` | Tool-call visibility |

## Events

```typescript
type PipelineEvent =
  | PipelineStartEvent    // pipeline begins
  | PipelineDoneEvent     // pipeline ends (ok or aborted)
  | StepStartEvent        // step begins (includes index/total)
  | StepDoneEvent         // step ends (includes elapsed, status)
  | StepHeartbeatEvent    // step still running (includes elapsed)
```

### Usage

```typescript
const result = await pipeline.run(input, ctx, {
  onEvent(event) {
    switch (event.type) {
      case 'step:start':
        console.log(`[${event.index + 1}/${event.total}] ${event.step} (${event.kind})`)
        break
      case 'step:done':
        console.log(`  ${event.status} in ${event.elapsedMs}ms`)
        break
      case 'step:heartbeat':
        console.log(`  ... still running (${event.elapsedMs}ms)`)
        break
    }
  },
  heartbeatIntervalMs: 5_000,
  resumeFrom: null,
  pipelineLogger: SILENT_LOGGER,
})
```

### Event Payloads

```typescript
// step:start — emitted before step.execute()
{ type: 'step:start', step: 'classify', kind: 'llm', index: 1, total: 3, timestamp: 1705000000000 }

// step:done — emitted after step.execute()
{ type: 'step:done', step: 'classify', kind: 'llm', status: 'ok', elapsedMs: 12345, timestamp: 1705000012345 }

// step:heartbeat — emitted every N ms while step is running
{ type: 'step:heartbeat', step: 'classify', elapsedMs: 5000, timestamp: 1705000005000 }

// pipeline:start — emitted before first step
{ type: 'pipeline:start', name: 'classify-and-map', stepCount: 3, timestamp: 1705000000000 }

// pipeline:done — emitted after last step or on abort
{ type: 'pipeline:done', name: 'classify-and-map', status: 'ok', elapsedMs: 27000, timestamp: 1705000027000 }
```

## Heartbeat

LLM steps can take minutes. Without heartbeats, the consumer has no way to know if the step is still running or hung.

```typescript
const result = await pipeline.run(input, ctx, {
  heartbeatIntervalMs: 5_000,
  onEvent(event) {
    if (event.type === 'step:heartbeat') {
      updateSpinner(`${event.step}: ${(event.elapsedMs / 1000).toFixed(0)}s`)
    }
  },
  resumeFrom: null,
  pipelineLogger: SILENT_LOGGER,
})
```

Set `heartbeatIntervalMs: 0` to disable. The heartbeat timer is always cleaned up when the step finishes — even if the step throws unexpectedly.

## Pipeline Logger

Framework-level structured logging, separate from the consumer's `ctx.logger`:

```typescript
interface PipelineLogger {
  debug(msg: string, data: Record<string, unknown>): void
  info(msg: string, data: Record<string, unknown>): void
  warn(msg: string, data: Record<string, unknown>): void
  error(msg: string, data: Record<string, unknown>): void
}
```

### SILENT_LOGGER

For when you don't need framework logging:

```typescript
import { SILENT_LOGGER } from 'step-pipeline'
// { debug() {}, info() {}, warn() {}, error() {} }
```

### What Gets Logged

| Message | Level | Data |
|---------|-------|------|
| Pipeline started | info | `{ name, stepCount }` |
| Step started | info | `{ step, kind, index }` |
| Step completed | info | `{ step, elapsedMs, status }` |
| Step failed | warn | `{ step, error }` |
| Failed to write fixtures | error | `{ error }` |
| Pipeline completed | info | `{ name, elapsedMs, status }` |
| Pipeline aborted | info | `{ name, elapsedMs, failedStep }` |
| Resuming from step | info | `{ step, skipped }` |

### ctx.logger vs pipelineLogger

| | `ctx.logger` | `pipelineLogger` |
|---|---|---|
| **Owner** | Consumer | Framework |
| **Used by** | Consumer code inside step transforms | Runner (step lifecycle) |
| **Type** | Generic `TLogger` — bring your own | `PipelineLogger` interface |
| **Scope** | Domain logic ("processing 42 files") | Framework events ("step started") |

## Caller Logging

Both built-in callers accept a `PipelineLogger` via their options. Use the defaults for silent operation:

```typescript
import { createClaudeCaller, DEFAULT_CLAUDE_CALLER_OPTIONS } from 'step-pipeline/callers/claude-cli'

// Silent (default)
const caller = createClaudeCaller(DEFAULT_CLAUDE_CALLER_OPTIONS)

// Verbose — every call logs start + completion with structured data
const caller = createClaudeCaller({ ...DEFAULT_CLAUDE_CALLER_OPTIONS, logger: console })
```

### What Gets Logged (Callers)

| Message | Level | Data |
|---------|-------|------|
| Calling claude -p | info | `{ label, timeoutMs, maxBuffer }` |
| claude -p completed | info | `{ label, elapsedMs }` |
| Calling claude -p stream-json | info | `{ label, timeoutMs, maxBuffer }` |
| claude -p stream-json completed | info | `{ label, elapsedMs, toolCallCount }` |

## Tool-Call Tracing

The stream caller parses Claude Code's NDJSON and extracts tool calls:

```typescript
import { createClaudeStreamCaller, DEFAULT_STREAM_CALLER_OPTIONS } from 'step-pipeline/callers/claude-stream'

const caller = createClaudeStreamCaller({
  ...DEFAULT_STREAM_CALLER_OPTIONS,
  onToolCall(trace) {
    console.log(`Tool: ${trace.name} (${trace.elapsedMs}ms)`)
  },
})
```

Each `ToolCallTrace` contains (all fields required):
- `id` — tool use ID
- `name` — tool name (e.g., `Read`, `Edit`)
- `input` — tool input parameters
- `result` — tool output (empty string if not yet received)
- `elapsedMs` — time from tool_use to tool_result (0 if not yet received)

The stream caller's return type (`StreamCallerResult`) extends `LlmCallerResult` with `toolCalls: ToolCallTrace[]` and `tokenUsage: { input: number; output: number }`.
