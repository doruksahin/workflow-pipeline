/**
 * withMiddleware() — Cross-cutting step wrapper with before/after/onError hooks.
 *
 * Stackable: withMiddleware(withMiddleware(step, m1), m2) applies m1 first (inner), then m2 (outer).
 */

import type { PipelineContext, Step, StepMiddleware, StepResult } from './types.js'

export function withMiddleware<TInput, TOutput>(
  step: Step<TInput, TOutput>,
  middleware: StepMiddleware<TInput, TOutput>,
): Step<TInput, TOutput> {
  return {
    name: step.name,
    description: step.description,
    kind: step.kind,

    async execute(input: TInput, ctx: PipelineContext): Promise<StepResult<TOutput>> {
      // ── before hook ───────────────────────────────────────────────────────
      let transformedInput = input
      if (middleware.before) {
        try {
          transformedInput = await middleware.before(input, ctx)
        } catch (err) {
          return {
            status: 'error',
            error: `Middleware before hook failed on step "${step.name}": ${err instanceof Error ? err.message : String(err)}`,
            elapsedMs: 0,
            retries: 0,
          }
        }
      }

      // ── execute wrapped step ──────────────────────────────────────────────
      const result = await step.execute(transformedInput, ctx)

      // ── onError hook ──────────────────────────────────────────────────────
      if (result.status === 'error') {
        if (middleware.onError) {
          const recovered = middleware.onError(result, ctx)
          if (recovered !== undefined) {
            return recovered
          }
        }
        return result
      }

      // ── after hook (result.status is 'ok' here — no cast needed) ─────────
      if (result.status === 'ok' && middleware.after) {
        try {
          const transformedOutput = await middleware.after(result.output, result, ctx)
          return {
            ...result,
            output: transformedOutput,
          }
        } catch (err) {
          return {
            status: 'error',
            error: `Middleware after hook failed on step "${step.name}": ${err instanceof Error ? err.message : String(err)}`,
            elapsedMs: result.elapsedMs,
            retries: 0,
          }
        }
      }

      return result
    },
  }
}
