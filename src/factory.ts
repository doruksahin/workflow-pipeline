/**
 * Step factories — the only way to create steps.
 *
 * createLlmStep()    — wires promptAssembler -> caller -> parser into execute().
 * createScriptStep() — wraps a pure transform into the Step interface.
 *
 * Retry is step-scoped. The runner never retries.
 */

import { writeStepFixture } from './fixture-writer.js'
import type { LlmStepConfig, PipelineContext, ScriptStepConfig, Step, StepResult } from './types.js'

// ── LLM Step Factory ─────────────────────────────────────────────────────────

export function createLlmStep<TInput, TOutput>(config: LlmStepConfig<TInput, TOutput>): Step<TInput, TOutput> {
  const { name, description, model, retry, promptAssembler, parser, caller, label, onRetry } = config

  return {
    name,
    description,
    kind: 'llm',

    async execute(input: TInput, ctx: PipelineContext): Promise<StepResult<TOutput>> {
      const startMs = Date.now()

      // 1. Assemble prompt
      const prompt = promptAssembler(input)

      // 2. Save prompt fixture (protected — fixture failure must not crash step)
      if (ctx.saveFixtures) {
        try {
          writeStepFixture(ctx.fixtureDir, ctx.runId, name, { prompt })
        } catch (_fixtureErr) {
          // Non-fatal: framework logs fixture failures at runner level (pipelineLogger)
        }
      }

      // 3. Retry loop
      let lastErrors: string[] = []
      const maxAttempts = retry.maxRetries + 1

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // 3a. Call LLM
        let raw: string
        try {
          const result = await caller(prompt, `${label} (attempt ${attempt}/${maxAttempts})`)
          raw = result.raw
        } catch (err) {
          // LLM call failure is NOT retryable
          return {
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
            elapsedMs: Date.now() - startMs,
            retries: attempt - 1,
          }
        }

        // 3b. Save raw fixture (protected)
        if (ctx.saveFixtures) {
          try {
            writeStepFixture(ctx.fixtureDir, ctx.runId, name, { raw })
          } catch (_fixtureErr) {
            // Non-fatal: framework logs fixture failures at runner level (pipelineLogger)
          }
        }

        // 3c. Parse response
        const { result, errors } = parser(raw)

        if (errors.length === 0) {
          // Success — save actual + meta fixtures (protected)
          if (ctx.saveFixtures) {
            try {
              writeStepFixture(ctx.fixtureDir, ctx.runId, name, {
                actual: result,
                meta: { model, durationMs: Date.now() - startMs },
              })
            } catch (_fixtureErr) {
              // Non-fatal: framework logs fixture failures at runner level (pipelineLogger)
            }
          }

          return {
            status: 'ok',
            output: result,
            elapsedMs: Date.now() - startMs,
            meta: { model, attempts: attempt, promptLength: prompt.length, rawLength: raw.length },
          }
        }

        // 3d. Parse failed — retry?
        lastErrors = errors

        if (attempt < maxAttempts && retry.retryOnParseError) {
          const delayMs = retry.baseDelayMs * Math.pow(retry.backoffMultiplier, attempt - 1)
          onRetry(attempt, maxAttempts, errors, delayMs)
          await sleep(delayMs)
        }
      }

      // All attempts exhausted
      return {
        status: 'error',
        error: `Parse failed after ${maxAttempts} attempt(s): ${lastErrors.join('; ')}`,
        elapsedMs: Date.now() - startMs,
        retries: retry.maxRetries,
      }
    },
  }
}

// ── Script Step Factory ──────────────────────────────────────────────────────

export function createScriptStep<TInput, TOutput>(config: ScriptStepConfig<TInput, TOutput>): Step<TInput, TOutput> {
  const { name, description, transform } = config

  return {
    name,
    description,
    kind: 'script',

    async execute(input: TInput, ctx: PipelineContext): Promise<StepResult<TOutput>> {
      const startMs = Date.now()

      try {
        const output = await transform(input, ctx)

        // Save actual fixture (protected)
        if (ctx.saveFixtures) {
          try {
            writeStepFixture(ctx.fixtureDir, ctx.runId, name, { actual: output })
          } catch (_fixtureErr) {
            // Non-fatal: framework logs fixture failures at runner level (pipelineLogger)
          }
        }

        return {
          status: 'ok',
          output,
          elapsedMs: Date.now() - startMs,
          meta: { model: 'script', attempts: 1, promptLength: 0, rawLength: 0 },
        }
      } catch (err) {
        return {
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          elapsedMs: Date.now() - startMs,
          retries: 0,
        }
      }
    },
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
