# Wheel Audit

**Question:** Which parts of `workflow-pipeline` are reinventing wheels that battle-tested libraries already solve?

**Answer:** Three internals can be swapped for community libraries with no public-API change. The bespoke parts that remain — type-safe builder, fixture format, aftermath, run-diff — are the actual product and have no off-the-shelf equivalent.

## Summary

| Module | Bespoke? | Replaceable with | Verdict |
|--------|----------|------------------|---------|
| Retry-with-exponential-backoff (`factory.ts`) | Yes | [`p-retry`](https://npm.im/p-retry) | **Swap** |
| Subprocess spawn (`callers/claude-cli.ts`) | Yes | [`execa`](https://npm.im/execa) | **Swap** |
| NDJSON streaming parser (`callers/claude-stream.ts`) | Yes | [`ndjson`](https://npm.im/ndjson) or [`split2`](https://npm.im/split2) | **Swap** |
| `PipelineBuilder` chained types (`runner.ts`) | Yes | — | **Keep** (bespoke is the product) |
| `createLlmStep` / `createScriptStep` (`factory.ts`) | Yes | — | **Keep** (domain-specific factories) |
| Fixture writer (`fixture-writer.ts`) | Yes | — | **Keep** (filesystem-native is the product) |
| Aftermath markdown report (`aftermath.ts`) | Yes | — | **Keep** |
| Run diff (`compare.ts`) | Yes | [`diff`](https://npm.im/diff) for primitives only | **Keep** (rendering is bespoke) |
| `parallel()` (`runner.ts`) | Yes | `Promise.all` is fine | **Keep** (already trivial) |

**Expected outcome:** ~150 fewer lines to maintain, no public-API change, inherit edge-case fixes from libraries with millions of weekly downloads.

See [`analysis.md`](./analysis.md) for per-module swap shapes and rationale.
