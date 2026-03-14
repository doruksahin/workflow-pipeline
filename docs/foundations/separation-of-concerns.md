# Single Responsibility

Each file does one thing. The boundary is clear: if you're asking "which file should I edit?", the answer should be obvious.

## File Responsibilities

| File | Responsibility | Does NOT do |
|------|---------------|-------------|
| `types.ts` | Define shared types | Contain logic |
| `factory.ts` | Create steps from config | Run pipelines, write fixtures (delegates) |
| `runner.ts` | Execute step sequences, emit events | Parse LLM output, retry |
| `aftermath.ts` | Write/read failure reports | Decide what to do about failures |
| `fixture-writer.ts` | Persist and read step I/O (write + readStepFixture) | Decide what to do with read data |
| `errors.ts` | Define error classes | Throw them (that's the caller's job) |
| `constants.ts` | Hold named constants | Contain any logic |
| `compare.ts` | Diff two manifests | Read manifests from disk |
| `callers/claude-cli.ts` | Spawn `claude -p` and capture output | Parse LLM responses |
| `callers/claude-stream.ts` | Parse stream-json NDJSON | Decide what to do with tool traces |

## Boundaries in Practice

### Factory vs Runner

**Factory** owns the step's internal lifecycle: prompt assembly, LLM call, parsing, retry. It returns a `Step` object with an `execute()` method.

**Runner** owns the pipeline lifecycle: sequencing steps, collecting manifest entries, emitting events, writing aftermath. It calls `step.execute()` and checks the result.

The runner never retries. The factory never emits events. Neither knows about the other's internals.

### Runner vs Aftermath

**Runner** calls `writeAftermath()` when the pipeline finishes (success or abort). It passes the manifest and failure info.

**Aftermath** formats the markdown and writes it. It doesn't know why it was called or what comes next.

**`parseAftermath()`** reads the file back. The consumer decides what to do (resume, report, ignore).

### Factory vs Caller

**Factory** calls `caller(prompt, label)` and gets back `{ raw, elapsedMs, stderr? }`. It doesn't know how the LLM was called.

**Caller** spawns the process, captures stdout/stderr, parses the envelope. It doesn't know what the prompt is for or what the response means.

## Adding New Features

When adding a feature, the SRP principle tells you where it goes:

- New step type → `factory.ts` (new factory function)
- New event → `types.ts` (event interface) + `runner.ts` (emit call)
- New error class → `errors.ts`
- New constant → `constants.ts`
- New CLI caller → `callers/` (new file)
- New analysis tool → new file at `src/` level (like `compare.ts`)
