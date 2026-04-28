/**
 * Tests for conditional() — router-based branch selection.
 *
 * Covers: correct routing, unknown key error, fallback, manifest branch field, events.
 */

import { describe, it, expect, vi } from 'vitest'

import { conditional } from '../conditional.js'
import { StepExecutionError } from '../errors.js'
import { PipelineBuilder } from '../runner.js'
import { SILENT_LOGGER } from '../types.js'
import type { PipelineContext, PipelineEvent, PipelineRunOptions, Step, StepResult } from '../types.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockCtx(overrides?: Partial<PipelineContext>): PipelineContext {
  return {
    runId: 'test-run',
    fixtureDir: '/tmp/test-fixtures',
    saveFixtures: false,
    logger: null,
    ...overrides,
  }
}

function silentOptions(overrides?: Partial<PipelineRunOptions>): PipelineRunOptions {
  return {
    onEvent: () => {},
    heartbeatIntervalMs: 0,
    resumeFrom: null,
    pipelineLogger: SILENT_LOGGER,
    ...overrides,
  }
}

function okStep<TInput, TOutput>(name: string, transform: (input: TInput) => TOutput): Step<TInput, TOutput> {
  return {
    name,
    description: `Step ${name}`,
    kind: 'script',
    async execute(input) {
      return {
        status: 'ok',
        output: transform(input),
        elapsedMs: 1,
        meta: { model: 'test', attempts: 1, promptLength: 0, rawLength: 0 },
      }
    },
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('conditional()', () => {
  it('routes to correct branch based on router return value', async () => {
    const step = conditional<{ type: string; value: number }, string>('route', {
      router: (input) => input.type,
      branches: {
        add: okStep('add-branch', (input) => `added-${input.value}`),
        multiply: okStep('multiply-branch', (input) => `multiplied-${input.value}`),
      },
    })

    const ctx = mockCtx()
    const result = await step.execute({ type: 'add', value: 5 }, ctx)

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' && result.output).toBe('added-5')
  })

  it('throws StepExecutionError for unknown key without fallback', async () => {
    const step = conditional<string, string>('route', {
      router: () => 'unknown',
      branches: {
        a: okStep('a', (x) => x),
        b: okStep('b', (x) => x),
      },
    })

    const ctx = mockCtx()
    await expect(step.execute('input', ctx)).rejects.toThrow(StepExecutionError)
    await expect(step.execute('input', ctx)).rejects.toThrow(/unknown branch "unknown"/)
  })

  it('uses fallback branch for unknown key when fallback is set', async () => {
    const step = conditional<string, string>('route', {
      router: () => 'nonexistent',
      branches: {
        a: okStep('a', () => 'branch-a'),
        default: okStep('default', () => 'fallback-result'),
      },
      fallback: 'default',
    })

    const ctx = mockCtx()
    const result = await step.execute('input', ctx)

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' && result.output).toBe('fallback-result')
    expect(step.getLastBranch()).toBe('default')
  })

  it('manifest entry includes branch field via getLastBranch()', async () => {
    const step = conditional<string, string>('route', {
      router: (input) => input,
      branches: {
        alpha: okStep('alpha', () => 'alpha-out'),
        beta: okStep('beta', () => 'beta-out'),
      },
    })

    const ctx = mockCtx()
    await step.execute('beta', ctx)

    expect(step.getLastBranch()).toBe('beta')
  })

  it('manifest entry includes branch field when run in pipeline', async () => {
    const condStep = conditional<string, string>('route', {
      router: (input) => input,
      branches: {
        alpha: okStep('alpha', () => 'alpha-out'),
        beta: okStep('beta', () => 'beta-out'),
      },
    })

    const pipeline = new PipelineBuilder<string>().step(condStep).build('test-pipeline')

    const ctx = mockCtx()
    const result = await pipeline.run('alpha', ctx, silentOptions())

    expect(result.status).toBe('ok')
    const routeEntry = result.manifest.steps.find((s) => s.name === 'route')
    expect(routeEntry?.branch).toBe('alpha')
  })

  it('emits events for both wrapper and selected branch', async () => {
    const events: PipelineEvent[] = []
    const ctx = mockCtx({ onEvent: (e) => events.push(e) })

    const step = conditional<string, string>('route', {
      router: () => 'target',
      branches: {
        target: okStep('target-step', () => 'result'),
      },
    })

    await step.execute('input', ctx)

    const startEvents = events.filter((e) => e.type === 'step:start')
    const doneEvents = events.filter((e) => e.type === 'step:done')

    // Should emit start/done for the selected branch
    expect(startEvents).toHaveLength(1)
    expect(startEvents[0].type === 'step:start' && startEvents[0].step).toBe('target-step')
    expect(doneEvents).toHaveLength(1)
    expect(doneEvents[0].type === 'step:done' && doneEvents[0].step).toBe('target-step')
  })

  it('has kind "conditional"', () => {
    const step = conditional<string, string>('route', {
      router: () => 'a',
      branches: { a: okStep('a', (x) => x) },
    })

    expect(step.kind).toBe('conditional')
  })

  it('throws StepExecutionError when router function throws', async () => {
    const step = conditional<string, string>('route', {
      router: () => { throw new Error('router exploded') },
      branches: {
        a: okStep('a', (x) => x),
      },
    })

    const ctx = mockCtx()
    await expect(step.execute('input', ctx)).rejects.toThrow(StepExecutionError)
    await expect(step.execute('input', ctx)).rejects.toThrow(/Router function threw/)
    await expect(step.execute('input', ctx)).rejects.toThrow(/router exploded/)
  })

  it('throws at construction time when fallback key is not in branches', () => {
    expect(() =>
      conditional<string, string>('route', {
        router: () => 'a',
        branches: { a: okStep('a', (x) => x) },
        fallback: 'nonexistent',
      }),
    ).toThrow(/fallback "nonexistent" is not a valid branch key/)
  })

  it('resets lastBranch between executions', async () => {
    const step = conditional<string, string>('route', {
      router: (input) => input,
      branches: {
        a: okStep('a', () => 'a'),
        b: okStep('b', () => 'b'),
      },
    })

    const ctx = mockCtx()

    await step.execute('a', ctx)
    expect(step.getLastBranch()).toBe('a')

    await step.execute('b', ctx)
    expect(step.getLastBranch()).toBe('b')
  })
})
