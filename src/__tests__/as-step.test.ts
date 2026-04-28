/**
 * Tests for asStep() — Pipeline-as-Step adapter.
 *
 * Covers: pipeline runs to completion, abort maps to StepError,
 * substeps in manifest, scoped child context, event propagation.
 */

import { describe, it, expect, vi } from 'vitest'

import { asStep } from '../as-step.js'
import { PipelineBuilder } from '../runner.js'
import { SILENT_LOGGER } from '../types.js'
import type { PipelineContext, PipelineEvent, PipelineRunOptions, Step } from '../types.js'

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

function errorStep<TInput>(name: string, error: string): Step<TInput, never> {
  return {
    name,
    description: `Failing step ${name}`,
    kind: 'script',
    async execute() {
      return {
        status: 'error',
        error,
        elapsedMs: 1,
        retries: 0,
      }
    },
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('asStep()', () => {
  it('runs wrapped pipeline and maps PipelineResult → StepResult', async () => {
    const childPipeline = new PipelineBuilder<number>()
      .step(okStep<number, number>('double', (n) => n * 2))
      .step(okStep<number, string>('stringify', (n) => `result: ${n}`))
      .build('child')

    const step = asStep(childPipeline)
    const ctx = mockCtx()
    const result = await step.execute(5, ctx)

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' && result.output).toBe('result: 10')
  })

  it('maps pipeline abort to StepError with failing substep in message', async () => {
    const childPipeline = new PipelineBuilder<string>()
      .step(okStep<string, string>('first', (s) => s))
      .step(errorStep<string>('failing-step', 'kaboom'))
      .step(okStep<string, string>('unreachable', (s) => s))
      .build('child')

    const step = asStep(childPipeline)
    const ctx = mockCtx()
    const result = await step.execute('input', ctx)

    expect(result.status).toBe('error')
    expect(result.status === 'error' && result.error).toContain('failing-step')
    expect(result.status === 'error' && result.error).toContain('kaboom')
  })

  it('attaches child steps as substeps in parent manifest', async () => {
    const childPipeline = new PipelineBuilder<number>()
      .step(okStep<number, number>('step-a', (n) => n + 1))
      .step(okStep<number, number>('step-b', (n) => n * 3))
      .build('child-pipeline')

    const childStep = asStep(childPipeline)

    // Run child step inside a parent pipeline to get manifest
    const parentPipeline = new PipelineBuilder<number>()
      .step(okStep<number, number>('prepare', (n) => n))
      .step(childStep)
      .build('parent')

    const ctx = mockCtx()
    const result = await parentPipeline.run(10, ctx, silentOptions())

    expect(result.status).toBe('ok')
    const childEntry = result.manifest.steps.find((s) => s.name === 'child-pipeline')
    expect(childEntry).toBeDefined()
    expect(childEntry?.substeps).toHaveLength(2)
    expect(childEntry?.substeps?.[0].name).toBe('step-a')
    expect(childEntry?.substeps?.[1].name).toBe('step-b')
  })

  it('creates scoped child context (no fixture pollution)', async () => {
    let capturedFixtureDir: string | undefined

    const spyStep: Step<string, string> = {
      name: 'spy',
      description: 'captures ctx',
      kind: 'script',
      async execute(input, ctx) {
        capturedFixtureDir = ctx.fixtureDir
        return { status: 'ok', output: input, elapsedMs: 1, meta: { model: 'test', attempts: 1, promptLength: 0, rawLength: 0 } }
      },
    }

    const childPipeline = new PipelineBuilder<string>().step(spyStep).build('child-scoped')
    const step = asStep(childPipeline, { fixtureSubdir: 'my-subdir' })

    const ctx = mockCtx({ fixtureDir: '/parent/fixtures' })
    await step.execute('x', ctx)

    expect(capturedFixtureDir).toBe('/parent/fixtures/my-subdir')
  })

  it('defaults fixture subdir to pipeline name', async () => {
    let capturedFixtureDir: string | undefined

    const spyStep: Step<string, string> = {
      name: 'spy',
      description: 'captures ctx',
      kind: 'script',
      async execute(input, ctx) {
        capturedFixtureDir = ctx.fixtureDir
        return { status: 'ok', output: input, elapsedMs: 1, meta: { model: 'test', attempts: 1, promptLength: 0, rawLength: 0 } }
      },
    }

    const childPipeline = new PipelineBuilder<string>().step(spyStep).build('my-child')
    const step = asStep(childPipeline)

    const ctx = mockCtx({ fixtureDir: '/base' })
    await step.execute('x', ctx)

    expect(capturedFixtureDir).toBe('/base/my-child')
  })

  it('propagates child events through parent onEvent', async () => {
    const events: PipelineEvent[] = []

    const childPipeline = new PipelineBuilder<string>()
      .step(okStep<string, string>('inner', (s) => s))
      .build('child')

    const step = asStep(childPipeline)
    const ctx = mockCtx({ onEvent: (e) => events.push(e) })
    await step.execute('data', ctx)

    // Child pipeline emits pipeline:start, step:start, step:done, pipeline:done
    const stepStartEvents = events.filter((e) => e.type === 'step:start')
    const pipelineStartEvents = events.filter((e) => e.type === 'pipeline:start')

    expect(pipelineStartEvents.length).toBeGreaterThanOrEqual(1)
    expect(stepStartEvents.length).toBeGreaterThanOrEqual(1)
    expect(stepStartEvents.some((e) => e.type === 'step:start' && e.step === 'inner')).toBe(true)
  })

  it('has kind "pipeline"', () => {
    const childPipeline = new PipelineBuilder<string>()
      .step(okStep<string, string>('x', (s) => s))
      .build('child')

    const step = asStep(childPipeline)
    expect(step.kind).toBe('pipeline')
  })

  it('getSubsteps() returns undefined before execution', () => {
    const childPipeline = new PipelineBuilder<string>()
      .step(okStep<string, string>('x', (s) => s))
      .build('child')

    const step = asStep(childPipeline)
    expect(step.getSubsteps()).toBeUndefined()
  })

  it('getSubsteps() includes error info on abort', async () => {
    const childPipeline = new PipelineBuilder<string>()
      .step(okStep<string, string>('ok-step', (s) => s))
      .step(errorStep<string>('bad-step', 'fail!'))
      .build('child')

    const step = asStep(childPipeline)
    const ctx = mockCtx()
    await step.execute('x', ctx)

    const substeps = step.getSubsteps()
    expect(substeps).toHaveLength(2) // ok-step (ok), bad-step (error)
    expect(substeps?.[1].status).toBe('error')
    expect(substeps?.[1].error).toBe('fail!')
  })
})
