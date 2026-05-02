---
date: '2026-05-02'
references:
- PRD-001
status: accepted
---

# ADR-0001 Bedrock Plus Swap Plus Lock-In Verification Methodology

## Context and Problem Statement

PRD-001 mandates that we replace three bespoke internals (retry loop, subprocess spawn, NDJSON line buffer) with battle-tested libraries (`p-retry`, `execa`, `split2`) without regressing public API or observable behavior. PRD-001 R5 requires that each swap be **independently revertible**, and R6 requires that all three swaps follow the **same verification pattern** so the work is uniform and auditable.

The decision: which testing-and-commit discipline produces a refactor that is provably equivalent before/after, atomically revertible per swap, and bisect-friendly months after the work lands?

The forces in tension:

- **Confidence vs. velocity** — heavy verification slows the work; light verification risks silent regression in code that 24+ source files in `jira-task-to-md` depend on through `pnpm link`.
- **Atomicity vs. incrementalism** — each swap must be revertible alone, but tests written against the new implementation are useless for verifying the old one.
- **Characterization vs. specification** — the current bespoke code is the de facto spec; tests written against it must lock in *observable* behavior, not implementation accidents (e.g., exact ms timing rather than "delay grows exponentially within tolerance").
- **Determinism vs. realism** — pure unit tests on a mock caller are deterministic but miss real-world bugs (chunk boundaries, signal propagation, encoding quirks). Replay tests against recorded fixtures catch those but require committed fixture data.

A regression discovered three weeks after the swap lands must be traceable to one specific swap commit via `git bisect`, with no ambiguity about which library swap caused it.

## Decision Drivers

- **Public-API stability** (PRD-001 R2) — consumers must compile and run unchanged
- **Observable-behavior preservation** (PRD-001 R3) — happy paths, error paths, edges
- **Independent revertibility per swap** (PRD-001 R5) — `git revert` of any swap commit must leave a green build
- **Bisect-friendly history** — every commit on `main` must pass `pnpm test`, so `git bisect run pnpm test` works months later
- **Test discipline** — characterization tests must encode observable contracts, not implementation accidents (no asserting on exact ms when the new lib has jitter)
- **Maintenance ceiling** — the methodology itself shouldn't require infrastructure beyond what `vitest` + a property-test library provide

## Considered Options

### Option A — Bedrock + Swap + Lock-In (three commits per wheel)

For each of the three swaps:

1. **Bedrock commit** (`feat: characterization tests for <wheel>`) — adds tests pinning current observable behavior. No production change. Tests pass on `main` *before* the swap.
2. **Swap commit** (`refactor: swap <bespoke> → <library>`) — replaces the implementation, deletes old code, all bedrock tests still pass (or are documented + intentionally relaxed for accepted behavior changes like jitter).
3. **Lock-in commit** (`test: lock-in — property/snapshot tests for <wheel>`) — adds tests that future maintainers can't accidentally break. Property tests via `fast-check` for invariants; snapshot tests for fixture replay.

Nine commits total across the three swaps. Linear, bisect-friendly, every one passes `pnpm test`.

### Option B — Dual-implementation feature flag

Run both implementations side-by-side behind a runtime flag (e.g., `WORKFLOW_PIPELINE_USE_PRETRY=1`). Default to old, allow opt-in to new, run differential tests against both, eventually flip the default and remove the old code.

### Option C — Big-bang rewrite + trust existing tests

Swap all three at once. Run `pnpm test` and `pnpm --filter desktop verify` in the consumer. If green, ship.

### Option D — Snapshot-only (skip characterization phase)

Skip the bedrock phase. Write the swap commit, then add snapshot tests against the new implementation. Trust that the old test suite would have caught regressions.

## Decision Outcome

**Chosen: Option A (bedrock + swap + lock-in).**

This is the only option that satisfies all four drivers above. The other options each fail at least one:

- **Option B** introduces a runtime flag and dual code paths into a library. Consumers see the flag in their dependency surface, the library carries dead-code paths until cleanup, and the eventual default-flip is a separate landing — net more risk than a clean swap. The dual-implementation tests are valuable, but they can be done as a *temporary differential test inside the swap commit* without permanent runtime branching. **Rejected.**
- **Option C** trusts that existing tests cover everything. They don't — the bedrock phase exists precisely because writing characterization tests reveals contract gaps in the existing suite. Big-bang also kills bisect: if any swap regresses, the entire compound change must be reverted to recover. **Rejected.**
- **Option D** writes tests against the new implementation, which is a contradiction — the test would lock in the *new* behavior, not verify equivalence. Behavior changes (e.g., `p-retry`'s jitter) would silently slip in. **Rejected.**

Option A's three-phase shape is small enough to keep, large enough to catch the failure modes that matter:

- **Bedrock catches over-specified contracts** — writing a test like "delay is exactly 1000ms" before swapping forces you to confront whether the contract is "exactly 1000ms" or "approximately exponential." The library's behavior then dictates which test was right.
- **Swap commit's tests-still-pass invariant catches regressions** — bedrock tests run unchanged; if they fail, either behavior changed (document it) or the test was over-specified (relax it). No silent test relaxation.
- **Lock-in commit catches future drift** — once the swap is in, snapshot/property tests prevent a future maintainer from accidentally reintroducing bespoke code that breaks on chunk boundaries the library handles correctly.

## Consequences

### Per-swap discipline

Every swap SPEC (SPEC-001, SPEC-002, SPEC-003) must produce exactly three commits, in order:

1. `feat: characterization tests for <module>`
2. `refactor: swap <bespoke> → <library>`
3. `test: lock-in — property/snapshot/replay for <module>`

Each commit must pass `pnpm build` and `pnpm test`. CI must enforce this on every commit pushed, not just on the PR tip — otherwise `git bisect` later won't have a clean history to walk.

### Test stack additions

- [`fast-check`](https://npm.im/fast-check) added as a dev dependency for property-based tests in lock-in commits.
- Recorded fixtures (real-world `claude -p` JSON envelope, real NDJSON stream samples) committed under `src/__tests__/fixtures/`.
- `vitest` already has `toMatchSnapshot` and globals; no test runner change.

### Behavior-change protocol

If a bedrock test fails after the swap, the contributor must:

1. Identify whether the test was over-specified (asserting an implementation detail) or whether observable behavior actually changed.
2. If over-specified: relax the assertion to match the observable contract (e.g., "delay grows exponentially within ±50% jitter band" instead of "delay is exactly 1000ms"). Document the relaxation in the swap commit message.
3. If behavior actually changed: document the change in the SPEC, update the test deliberately, and write a paragraph in the swap commit message explaining what changed and why it's acceptable.

Silent test relaxation is forbidden.

### Independent revertibility

Each swap's three-commit sequence is self-contained: revert the swap commit, the bedrock and lock-in commits remain (they still test against the original behavior), the build stays green. No swap depends on another's bedrock or lock-in.

### Bisect-friendly history

Because every commit passes tests, `git bisect run pnpm test` will land on the exact swap that introduced any post-merge regression. This is the operational payoff for the discipline.

### End-to-end verification using the consumer

The consumer (`jira-task-to-md`) provides a free integration test via its filesystem-fixtures workflow:

1. Before any swap, freeze a baseline run: `pnpm workflow feature-from-jira ATT-XXX` and commit `output/ATT-XXX/`.
2. After each swap (still pnpm-linked), rerun and `git diff output/ATT-XXX/`. Expect zero diff, modulo timing fields and any documented behavior changes.

This turns the consumer's filesystem-native dev flow into a regression detector at no additional engineering cost.

### Tooling additions

| Tool | Purpose |
|------|---------|
| `fast-check` (dev dep) | Property-based tests in lock-in commits |
| Recorded fixtures (`src/__tests__/fixtures/`) | Replay tests for real-world IO shapes |
| `git bisect run pnpm test` | Post-incident forensics — find the swap that regressed |

No infrastructure changes. No new build steps. No CI rewrites.

### Out of scope

- Adopting a behavior-driven testing framework (gherkin/cucumber) — overkill
- Mutation testing (Stryker) — separate decision, can be evaluated later
- Adding integration tests against a live Anthropic API — too flaky for CI
