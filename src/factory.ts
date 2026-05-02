/**
 * Step factories — the only way to create steps.
 *
 * createLlmStep()    — wires promptAssembler -> caller -> parser into execute().
 * createScriptStep() — wraps a pure transform into the Step interface.
 *
 * Retry is step-scoped. The runner never retries.
 */

import pRetry, { AbortError } from 'p-retry'

import { writeStepFixture } from './fixture-writer.js'
import type { LlmStepConfig, PipelineContext, ScriptStepConfig, Step, StepResult } from './types.js'

// ── LLM Step Factory ─────────────────────────────────────────────────────────

export function createLlmStep<TInput, TOutput>(config: LlmStepConfig<TInput, TOutput>): Step<TInput, TOutput> {
  const { name, description, model, retry, promptAssembler, parser, caller, label, onRetry } = config
  const { maxRetries, baseDelayMs, backoffMultiplier, retryOnParseError } = retry

  return {
    name,
    description,
    kind: 'llm',

    async execute(input: TInput, ctx: PipelineContext): Promise<StepResult<TOutput>> {
      const startMs = Date.now()
      const maxAttempts = maxRetries + 1

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

      // 3. Retry loop (via p-retry)
      // Closure captures the latest raw output and parse errors for error reporting.
      let lastRaw = ''
      let lastErrors: string[] = []
      let lastAttemptNumber = 0

      try {
        const { parsed, raw, attemptNumber: successAttempt } = await pRetry(
          async (attemptNumber) => {
            lastAttemptNumber = attemptNumber
            // 3a. Call LLM — LLM call failures are NOT retryable (AbortError)
            let llmResult: Awaited<ReturnType<typeof caller>>
            try {
              llmResult = await caller(prompt, `${label} (attempt ${attemptNumber}/${maxAttempts})`, ctx)
            } catch (err) {
              throw new AbortError(err instanceof Error ? err : new Error(String(err)))
            }

            lastRaw = llmResult.raw

            // 3b. Save raw fixture (protected)
            if (ctx.saveFixtures) {
              try {
                writeStepFixture(ctx.fixtureDir, ctx.runId, name, { raw: llmResult.raw })
              } catch (_fixtureErr) {
                // Non-fatal
              }
            }

            // 3c. Parse response
            const { result, errors } = parser(llmResult.raw)

            if (errors.length === 0) {
              return { parsed: result, raw: llmResult.raw, attemptNumber }
            }

            lastErrors = errors

            // If parse errors are not retryable, abort immediately
            if (!retryOnParseError) throw new AbortError(errors.join('; '))

            // Otherwise, let p-retry schedule the next attempt
            throw new Error(errors.join('; '))
          },
          {
            retries: maxRetries,
            factor: backoffMultiplier,
            minTimeout: baseDelayMs,
            onFailedAttempt: (ctx) => {
              // onFailedAttempt is never called for AbortError, so this only fires
              // for retryable parse errors — matching the bespoke onRetry contract.
              onRetry(ctx.attemptNumber, maxAttempts, lastErrors, ctx.retryDelay)
            },
          },
        )

        // Success — save actual + meta fixtures (protected)
        if (ctx.saveFixtures) {
          try {
            writeStepFixture(ctx.fixtureDir, ctx.runId, name, {
              actual: parsed,
              meta: { model, durationMs: Date.now() - startMs },
            })
          } catch (_fixtureErr) {
            // Non-fatal
          }
        }

        return {
          status: 'ok',
          output: parsed,
          elapsedMs: Date.now() - startMs,
          meta: {
            model,
            attempts: successAttempt,
            promptLength: prompt.length,
            rawLength: raw.length,
          },
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)

        // Distinguish LLM caller failures from exhausted parse retries.
        // LLM call failures abort via AbortError — lastRaw stays empty and lastErrors is empty.
        const isCallerFailure = lastRaw === '' && lastErrors.length === 0
        if (isCallerFailure) {
          return {
            status: 'error',
            error: errMsg,
            elapsedMs: Date.now() - startMs,
            retries: lastAttemptNumber - 1,
          }
        }

        return {
          status: 'error',
          error: `Parse failed after ${lastAttemptNumber} attempt(s): ${lastErrors.join('; ')}`,
          elapsedMs: Date.now() - startMs,
          retries: lastAttemptNumber - 1,
        }
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
