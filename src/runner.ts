/**
 * Pipeline execution engine.
 *
 * PipelineBuilder — type-safe .step().build() chain.
 * parallel()      — concurrent named-record execution.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { writeAftermath } from './aftermath.js'
import { MANIFEST_FILENAME } from './constants.js'
import type {
  ParallelStepError,
  Pipeline,
  PipelineContext,
  PipelineManifest,
  PipelineResult,
  PipelineRunOptions,
  Step,
  StepManifestEntry,
  StepOutputType,
  StepResult,
} from './types.js'

// ── Pipeline Builder ─────────────────────────────────────────────────────────

/**
 * Type-safe pipeline builder.
 *
 * Usage:
 *   const pipeline = new PipelineBuilder<string>()
 *     .step(collectStep)   // string -> FileSet
 *     .step(classifyStep)  // FileSet -> ClassifyOutput
 *     .build('my-pipeline')
 */
export class PipelineBuilder<TFirst, TCurrent = TFirst> {
  private readonly steps: Step<unknown, unknown>[]

  constructor()
  constructor(steps: Step<unknown, unknown>[])
  constructor(steps?: Step<unknown, unknown>[]) {
    this.steps = steps ? [...steps] : []
  }

  /**
   * Append a step. TypeScript enforces: step input === previous output.
   */
  step<TNext>(s: Step<TCurrent, TNext>): PipelineBuilder<TFirst, TNext> {
    return new PipelineBuilder<TFirst, TNext>([...this.steps, s as Step<unknown, unknown>])
  }

  /**
   * Build the pipeline. Returns an executable Pipeline<TFirst, TCurrent>.
   */
  build(name: string): Pipeline<TFirst, TCurrent> {
    const steps = [...this.steps]

    return {
      name,

      async run(
        input: TFirst,
        ctx: PipelineContext,
        options: PipelineRunOptions,
      ): Promise<PipelineResult<TCurrent>> {
        const emit = options.onEvent
        const log = options.pipelineLogger
        const hbMs = options.heartbeatIntervalMs
        const pipelineStart = Date.now()
        const startedAt = new Date().toISOString()
        const manifestSteps: StepManifestEntry[] = []
        let current: unknown = input

        emit({ type: 'pipeline:start', name, stepCount: steps.length, timestamp: Date.now() })
        log.info('Pipeline started', { name, stepCount: steps.length })

        // ── Resume: skip steps before resumeFrom ──────────────────────────────
        let startIndex = 0
        if (options.resumeFrom !== null) {
          const idx = steps.findIndex((s) => s.name === options.resumeFrom)
          if (idx === -1) {
            throw new Error(`resumeFrom step "${options.resumeFrom}" not found in pipeline "${name}"`)
          }
          for (let i = 0; i < idx; i++) {
            manifestSteps.push({
              name: steps[i].name,
              kind: steps[i].kind,
              status: 'skipped',
              elapsedMs: 0,
              retries: 0,
              error: '',
            })
          }
          startIndex = idx
          log.info('Resuming from step', { step: options.resumeFrom, skipped: idx })
        }

        for (let i = startIndex; i < steps.length; i++) {
          const step = steps[i]
          const stepStart = Date.now()

          emit({
            type: 'step:start',
            step: step.name,
            kind: step.kind,
            index: i,
            total: steps.length,
            timestamp: stepStart,
          })
          log.info('Step started', { step: step.name, kind: step.kind, index: i })

          // ── Heartbeat timer ───────────────────────────────────────────────
          let hbTimer: ReturnType<typeof setInterval> | undefined
          if (hbMs > 0) {
            hbTimer = setInterval(() => {
              emit({
                type: 'step:heartbeat',
                step: step.name,
                elapsedMs: Date.now() - stepStart,
                timestamp: Date.now(),
              })
            }, hbMs)
          }

          // ── Execute step (with cleanup guarantee) ─────────────────────────
          let result: StepResult<unknown>
          try {
            result = await step.execute(current, ctx)
          } catch (err) {
            if (hbTimer) clearInterval(hbTimer)
            const errorMsg = err instanceof Error ? err.message : String(err)
            result = {
              status: 'error',
              error: `Step "${step.name}" threw unexpectedly: ${errorMsg}`,
              elapsedMs: Date.now() - stepStart,
              retries: 0,
            }
          }

          if (hbTimer) clearInterval(hbTimer)

          const stepElapsed = Date.now() - stepStart

          manifestSteps.push({
            name: step.name,
            kind: step.kind,
            status: result.status === 'ok' ? 'ok' : 'error',
            elapsedMs: result.elapsedMs,
            retries: result.status === 'error' ? result.retries : 0,
            error: result.status === 'error' ? result.error : '',
          })

          if (result.status === 'error') {
            emit({
              type: 'step:done',
              step: step.name,
              kind: step.kind,
              status: 'error',
              elapsedMs: stepElapsed,
              timestamp: Date.now(),
            })
            log.warn('Step failed', { step: step.name, error: result.error })

            const manifest: PipelineManifest = {
              runId: ctx.runId,
              pipelineName: name,
              startedAt,
              completedAt: new Date().toISOString(),
              status: 'aborted',
              steps: manifestSteps,
            }

            // Mark remaining steps as skipped
            const executedNames = new Set(manifestSteps.map((s) => s.name))
            for (const remaining of steps) {
              if (!executedNames.has(remaining.name)) {
                manifestSteps.push({
                  name: remaining.name,
                  kind: remaining.kind,
                  status: 'skipped',
                  elapsedMs: 0,
                  retries: 0,
                  error: '',
                })
              }
            }

            // Write aftermath + manifest (protected — fixture failure must not crash pipeline)
            if (ctx.saveFixtures) {
              try {
                writeAftermath(ctx.fixtureDir, ctx.runId, manifest, step.name, result.error)
                writeManifest(ctx.fixtureDir, ctx.runId, manifest)
              } catch (fixtureErr) {
                log.error('Failed to write fixtures on abort', {
                  error: fixtureErr instanceof Error ? fixtureErr.message : String(fixtureErr),
                })
              }
            }

            const pipelineElapsed = Date.now() - pipelineStart
            emit({ type: 'pipeline:done', name, status: 'aborted', elapsedMs: pipelineElapsed, timestamp: Date.now() })
            log.info('Pipeline aborted', { name, elapsedMs: pipelineElapsed, failedStep: step.name })

            return {
              status: 'aborted',
              manifest,
              elapsedMs: pipelineElapsed,
            }
          }

          emit({
            type: 'step:done',
            step: step.name,
            kind: step.kind,
            status: 'ok',
            elapsedMs: stepElapsed,
            timestamp: Date.now(),
          })
          log.info('Step completed', { step: step.name, elapsedMs: stepElapsed, status: 'ok' })

          current = result.output
        }

        const manifest: PipelineManifest = {
          runId: ctx.runId,
          pipelineName: name,
          startedAt,
          completedAt: new Date().toISOString(),
          status: 'ok',
          steps: manifestSteps,
        }

        // Write aftermath + manifest (protected)
        if (ctx.saveFixtures) {
          try {
            writeAftermath(ctx.fixtureDir, ctx.runId, manifest, null, '')
            writeManifest(ctx.fixtureDir, ctx.runId, manifest)
          } catch (fixtureErr) {
            log.error('Failed to write fixtures on success', {
              error: fixtureErr instanceof Error ? fixtureErr.message : String(fixtureErr),
            })
          }
        }

        const pipelineElapsed = Date.now() - pipelineStart
        emit({ type: 'pipeline:done', name, status: 'ok', elapsedMs: pipelineElapsed, timestamp: Date.now() })
        log.info('Pipeline completed', { name, elapsedMs: pipelineElapsed, status: 'ok' })

        return {
          status: 'ok',
          output: current as TCurrent,
          manifest,
          elapsedMs: pipelineElapsed,
        }
      },
    }
  }
}

// ── Parallel Execution ───────────────────────────────────────────────────────

/**
 * Run multiple steps concurrently from the same input.
 * Returns a named record — keys match the input object keys.
 *
 * Collects ALL branch errors (not just the first).
 */
export function parallel<TInput, TSteps extends Record<string, Step<TInput, unknown>>>(
  name: string,
  steps: TSteps,
): Step<TInput, { [K in keyof TSteps]: StepOutputType<TSteps[K]> }> {
  type TOutput = { [K in keyof TSteps]: StepOutputType<TSteps[K]> }

  return {
    name,
    description: `Parallel: ${Object.keys(steps).join(', ')}`,
    kind: 'parallel',

    async execute(input: TInput, ctx: PipelineContext): Promise<StepResult<TOutput>> {
      const startMs = Date.now()
      const entries = Object.entries(steps) as [string, Step<TInput, unknown>][]

      const settled = await Promise.allSettled(
        entries.map(async ([key, step]) => {
          const result = await step.execute(input, ctx)
          return { key, result }
        }),
      )

      const output = {} as Record<string, unknown>
      const branchErrors = new Map<string, Error>()

      for (let idx = 0; idx < settled.length; idx++) {
        const entry = settled[idx]
        const branchKey = entries[idx][0]

        if (entry.status === 'rejected') {
          const err = entry.reason instanceof Error ? entry.reason : new Error(String(entry.reason))
          branchErrors.set(branchKey, err)
          continue
        }

        const { key, result } = entry.value
        if (result.status === 'error') {
          branchErrors.set(key, new Error(result.error))
          continue
        }

        output[key] = result.output
      }

      if (branchErrors.size > 0) {
        const summary = [...branchErrors.entries()]
          .map(([branch, err]) => `${branch}: ${err.message}`)
          .join('; ')
        const errorResult: ParallelStepError = {
          status: 'error',
          error: `${branchErrors.size} parallel branch(es) failed: ${summary}`,
          elapsedMs: Date.now() - startMs,
          retries: 0,
          branchErrors,
        }
        return errorResult
      }

      return {
        status: 'ok',
        output: output as TOutput,
        elapsedMs: Date.now() - startMs,
        meta: { model: 'parallel', attempts: 1, promptLength: 0, rawLength: 0 },
      }
    },
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function writeManifest(fixtureDir: string, runId: string, manifest: PipelineManifest): void {
  const dir = resolve(fixtureDir, runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), 'utf8')
}
