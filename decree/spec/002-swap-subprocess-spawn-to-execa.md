---
status: approved
date: 2026-05-02
references:
- PRD-001
- ADR-0001
---

# SPEC-002 Swap Subprocess Spawn to execa

## Overview

Replace the hand-rolled `child_process.spawn` invocation in `src/callers/claude-cli.ts` with [`execa`](https://npm.im/execa). Three commits per ADR-0001: bedrock characterization, atomic swap, recorded-fixture lock-in.

Public API unchanged: `LlmCaller` interface, the Claude CLI envelope-parsing logic, and the result shape (`{ raw, elapsedMs, stderr }`).

## Technical Design

### Bedrock — characterization tests

File: `src/__tests__/callers.cli.characterization.test.ts` (new).

Use a fixture script (`node -e '...'`) instead of the real `claude` binary so tests run without API tokens or claude-cli installed:

| Test | What it pins |
|------|--------------|
| `captures stdout from a fixture script` | stdout capture |
| `captures stderr from a fixture script` | stderr capture |
| `surfaces non-zero exit code in result.error` | exit-code branch |
| `kills process and reports timeout when it runs longer than timeoutMs` | timeout signal propagation |
| `truncates / errors when output exceeds maxBufferBytes` | maxbuffer behavior |
| `propagates AbortSignal — process actually dies` | cancellation contract |
| `parses Claude JSON envelope from stdout into raw text + elapsedMs` | envelope-parsing contract |

The cancellation test must verify the process is actually killed (not just that the promise rejects) — use a sleep-loop fixture and check `pgrep -f` afterwards or a child-side touch-file marker.

### Swap — production change

File: `src/callers/claude-cli.ts`.

Replace the `spawn` block with:

```ts
import { execa } from 'execa'

const start = Date.now()
const result = await execa('claude', ['-p', prompt], {
  timeout: timeoutMs,
  maxBuffer: maxBufferBytes,
  reject: false,
  signal: abortSignal,
})
const elapsedMs = Date.now() - start

if (result.timedOut) throw new TimeoutError(`claude timed out after ${timeoutMs}ms`)
if (result.exitCode !== 0) throw new SubprocessError(/* ... */)

return parseEnvelope(result.stdout, result.stderr, elapsedMs)
```

Delete the bespoke `spawn` + buffer accumulation + timeout-via-setTimeout code in the same commit.

### Lock-in — recorded fixture replay

File: `src/__tests__/callers.cli.lockin.test.ts` (new).

Capture one real `claude -p` execution (or a synthetic but realistic script) to `src/__tests__/fixtures/claude-cli-envelope.json`. Replay through the caller, snapshot the parsed result.

Also add a property test for envelope variations: random model/cost/turns combinations in the JSON envelope, assert the parser extracts them correctly.

## Testing Strategy

- **Bedrock commit:** characterization tests using a small node-based fixture script. No real `claude` binary required.
- **Swap commit:** add `execa` to dependencies (`pnpm add execa`), perform the swap, all bedrock tests pass.
- **Lock-in commit:** commit a recorded envelope fixture, add replay + property tests.

The consumer regression check (in `jira-task-to-md`) is especially valuable here — real `claude -p` invocations exercise edge cases that fixture-only tests miss.

## Acceptance Criteria

### Commit 1 — Bedrock

- [ ] `src/__tests__/callers.cli.characterization.test.ts` exists with the seven tests listed
- [ ] Tests use a node-based fixture script, not the real `claude` binary
- [ ] All seven tests pass against the current (bespoke) implementation
- [ ] Commit message: `feat: characterization tests for subprocess spawn`
- [ ] `pnpm build && pnpm test` green

### Commit 2 — Swap

- [ ] `execa` added to dependencies in `package.json`
- [ ] `pnpm-lock.yaml` regenerated
- [ ] Bespoke `spawn` block in `src/callers/claude-cli.ts` deleted
- [ ] Replaced with `execa()` call as designed
- [ ] All bedrock tests pass unchanged
- [ ] Commit message: `refactor: swap child_process.spawn → execa`
- [ ] `pnpm build && pnpm test` green

### Commit 3 — Lock-in

- [ ] `src/__tests__/fixtures/claude-cli-envelope.json` exists and is committed
- [ ] `src/__tests__/callers.cli.lockin.test.ts` exists with replay test + envelope property test
- [ ] Commit message: `test: lock-in — fixture replay for claude-cli`
- [ ] `pnpm build && pnpm test` green

### Verification

- [ ] Lines removed from `src/callers/claude-cli.ts`: ≥ 30 (target ~40)
- [ ] `LlmCaller` interface unchanged
- [ ] Consumer regression: in `jira-task-to-md`, baseline-vs-post-swap run produces zero meaningful diff for a workflow that goes through the CLI caller
- [ ] `decree status SPEC-002 implement` once all boxes checked
