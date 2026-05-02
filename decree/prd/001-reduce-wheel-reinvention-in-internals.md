---
status: draft
date: 2026-05-02
---

# PRD-001 Reduce Wheel-Reinvention in Internals

## Problem Statement

`workflow-pipeline` ships with three bespoke implementations of plumbing concerns that mature open-source libraries already solve at a higher quality bar:

1. **Retry-with-exponential-backoff** in `factory.ts` (`createLlmStep`) — a hand-rolled loop with manual delay computation.
2. **Subprocess spawn** in `callers/claude-cli.ts` — manual `child_process.spawn` with stdout/stderr accumulation, timeout via `setTimeout` + `kill('SIGTERM')`, and exit-code branching.
3. **NDJSON streaming** in `callers/claude-stream.ts` — manual chunk buffering, line splitting on `\n`, and `JSON.parse` per line with partial-trailing-line handling.

Each replicates a problem the ecosystem has solved with battle-tested libraries:

| Bespoke | Library | Weekly downloads |
|--------|---------|------------------|
| Retry loop | [`p-retry`](https://npm.im/p-retry) | ~50M |
| Subprocess wrapper | [`execa`](https://npm.im/execa) | ~250M |
| NDJSON line parser | [`split2`](https://npm.im/split2) | ~15M |

The cost of carrying these in-house:

- **Maintenance surface** — ~150 lines of plumbing code we own outright. Every Node release, every edge case (encoding, signal handling, partial chunk boundaries, jitter math) is on us.
- **Missed fixes** — when `p-retry` patches a backoff bug or `execa` adapts to a Node API change, we don't inherit those fixes.
- **Distraction from product surface** — review effort spent on plumbing is review effort not spent on the parts of `workflow-pipeline` that are actually unique (type-safe builder, fixture writer, aftermath, run-diff).

We want to swap the plumbing for libraries while keeping the product-defining bespoke surface untouched. See [`docs/wheel-audit/`](../../docs/wheel-audit/) for the full analysis.

## Requirements

### R1: Identify and swap commodity plumbing

Three internal modules must be replaced with library implementations:

- `factory.ts` retry block → `p-retry`
- `callers/claude-cli.ts` spawn → `execa`
- `callers/claude-stream.ts` NDJSON buffering → `split2`

### R2: Public API must not change

Every public type, function signature, and exported constant remains identical post-swap. Consumers (notably `jira-task-to-md` via `pnpm link`) must compile and run without modification. No major-version bump.

### R3: Observable behavior must not regress

For each swap, observable behavior must match the existing implementation across:

- Happy path (single attempt success, single subprocess success, single NDJSON line)
- Error paths (max retries exhausted, non-zero exit, malformed JSON)
- Edges (parse-error retry semantics, timeout signal propagation, partial line at chunk boundary)

Behavior changes are acceptable only when documented and explicitly accepted (e.g., `p-retry`'s jitter is a deliberate departure from deterministic backoff).

### R4: Bespoke product surface must NOT be replaced

The following remain in-house and untouched by this work:

- `runner.ts` `PipelineBuilder` chained-types builder
- `factory.ts` `createLlmStep` / `createScriptStep` factory shapes
- `fixture-writer.ts` filesystem-native step IO
- `aftermath.ts` markdown report generator
- `compare.ts` `diffRuns` / `renderRunDiff`
- `conditional.ts` composition primitives
- All event types and the `LlmCaller` interface

These are the product. Replacing them would be a different PRD (and likely the wrong call — see consumer's [`orchestrator-evaluation`](https://github.com/doruksahin/jira-task-to-md/tree/main/docs/orchestrator-evaluation) for why).

### R5: Each swap must be independently revertible

The work splits into three SPECs (one per swap). Each SPEC must produce a sequence of commits that can be reverted in isolation without breaking the others. This protects against a regression discovered weeks later being traced to a specific swap via `git bisect`.

### R6: Verification methodology applied uniformly

Each swap follows the same three-phase pattern (to be specified in ADR-0001):

- **Bedrock** — characterization tests pinning current observable behavior
- **Swap** — atomic replacement, old code deleted in the same commit
- **Lock-in** — snapshot or property tests preventing drift

Tests must run green at every commit boundary. CI must enforce this.

## Success Criteria

- Net code in `src/` decreases by approximately 120 lines (estimates: −50 retry, −40 spawn, −30 NDJSON; minus library wiring)
- `pnpm build` and `pnpm test` pass after each swap commit
- `jira-task-to-md` consumer regression: running `pnpm workflow feature-from-jira ATT-XXX` against a frozen baseline produces byte-identical fixtures (`git diff output/` is empty when LLM caller is deterministic)
- No public-API surface change — `tsc --noEmit` against consumer codebases succeeds without edits
- Test coverage of affected modules holds steady or improves
- Each of the three swaps lands as its own three-commit sequence (bedrock + swap + lock-in), bisect-friendly
- The ADR documenting the verification methodology is accepted before the first SPEC implements

## Scope

**In scope:**

- The three identified swaps (retry, spawn, NDJSON)
- Adding `p-retry`, `execa`, `split2` (and `fast-check` for property tests) as dependencies
- Characterization tests, snapshot tests, property tests as needed
- ADR-0001 specifying the verification methodology
- Three SPECs (one per swap)

**Out of scope:**

- Adopting [Effect TS](https://effect.website) or another large framework
- Replacing the test runner (`vitest` is the right choice)
- Replacing the build tooling (`tsc` is the right choice)
- Touching the bespoke product surface listed in R4
- Cross-crash durability, Postgres backing, or other features that would change what `workflow-pipeline` *is* (those are decisions for the consumer's `orchestrator-evaluation` work, not this PRD)
