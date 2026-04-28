/**
 * conditional() — Route to one of N branches based on a router function.
 *
 * Inspired by LangGraph's add_conditional_edges. The router inspects input
 * and returns a branch key. The matching branch step is executed.
 */

import { StepExecutionError } from './errors.js'
import type {
  ConditionalConfig,
  ConditionalStep,
  EnrichableStep,
  PipelineContext,
  StepManifestEnrichment,
  StepResult,
} from './types.js'

export function conditional<TInput, TOutput>(
  name: string,
  config: ConditionalConfig<TInput, TOutput>,
): ConditionalStep<TInput, TOutput> & EnrichableStep<TInput, TOutput> {
  const { router, branches, fallback } = config
  let lastBranch: string | undefined

  // Validate fallback at construction time — fail fast, not at runtime
  if (fallback !== undefined && !(fallback in branches)) {
    throw new Error(
      `conditional("${name}"): fallback "${fallback}" is not a valid branch key (available: ${Object.keys(branches).join(', ')})`,
    )
  }

  return {
    name,
    description: `Conditional: ${Object.keys(branches).join(' | ')}`,
    kind: 'conditional',

    getLastBranch() {
      return lastBranch
    },

    getManifestEnrichment(): StepManifestEnrichment {
      return { branch: lastBranch }
    },

    async execute(input: TInput, ctx: PipelineContext): Promise<StepResult<TOutput>> {
      const startMs = Date.now()
      lastBranch = undefined

      // Determine branch — wrap router call to produce useful error on throw
      let branchKey: string
      try {
        branchKey = router(input)
      } catch (err) {
        throw new StepExecutionError(
          name,
          `Router function threw: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : new Error(String(err)),
          Date.now() - startMs,
          0,
        )
      }

      if (!(branchKey in branches)) {
        if (fallback !== undefined) {
          branchKey = fallback
        } else {
          throw new StepExecutionError(
            name,
            `Router returned unknown branch "${branchKey}" (available: ${Object.keys(branches).join(', ')})`,
            new Error(`Unknown branch: ${branchKey}`),
            Date.now() - startMs,
            0,
          )
        }
      }

      lastBranch = branchKey
      const branch = branches[branchKey]

      // Emit step:start for the selected branch
      ctx.onEvent?.({
        type: 'step:start',
        step: branch.name,
        kind: branch.kind,
        index: 0,
        total: 1,
        timestamp: Date.now(),
      })

      const result = await branch.execute(input, ctx)

      // Emit step:done for the selected branch
      ctx.onEvent?.({
        type: 'step:done',
        step: branch.name,
        kind: branch.kind,
        status: result.status === 'ok' ? 'ok' : 'error',
        error: result.status === 'error' ? result.error : undefined,
        elapsedMs: result.elapsedMs,
        timestamp: Date.now(),
      })

      return {
        ...result,
        elapsedMs: Date.now() - startMs,
      }
    },
  }
}
