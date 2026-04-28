/**
 * asStep() — Adapt a Pipeline<T,U> into a Step<T,U> for use as a subworkflow.
 *
 * Inspired by LangGraph's "compiled graph IS-A node". Creates a child context
 * with scoped fixture dir and propagates events through the parent onEvent.
 */

import { resolve } from 'node:path'

import type {
  AsStepOptions,
  EnrichableStep,
  Pipeline,
  PipelineContext,
  PipelineRunOptions,
  PipelineStep,
  StepManifestEnrichment,
  StepManifestEntry,
  StepResult,
} from './types.js'
import { SILENT_LOGGER } from './types.js'

export function asStep<TInput, TOutput>(
  pipeline: Pipeline<TInput, TOutput>,
  options?: AsStepOptions,
): PipelineStep<TInput, TOutput> & EnrichableStep<TInput, TOutput> {
  let lastSubsteps: StepManifestEntry[] | undefined

  return {
    name: pipeline.name,
    description: `Pipeline: ${pipeline.name}`,
    kind: 'pipeline',

    getSubsteps() {
      return lastSubsteps
    },

    getManifestEnrichment(): StepManifestEnrichment {
      return { substeps: lastSubsteps }
    },

    async execute(input: TInput, ctx: PipelineContext): Promise<StepResult<TOutput>> {
      const startMs = Date.now()
      lastSubsteps = undefined

      // Create scoped child context — inherits logger, onEvent, runId but isolates fixtures
      const childCtx: PipelineContext = {
        runId: ctx.runId,
        fixtureDir: options?.fixtureSubdir
          ? resolve(ctx.fixtureDir, options.fixtureSubdir)
          : resolve(ctx.fixtureDir, pipeline.name),
        saveFixtures: ctx.saveFixtures,
        logger: ctx.logger,
        onEvent: ctx.onEvent,
        currentStep: undefined,
      }

      // Build run options that propagate events to parent
      const childOptions: PipelineRunOptions = {
        onEvent: (event) => ctx.onEvent?.(event),
        heartbeatIntervalMs: 0,
        resumeFrom: null,
        pipelineLogger: SILENT_LOGGER,
      }

      const pipelineResult = await pipeline.run(input, childCtx, childOptions)

      // Record substeps for manifest
      lastSubsteps = pipelineResult.manifest.steps

      if (pipelineResult.status === 'aborted') {
        // Find the failing step for a useful error message
        const failedStep = pipelineResult.manifest.steps.find((s) => s.status === 'error')
        const errorMsg = failedStep
          ? `Child pipeline "${pipeline.name}" aborted at step "${failedStep.name}": ${failedStep.error}`
          : `Child pipeline "${pipeline.name}" aborted`

        return {
          status: 'error',
          error: errorMsg,
          elapsedMs: Date.now() - startMs,
          retries: 0,
        }
      }

      return {
        status: 'ok',
        output: pipelineResult.output,
        elapsedMs: Date.now() - startMs,
        meta: { model: 'pipeline', attempts: 1, promptLength: 0, rawLength: 0 },
      }
    },
  }
}
