---
status: approved
date: 2026-05-02
references:
- PRD-001
- ADR-0001
---

# SPEC-003 Swap NDJSON Line Buffer to split2

## Overview

Replace the hand-rolled NDJSON line-buffering logic in `src/callers/claude-stream.ts` with [`split2`](https://npm.im/split2). Three commits per ADR-0001: bedrock characterization, atomic swap, property + replay lock-in.

The current implementation accumulates chunks, splits on `\n`, parses each line with `JSON.parse`, and carries a partial trailing line forward. `split2(JSON.parse)` does this with battle-tested correctness across millions of weekly downloads.

Public API unchanged: `createClaudeStreamCaller`, the parsed message shape, the tool-call tracing logic.

## Technical Design

### Bedrock — characterization tests

File: `src/__tests__/callers.stream.characterization.test.ts` (new).

| Test | What it pins |
|------|--------------|
| `single complete line in one chunk produces one parsed message` | Trivial path |
| `multiple lines in one chunk produce N messages in order` | Ordering contract |
| `line split across two chunks produces ONE message (not two)` | Cross-chunk reassembly |
| `trailing partial line does NOT trigger premature parse` | Partial-line buffering |
| `empty lines (\\n\\n) do not produce parse errors or spurious messages` | Empty-line handling |
| `malformed JSON line surfaces error event matching old behavior` | Error-emission contract |
| `tool-call tracing wraps message events correctly` | Higher-level tracing pass-through |

### Swap — production change

File: `src/callers/claude-stream.ts`.

Replace the chunk buffer + split logic with:

```ts
import split2 from 'split2'

// In the caller setup
const lines = stream.pipe(split2(JSON.parse))

lines.on('data', (msg) => {
  emit({ type: 'message', payload: msg })
  if (msg.type === 'tool_use') traceToolCall(msg)
})

lines.on('error', (err) => {
  emit({ type: 'parse_error', error: err.message })
})
```

Delete the manual `data` listener, line-splitting code, and partial-line buffer in the same commit.

### Lock-in — property + replay

File: `src/__tests__/callers.stream.lockin.test.ts` (new).

Property test (the killer test for streaming):

```ts
it('any chunking of valid NDJSON produces same parsed message sequence', async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.json(), { minLength: 1, maxLength: 20 }),
    fc.integer({ min: 1, max: 100 }), // chunk size
    async (jsonStrings, chunkSize) => {
      const messages = jsonStrings.map((s) => JSON.parse(s))
      const ndjson = messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
      const chunks = chunkString(ndjson, chunkSize)
      const parsed = await streamThrough(chunks, makeCaller())
      expect(parsed).toEqual(messages)
    },
  ))
})
```

Recorded fixture: capture a real `claude -p --output-format stream-json` run to `src/__tests__/fixtures/claude-stream.ndjson`. Replay through the caller, snapshot the message sequence and tool-call traces.

## Testing Strategy

- **Bedrock commit:** characterization tests using synthetic NDJSON streams (programmatically constructed `Readable` streams).
- **Swap commit:** add `split2` to dependencies (`pnpm add split2`), perform the swap, bedrock tests pass.
- **Lock-in commit:** commit recorded NDJSON fixture, add property test (random chunkings) + replay test.

The property test for chunking is the most valuable test in the entire wheel-audit — it catches "works on my data, breaks on weird chunk boundaries" bugs that production traffic would surface eventually.

## Acceptance Criteria

### Commit 1 — Bedrock

- [x] `src/__tests__/callers.stream.characterization.test.ts` exists with the seven tests listed
- [x] Synthetic stream construction helper available for tests
- [x] All seven tests pass against the current (bespoke) implementation
- [x] Commit message: `feat: characterization tests for NDJSON streaming`
- [x] `pnpm build && pnpm test` green

### Commit 2 — Swap

- [x] `split2` added to dependencies in `package.json`
- [x] `pnpm-lock.yaml` regenerated
- [x] Bespoke buffer + line-split code in `src/callers/claude-stream.ts` deleted
- [x] Replaced with `stream.pipe(split2(JSON.parse))` as designed
- [x] All bedrock tests pass unchanged
- [x] Commit message: `refactor: swap NDJSON line buffer → split2`
- [x] `pnpm build && pnpm test` green

### Commit 3 — Lock-in

- [x] `src/__tests__/fixtures/claude-stream.ndjson` exists and is committed
- [x] `src/__tests__/callers.stream.lockin.test.ts` exists with property test + replay test
- [x] Property test verifies arbitrary-chunking equivalence (this is the headline test)
- [x] Commit message: `test: lock-in — property + replay tests for NDJSON streaming`
- [x] `pnpm build && pnpm test` green

### Verification

- [x] Lines removed from `src/callers/claude-stream.ts`: ≥ 25 (target ~30)
- [x] No public-API change in `src/callers/index.ts`
- [ ] Consumer regression: streaming-caller workflows in `jira-task-to-md` produce same outputs
- [ ] `decree status SPEC-003 implement` once all boxes checked
