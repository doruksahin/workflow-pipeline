# TUI Integration: step-pipeline + skills-tui-rs

Analysis document for building a pipeline-runner integration between `step-pipeline` (TypeScript pipeline framework) and `skills-tui-rs` (Rust TUI application).

---

## 1. Current State of Both Projects

### 1.1 step-pipeline's Observability Surface

The pipeline framework has three tiers of observability, all configurable through `PipelineRunOptions`:

**Tier 1 -- Events** (`onEvent` callback)

Five event types form a discriminated union (`PipelineEvent`):

```typescript
type PipelineEvent =
  | PipelineStartEvent    // { name, stepCount, timestamp }
  | PipelineDoneEvent     // { name, status: 'ok'|'aborted', elapsedMs, timestamp }
  | StepStartEvent        // { step, kind, index, total, timestamp }
  | StepDoneEvent         // { step, kind, status: 'ok'|'error', elapsedMs, timestamp }
  | StepHeartbeatEvent    // { step, elapsedMs, timestamp }
```

All events carry a `timestamp` (epoch ms). `StepStartEvent` carries `index` and `total` for progress tracking. Heartbeats fire every `heartbeatIntervalMs` (default 5000ms) while a step is running and are always cleaned up when the step finishes.

**Tier 2 -- Logging** (`PipelineLogger` interface)

Structured key-value logging at debug/info/warn/error levels. Covers: pipeline started/completed/aborted, step started/completed/failed, fixture write failures, resume info. Separate from `ctx.logger` (consumer domain logging).

**Tier 3 -- Tool-Call Tracing** (stream caller)

The `createClaudeStreamCaller` parses Claude Code's `--output-format stream-json` NDJSON and extracts `ToolCallTrace` records:

```typescript
interface ToolCallTrace {
  id: string                       // tool use ID
  name: string                     // e.g. 'Read', 'Edit', 'Bash'
  input: Record<string, unknown>   // tool input parameters
  result: string                   // tool output (empty until completed)
  elapsedMs: number                // time from tool_use to tool_result
}
```

The `onToolCall(trace)` callback fires in real-time as each tool_result completes a pending tool_use. The stream caller also returns `tokenUsage: { input, output }`.

**Retry Events** (factory level)

The `LlmStepConfig.onRetry` callback fires before each retry delay with `(attempt, maxAttempts, errors, delayMs)`. Currently step-scoped; not surfaced through `PipelineEvent`.

**Fixtures**

The framework writes step-scoped fixtures to `{fixtureDir}/{runId}/{stepName}/`: `prompt.txt`, `raw.txt`, `actual.json`, `meta.json`. At pipeline level: `manifest.json` and `llm-aftermath.md`.

**Key Architectural Facts**

- The `onEvent` callback is synchronous and fire-and-forget. No backpressure.
- Events are emitted from the runner loop, not from steps themselves (steps return `StepResult`, the runner wraps them in events).
- The pipeline is invoked as a library -- there is no standalone CLI process. The consumer calls `pipeline.run(input, ctx, options)` in-process.
- `PipelineRunOptions` has no optional fields -- all observability is explicitly configured by the consumer.

### 1.2 skills-tui-rs Architecture

**Framework**: ratatui 0.29 + crossterm 0.28, with tokio for async subprocess execution.

**Three-Layer Architecture**:
- **Presentation**: `ui.rs` (rendering), `layout.rs` (rect computation), `mouse.rs` (mouse dispatch)
- **Application**: `app.rs` (App struct, event loop), `panels/` (Panel enum + dispatch macro), `registry.rs` (parallel startup)
- **Data**: `data/` (CLI loaders, poller, status watcher), `models/` (serde structs)

**Event Loop** (`App::handle_events()`):
1. Poll async panel sources (sessions pagination, skill lab runner, session runner)
2. Poll session poller for live refresh
3. Poll file system status watcher
4. Adaptive timeout: 16ms during active runs (~60fps), 100ms otherwise
5. Dispatch terminal key/mouse events

**How External Processes Communicate with the TUI**:

The TUI uses four IPC patterns today:

| Pattern | Used By | Mechanism |
|---------|---------|-----------|
| **mpsc channel** | Skill Lab, Runner | `tokio::sync::mpsc::unbounded_channel` -- async subprocess sends `LabEvent`/`ExecutorEvent` through channel, panel's `tick()` drains non-blocking |
| **Thread + std mpsc** | SessionPoller | `std::sync::mpsc::channel` -- background thread polls subprocess every 3s, main loop calls `tick()` |
| **File system watcher** | StatusWatcher | `notify` crate watches `~/.claude/tui-status/`, sends `StatusEvent` through `std::sync::mpsc` |
| **Subprocess shelling** | All data loaders | Synchronous `Command::new().output()` at startup (parallel via `std::thread::scope`) |

**Key Design Constraints**:
- `stdin(Stdio::null())` is mandatory for all subprocesses (prevents stealing terminal input from crossterm)
- Panel dispatch uses enum + macro (not trait objects) due to `Frame<'_>` lifetime constraints
- `PanelState<T>` provides shared list navigation; custom panels extend it
- Events from async sources are drained via `try_recv()` in `tick()` methods every frame

**Existing Runner Panel** (`panels/runner/`):

The closest existing analog to a pipeline panel. Spawns `claude -p --output-format stream-json` headlessly, streams `ExecutorEvent` variants through an unbounded channel:

```rust
enum ExecutorEvent {
    Output { text: String, kind: OutputKind },
    SessionId(String),
    Completed,
    Failed(String),
    Error(String),
}
```

Detail view shows streaming output lines, color-coded by `OutputKind` (Text, ToolUse, ToolResult). Supports cancel via `CancelHandle` (Arc<AtomicBool>).

**EventLog** (debug overlay):

Ring buffer of 100 entries, accessible via Ctrl+D. Categorized by `LogSource` (Sessions, Lab, System) and `LogLevel` (Info, Error). Tab filtering. This is the TUI's internal observability -- separate from any external pipeline.

---

## 2. Integration Pattern Analysis

### 2a. NDJSON over stdout

**Mechanism**: Pipeline process writes one JSON event per line to stdout. TUI spawns the process, reads stdout line-by-line, parses each line into a Rust struct, and pushes through an mpsc channel.

**Feasibility**: High. This is exactly how the existing Runner panel works -- it spawns `claude -p --output-format stream-json` and parses NDJSON. The TUI already has all the infrastructure: tokio subprocess spawning, line-by-line stdout reading, `try_recv()` polling in `tick()`.

**Trade-offs**:

| Pro | Con |
|-----|-----|
| Battle-tested pattern (Runner panel, Skill Lab CLI backend) | Requires a CLI wrapper around `pipeline.run()` |
| Unidirectional (simple) | stderr mixing requires careful separation |
| Language-agnostic serialization | No backpressure from TUI to pipeline |
| Clean process lifecycle (exit code = done) | One-shot: no interactive control after spawn |
| Easy to test (pipe to `jq`) | |

**Required work**: Write a thin Node.js CLI entry point that calls `pipeline.run()` with an `onEvent` that does `console.log(JSON.stringify(event))`. The TUI spawns this process.

### 2b. Unix Socket / Named Pipe

**Mechanism**: Pipeline process and TUI communicate over a Unix domain socket or named pipe. Bidirectional.

**Feasibility**: Medium. Adds complexity for bidirectional communication that may not be needed. The pipeline is fundamentally a push-only stream of events; the only control flow from TUI to pipeline would be "cancel", which can be done via process signals (SIGTERM).

**Trade-offs**:

| Pro | Con |
|-----|-----|
| Bidirectional (cancel, pause, query) | Complex setup: socket path management, connection lifecycle |
| Multiple TUI instances could connect | Pipeline needs a server loop (currently library-only) |
| Could support late-attach (connect to running pipeline) | Error handling for partial reads, reconnection |
| | No existing precedent in skills-tui-rs |

### 2c. File-Based (JSONL)

**Mechanism**: Pipeline appends events to a `.jsonl` file. TUI tails the file using `notify` watcher or polling.

**Feasibility**: Medium-high. The TUI already uses `notify` for `StatusWatcher`. The pipeline already writes `manifest.json` and `llm-aftermath.md` to disk.

**Trade-offs**:

| Pro | Con |
|-----|-----|
| Durable log (survives TUI restart) | Latency: file system notifications are not instant |
| Multiple consumers can read | Requires cleanup of old log files |
| Decoupled lifecycles | No backpressure |
| Easy debugging (just `tail -f`) | File locking concerns on rapid writes |
| | Slight delay vs direct pipe |

### 2d. WebSocket

**Mechanism**: Pipeline runs a WebSocket server, TUI connects as client.

**Feasibility**: Low. Neither project has a WebSocket server. The TUI is a terminal application with no HTTP stack. Adding `tokio-tungstenite` plus a server in the pipeline is significant complexity for a simple event stream.

**Not recommended.**

### 2e. Direct Rust FFI

**Mechanism**: Compile step-pipeline as a native library callable from Rust via FFI or napi-rs.

**Feasibility**: Very low. step-pipeline is a TypeScript library running on Node.js. FFI would require embedding a Node.js runtime in the Rust process, or rewriting the pipeline in Rust. The pipeline's value is in its TypeScript ecosystem integration (prompt assembly, parsers, Claude CLI).

**Not recommended.**

### Recommendation: NDJSON over stdout (Pattern 2a), with file fallback (Pattern 2c)

**Primary**: NDJSON over stdout. This matches the existing Runner panel pattern exactly. The TUI team does not need to learn a new IPC mechanism. The pipeline team writes a ~30-line CLI wrapper.

**Secondary**: File-based JSONL as an optional addition. The CLI wrapper can `tee` events to both stdout and a `.jsonl` file. This gives durability (review past runs) and supports the TUI's `manifest.json`-reading patterns. The file path would be `{fixtureDir}/{runId}/events.jsonl`.

**Cancel mechanism**: Process signals. The TUI sends `SIGTERM` to the pipeline process (same pattern as `CancelHandle` in session-runner, but cross-process). The pipeline CLI wrapper installs a signal handler that calls a pipeline-level cancel mechanism.

---

## 3. Event Protocol Design

### 3.1 Existing Events (from step-pipeline)

These map 1:1 from the TypeScript `PipelineEvent` union:

```jsonc
// Pipeline lifecycle
{"type":"pipeline:start","name":"classify-and-map","stepCount":3,"timestamp":1705000000000}
{"type":"pipeline:done","name":"classify-and-map","status":"ok","elapsedMs":27000,"timestamp":1705000027000}

// Step lifecycle
{"type":"step:start","step":"classify","kind":"llm","index":1,"total":3,"timestamp":1705000000000}
{"type":"step:done","step":"classify","kind":"llm","status":"ok","elapsedMs":12345,"timestamp":1705000012345}

// Heartbeat (while step is running)
{"type":"step:heartbeat","step":"classify","elapsedMs":5000,"timestamp":1705000005000}
```

### 3.2 New Events (to add to step-pipeline)

These extend the existing event system for TUI-level observability:

```jsonc
// Tool call started (from stream caller onToolCall)
{"type":"tool:start","step":"classify","toolId":"toolu_abc","toolName":"Read","timestamp":1705000001000}

// Tool call completed
{"type":"tool:done","step":"classify","toolId":"toolu_abc","toolName":"Read","elapsedMs":234,"timestamp":1705000001234}

// Retry about to happen (from factory onRetry)
{"type":"step:retry","step":"classify","attempt":2,"maxAttempts":3,"errors":["missing field 'confidence'"],"delayMs":2000,"timestamp":1705000010000}

// Fixture written (from fixture-writer)
{"type":"fixture:written","step":"classify","artifact":"actual.json","path":"/fixtures/run-123/classify/actual.json","timestamp":1705000012345}

// Token usage (from stream caller result)
{"type":"step:tokens","step":"classify","inputTokens":1200,"outputTokens":3400,"timestamp":1705000012345}
```

### 3.3 Rust Deserialization Types

```rust
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum PipelineEvent {
    #[serde(rename = "pipeline:start")]
    PipelineStart {
        name: String,
        #[serde(rename = "stepCount")]
        step_count: usize,
        timestamp: u64,
    },

    #[serde(rename = "pipeline:done")]
    PipelineDone {
        name: String,
        status: PipelineStatus,
        #[serde(rename = "elapsedMs")]
        elapsed_ms: u64,
        timestamp: u64,
    },

    #[serde(rename = "step:start")]
    StepStart {
        step: String,
        kind: StepKind,
        index: usize,
        total: usize,
        timestamp: u64,
    },

    #[serde(rename = "step:done")]
    StepDone {
        step: String,
        kind: StepKind,
        status: StepStatus,
        #[serde(rename = "elapsedMs")]
        elapsed_ms: u64,
        timestamp: u64,
    },

    #[serde(rename = "step:heartbeat")]
    StepHeartbeat {
        step: String,
        #[serde(rename = "elapsedMs")]
        elapsed_ms: u64,
        timestamp: u64,
    },

    #[serde(rename = "step:retry")]
    StepRetry {
        step: String,
        attempt: usize,
        #[serde(rename = "maxAttempts")]
        max_attempts: usize,
        errors: Vec<String>,
        #[serde(rename = "delayMs")]
        delay_ms: u64,
        timestamp: u64,
    },

    #[serde(rename = "tool:start")]
    ToolStart {
        step: String,
        #[serde(rename = "toolId")]
        tool_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        timestamp: u64,
    },

    #[serde(rename = "tool:done")]
    ToolDone {
        step: String,
        #[serde(rename = "toolId")]
        tool_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(rename = "elapsedMs")]
        elapsed_ms: u64,
        timestamp: u64,
    },

    #[serde(rename = "step:tokens")]
    StepTokens {
        step: String,
        #[serde(rename = "inputTokens")]
        input_tokens: u64,
        #[serde(rename = "outputTokens")]
        output_tokens: u64,
        timestamp: u64,
    },

    #[serde(rename = "fixture:written")]
    FixtureWritten {
        step: String,
        artifact: String,
        path: String,
        timestamp: u64,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PipelineStatus {
    Ok,
    Aborted,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepKind {
    Llm,
    Script,
    Parallel,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Ok,
    Error,
}
```

### 3.4 Protocol Guarantees

1. **Ordering**: Events are emitted in causal order. `pipeline:start` is always first. `pipeline:done` is always last. `step:start` precedes all events for that step. `step:done` follows all events for that step.
2. **Completeness**: Every `pipeline:start` has a matching `pipeline:done` (even on crash, via process exit code). Every `step:start` has a matching `step:done`.
3. **Forward compatibility**: The TUI must ignore unknown event types (use `#[serde(other)]` on the enum). This allows the pipeline to add new events without breaking the TUI.
4. **Line boundary**: Each event is exactly one line (no embedded newlines in JSON values). The TUI reads line-by-line.

---

## 4. TUI Panel/Widget Design

### 4.1 Panel Structure

A new `PipelinePanel` following the existing patterns: `PanelState<PipelineRunEntry>` for the list, mpsc channel for events, `tick()` for non-blocking polling.

### 4.2 Layout: List View

```
+--[ Pipeline (3) ]--------------------------------------------+
| [+] classify-and-map       ok    27.1s   2026-03-15 14:23    |
| [*] classify-and-map       running  12s  2026-03-15 14:50    |
| [-] figma-to-mapped        aborted  8.2s 2026-03-15 13:01    |
|                                                               |
|                                                               |
+---------------------------------------------------------------+
```

Status icons match the Runner panel convention: `[+]` green (ok), `[*]` yellow (running), `[-]` red (aborted).

### 4.3 Layout: Detail View (Active Run)

```
+--[ Pipeline: classify-and-map ]-------------------------------+
|                                                               |
|  classify-and-map                                             |
|                                                               |
|  Status   running                                             |
|  Run ID   run-20260315-1450                                   |
|  Steps    2/3                                                 |
|  Elapsed  12.3s                                               |
|                                                               |
|  -- Steps --------------------------------------------------  |
|                                                               |
|   [+] collect-files       script    ok       0.1s             |
|   [*] classify            llm       running  12.2s            |
|       . heartbeat 12.2s                                       |
|   [ ] map-to-library      llm       pending                   |
|                                                               |
|  -- Tool Trace (classify) ---------------------------------   |
|                                                               |
|   Read       src/button.tsx              0.02s                |
|   Bash       pnpm type-check             3.40s                |
|   Edit       src/button.tsx              0.01s    <-- active  |
|                                                               |
+---------------------------------------------------------------+
```

### 4.4 Layout: Detail View (Completed Run)

```
+--[ Pipeline: classify-and-map ]-------------------------------+
|                                                               |
|  classify-and-map                                             |
|                                                               |
|  Status    ok                                                 |
|  Run ID    run-20260315-1423                                  |
|  Elapsed   27.1s                                              |
|  Tokens    4,200 in / 8,600 out                               |
|                                                               |
|  -- Steps --------------------------------------------------  |
|                                                               |
|   [+] collect-files       script    ok       0.1s             |
|   [+] classify            llm       ok      14.2s   2 tokens  |
|   [+] map-to-library      llm       ok      12.8s   1 retry   |
|                                                               |
|  -- Fixtures -----------------------------------------------  |
|                                                               |
|   /fixtures/run-123/classify/actual.json                      |
|   /fixtures/run-123/map-to-library/actual.json                |
|   /fixtures/run-123/manifest.json                             |
|                                                               |
+---------------------------------------------------------------+
```

### 4.5 Layout: Detail View (Failed Run with Retry)

```
+--[ Pipeline: classify-and-map ]-------------------------------+
|                                                               |
|  classify-and-map                                             |
|                                                               |
|  Status    aborted                                            |
|  Run ID    run-20260315-1301                                  |
|  Failed    map-to-library                                     |
|  Elapsed   8.2s                                               |
|                                                               |
|  -- Steps --------------------------------------------------  |
|                                                               |
|   [+] collect-files       script    ok       0.1s             |
|   [+] classify            llm       ok       5.1s             |
|   [-] map-to-library      llm       error    3.0s   2 retries |
|                                                               |
|  -- Error --------------------------------------------------  |
|                                                               |
|   Parse failed after 3 attempt(s): missing field 'mappings'   |
|                                                               |
|  -- Retry History ------------------------------------------  |
|                                                               |
|   Attempt 2/3  missing field 'mappings'    delay: 1000ms      |
|   Attempt 3/3  missing field 'mappings'    delay: 2000ms      |
|                                                               |
+---------------------------------------------------------------+
```

### 4.6 Status Bar Integration

The status bar (bottom row) would show pipeline activity:

```
 [Pipeline: classify *.* 12s]   Live: 2 (3s)   Daemon: ok   Ctrl+D: log
```

The `*.*` is an animated heartbeat indicator (cycles through `.` `..` `...` while heartbeats arrive). Turns stale (dim) if no heartbeat for 2x the interval.

### 4.7 Key Bindings

| View | Key | Action |
|------|-----|--------|
| List | Enter | Open detail view |
| List | n | Start new pipeline run (if launcher exists) |
| List | d | Delete run from history |
| Detail (active) | c | Cancel (SIGTERM) |
| Detail (active) | j/k | Scroll through step list |
| Detail (completed) | j/k | Scroll through fixtures/output |
| Detail (completed) | Enter | Open fixture in viewer (reuse text_viewer) |
| Detail (completed) | y | Copy fixture path to clipboard |
| Detail | Esc | Back to list |

---

## 5. Implementation Roadmap

### Phase 1: Pipeline CLI Wrapper (step-pipeline side)

**Goal**: A Node.js CLI that runs a pipeline and emits NDJSON events to stdout.

**Files to create/modify**:

1. **`src/cli.ts`** -- Entry point. Accepts pipeline name, input file, fixture dir. Calls `pipeline.run()` with an `onEvent` that serializes to stdout.

2. **`src/types.ts`** -- Extend `PipelineEvent` union with new event types: `StepRetryEvent`, `ToolStartEvent`, `ToolDoneEvent`, `StepTokensEvent`, `FixtureWrittenEvent`.

3. **`src/factory.ts`** -- Wire `onRetry` to emit `step:retry` events through a new callback in `LlmStepConfig` (or extend `PipelineRunOptions` with a retry event callback).

4. **`src/callers/claude-stream.ts`** -- Wire `onToolCall` to emit `tool:start` and `tool:done` events. Currently `onToolCall` fires only on completion; split into two callbacks or add `tool:start` when a `tool_use` block is encountered.

**Estimated effort**: 1-2 days.

### Phase 2: Event Protocol Types (Rust side)

**Goal**: Shared types crate for pipeline event deserialization.

**Location**: Either `crates/pipeline-events/` (new crate) or inline in a new `models/pipeline.rs`.

**Contents**:
- `PipelineEvent` enum (from Section 3.3)
- `PipelineRun` struct for persisting run history
- `PipelineRunEntry` for list display (following the Dump/Entry pattern)

**Estimated effort**: 0.5 days.

### Phase 3: Pipeline Executor (Rust side)

**Goal**: Spawn the pipeline CLI process, parse NDJSON stdout, send events through mpsc channel.

**Location**: `crates/session-runner/` (extend existing) or `crates/pipeline-runner/` (new crate).

**Follows the `session_runner::executor` pattern**:
- `execute(config, tx, cancel)` -- async function
- Spawns `node pipeline-cli.js` with `stdin(Stdio::null())`
- Reads stdout line-by-line
- Parses each line as `PipelineEvent` via serde
- Sends through `tokio::sync::mpsc::unbounded_channel`
- Handles process exit, stderr, timeout

**Estimated effort**: 1 day.

### Phase 4: Pipeline Panel (Rust side)

**Goal**: Full panel implementation with list view, detail view, and event-driven updates.

**Files**:
- `src/models/pipeline.rs` -- `PipelineRunEntry`, `PipelineRun` structs
- `src/data/pipeline.rs` -- executor re-export, `runs_to_entries()` converter, history store
- `src/panels/pipeline/mod.rs` -- `PipelinePanel` struct, `PanelState<PipelineRunEntry>`, `tick()`, rendering, key handling

**Follows the Runner panel pattern** closely:
- `event_rx: Option<UnboundedReceiver<PipelineEvent>>`
- `cancel_handle: Option<CancelHandle>`
- `tick()` drains events, updates `PipelineRun` state
- Detail view renders step progress, tool trace, fixtures, errors

**Wire into**: `panels/mod.rs` (Panel enum variant), `main.rs` (registry + panel order), `models/mod.rs`, `data/mod.rs`.

**Estimated effort**: 3-4 days.

### Phase 5: Polish and Integration

- Add pipeline runs to EventLog (new `LogSource::Pipeline`)
- Status bar pipeline activity indicator
- Config overlay for launching pipelines (model selection, input file picker)
- History persistence (JSON file, following `RunHistoryStore` pattern)
- Fixture browser (reuse `text_viewer.rs` for viewing fixture files)
- Run comparison view (leverage `step-pipeline`'s `diffRuns`/`renderRunDiff`)

**Estimated effort**: 2-3 days.

---

## 6. Open Questions

### Architecture

1. **Where does the CLI wrapper live?** Options: (a) in `step-pipeline` as `src/cli.ts`, (b) in the consumer repo (e.g., `doruk-workflows`) as a thin script that imports step-pipeline. Option (b) is more flexible since different consumers may have different pipelines.

2. **Should tool-call tracing be opt-in?** Tool events can be high-frequency during complex steps. The CLI wrapper could accept a `--trace-tools` flag. The TUI could handle this by collapsing rapid tool events.

3. **How to handle parallel steps?** The current `parallel()` step doesn't emit per-branch events. The TUI needs to decide: show parallel branches as nested under the parallel step, or flatten them. Recommendation: emit `step:start`/`step:done` for each branch with a `parentStep` field.

### Data Flow

4. **Resume support from TUI?** The pipeline supports `resumeFrom` in `PipelineRunOptions`. The TUI could offer "Resume from failure" on aborted runs, passing the failed step name. This requires the CLI wrapper to accept `--resume-from <step>`.

5. **Input data flow**: How does the TUI provide input to the pipeline? Options: (a) file path argument, (b) stdin (conflicts with `Stdio::null` rule -- would need a temp file), (c) the TUI writes a temp file and passes the path. Option (c) is cleanest.

6. **Multiple concurrent pipelines?** The current Runner panel supports one active headless run. Should the Pipeline panel support multiple? If so, the list view needs a "running" indicator per row, and `tick()` must drain multiple channels.

### Protocol

7. **Error event granularity**: Should parse errors from the factory be surfaced as events? Currently they're internal to the retry loop. Adding a `step:parse-error` event would let the TUI show "attempt 2 failed: missing field X" in real time.

8. **Backpressure**: What happens if the TUI can't keep up with events? The unbounded channel will grow. For normal pipelines this is fine (events are sparse). For high-frequency tool tracing, consider a bounded channel with `try_send` (drop events rather than block the pipeline).

9. **Schema versioning**: Add a `"version": 1` field to `pipeline:start` so the TUI can detect incompatible protocol changes and show a "pipeline version mismatch" warning.

### UX

10. **Panel vs overlay?** Should pipeline runs be a full panel (new tab in the tab bar) or an overlay/sub-view within the existing Runner panel? A full panel keeps concerns separated but adds another tab. An overlay keeps related execution functionality together.

11. **Fixture browsing depth**: Should the TUI render fixture contents inline (like the Skill Lab artifact viewer) or just show paths with copy-to-clipboard? Inline viewing is richer but requires reading potentially large files.

12. **Run comparison**: step-pipeline has `diffRuns()` which produces a `RunDiff` with per-step diffs. Should the TUI have a "compare two runs" mode? This would require a split-pane or diff overlay.
