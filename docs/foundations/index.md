# Foundations

Design principles that govern every line in `step-pipeline`. These aren't aspirational — they're enforced by the type system, the runner, and code review.

## The Rules

| # | Rule | File | One-liner |
|---|------|------|-----------|
| 1 | [Structured I/O](./structured-io.md) | types.ts, factory.ts | Every step has typed input, typed output, no `any`. |
| 2 | [Throw, Don't Silence](./error-handling.md) | errors.ts, factory.ts | Errors propagate. No fallbacks, no swallowing. |
| 3 | [Source-of-Truth Types](./type-authority.md) | types.ts | One file defines every shared type. Import, don't duplicate. |
| 4 | [Single Responsibility](./separation-of-concerns.md) | all files | Each file does one thing. Factories create, runner runs, aftermath reports. |
| 5 | [Fixtures & Aftermath](./reproducibility.md) | fixture-writer.ts, aftermath.ts | Every run is reproducible. Inputs, outputs, and failures are persisted. |
| 6 | [Observability](./observability.md) | runner.ts, types.ts | Events, heartbeats, and structured logging — all opt-in. |
| 7 | [No Magic Numbers](./constants.md) | constants.ts | Every tunable is a named constant in one file. |

## How They Interact

```
                    ┌─────────────────────────────────┐
                    │       Source-of-Truth Types      │
                    │          (types.ts)              │
                    └──────────┬──────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼───────┐ ┌─────▼──────┐ ┌───────▼──────┐
     │  Structured I/O │ │   SRP      │ │ No Magic #s  │
     │  (Step contract)│ │ (1 file =  │ │ (constants)  │
     │                 │ │  1 job)    │ │              │
     └────────┬───────┘ └─────┬──────┘ └───────┬──────┘
              │                │                │
              └────────────────┼────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼───────┐ ┌─────▼──────┐ ┌───────▼──────┐
     │ Throw, Don't   │ │ Fixtures & │ │Observability │
     │ Silence         │ │ Aftermath  │ │(events, logs)│
     └────────────────┘ └────────────┘ └──────────────┘
```

Rules 1-4 are **structural** — they shape the code. Rules 5-7 are **operational** — they shape the runtime.
