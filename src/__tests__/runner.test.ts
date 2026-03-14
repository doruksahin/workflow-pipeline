/**
 * Tests for PipelineBuilder and parallel().
 *
 * Covers: required PipelineRunOptions, step.execute() try/catch,
 * manifest required fields, parallel branch identity, events,
 * heartbeat cleanup, fixture write protection, resume.
 */

import { describe, it, expect, vi } from 'vitest'

import { PipelineBuilder, parallel } from '../runner.js'
import { SILENT_LOGGER } from '../types.js'
import type { PipelineContext, PipelineRunOptions, Step, StepResult } from '../types.js'

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

function throwingStep<TInput>(name: string, error: unknown): Step<TInput, never> {
  return {
    name,
    description: `Throwing step ${name}`,
    kind: 'script',
    async execute() {
      throw error
    },
  }
}

// ── PipelineBuilder ─────────────────────────────────────────────────────────

describe('PipelineBuilder', () => {
  it('runs a single-step pipeline', async () => {
    const pipeline = new PipelineBuilder<string>()
      .step(okStep('double', (s: string) => s + s))
      .build('test')

    const result = await pipeline.run('hi', mockCtx(), silentOptions())

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('Expected ok')
    expect(result.output).toBe('hihi')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('chains multiple steps', async () => {
    const pipeline = new PipelineBuilder<number>()
      .step(okStep('add-one', (n: number) => n + 1))
      .step(okStep('double', (n: number) => n * 2))
      .step(okStep('to-string', (n: number) => String(n)))
      .build('chain')

    const result = await pipeline.run(5, mockCtx(), silentOptions())

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('Expected ok')
    expect(result.output).toBe('12') // (5 + 1) * 2 = 12
  })

  it('aborts on step error with complete manifest', async () => {
    const pipeline = new PipelineBuilder<string>()
      .step(okStep('first', (s: string) => s.length))
      .step(errorStep('second', 'something broke'))
      .step(okStep('third', (n: number) => n * 2))
      .build('abort-test')

    const result = await pipeline.run('hello', mockCtx(), silentOptions())

    expect(result.status).toBe('aborted')
    expect(result.manifest.status).toBe('aborted')
    expect(result.manifest.steps).toHaveLength(3)

    // First step: ok
    expect(result.manifest.steps[0].status).toBe('ok')
    expect(result.manifest.steps[0].retries).toBe(0)
    expect(result.manifest.steps[0].error).toBe('')

    // Second step: error — all fields required
    expect(result.manifest.steps[1].status).toBe('error')
    expect(result.manifest.steps[1].error).toBe('something broke')
    expect(result.manifest.steps[1].retries).toBe(0)

    // Third step: skipped
    expect(result.manifest.steps[2].status).toBe('skipped')
    expect(result.manifest.steps[2].retries).toBe(0)
    expect(result.manifest.steps[2].error).toBe('')
  })

  it('catches step that throws unexpectedly', async () => {
    const pipeline = new PipelineBuilder<string>()
      .step(throwingStep('exploder', new Error('kaboom')))
      .build('throw-test')

    const result = await pipeline.run('x', mockCtx(), silentOptions())

    expect(result.status).toBe('aborted')
    expect(result.manifest.steps[0].status).toBe('error')
    expect(result.manifest.steps[0].error).toContain('threw unexpectedly')
    expect(result.manifest.steps[0].error).toContain('kaboom')
  })

  it('catches non-Error throws from step.execute()', async () => {
    const pipeline = new PipelineBuilder<string>()
      .step(throwingStep('string-thrower', 'just a string'))
      .build('non-error-throw')

    const result = await pipeline.run('x', mockCtx(), silentOptions())

    expect(result.status).toBe('aborted')
    expect(result.manifest.steps[0].error).toContain('just a string')
  })
})

// ── Events ──────────────────────────────────────────────────────────────────

describe('Pipeline Events', () => {
  it('emits pipeline:start and pipeline:done on success', async () => {
    const events: string[] = []
    const pipeline = new PipelineBuilder<string>()
      .step(okStep('noop', (s: string) => s))
      .build('events-test')

    await pipeline.run('x', mockCtx(), silentOptions({
      onEvent: (e) => events.push(e.type),
    }))

    expect(events[0]).toBe('pipeline:start')
    expect(events[events.length - 1]).toBe('pipeline:done')
  })

  it('emits step:start and step:done for each step', async () => {
    const events: string[] = []
    const pipeline = new PipelineBuilder<string>()
      .step(okStep('a', (s: string) => s))
      .step(okStep('b', (s: string) => s))
      .build('step-events')

    await pipeline.run('x', mockCtx(), silentOptions({
      onEvent: (e) => events.push(`${e.type}:${'step' in e ? e.step : ''}`),
    }))

    expect(events).toContain('step:start:a')
    expect(events).toContain('step:done:a')
    expect(events).toContain('step:start:b')
    expect(events).toContain('step:done:b')
  })

  it('emits step:done with error status on failure', async () => {
    const doneEvents: Array<{ step: string; status: string }> = []
    const pipeline = new PipelineBuilder<string>()
      .step(errorStep('fail', 'bad'))
      .build('error-event')

    await pipeline.run('x', mockCtx(), silentOptions({
      onEvent: (e) => {
        if (e.type === 'step:done') doneEvents.push({ step: e.step, status: e.status })
      },
    }))

    expect(doneEvents).toEqual([{ step: 'fail', status: 'error' }])
  })
})

// ── Resume ──────────────────────────────────────────────────────────────────

describe('Resume', () => {
  it('skips steps before resumeFrom', async () => {
    const executed: string[] = []

    const trackStep = (name: string): Step<unknown, unknown> => ({
      name,
      description: name,
      kind: 'script',
      async execute(input) {
        executed.push(name)
        return { status: 'ok', output: input, elapsedMs: 1, meta: { model: 'test', attempts: 1, promptLength: 0, rawLength: 0 } }
      },
    })

    const pipeline = new PipelineBuilder<string>()
      .step(trackStep('a'))
      .step(trackStep('b'))
      .step(trackStep('c'))
      .build('resume-test')

    const result = await pipeline.run('x', mockCtx(), silentOptions({ resumeFrom: 'b' }))

    expect(result.status).toBe('ok')
    expect(executed).toEqual(['b', 'c'])
    expect(result.manifest.steps[0].status).toBe('skipped')
    expect(result.manifest.steps[1].status).toBe('ok')
    expect(result.manifest.steps[2].status).toBe('ok')
  })

  it('throws on invalid resumeFrom step name', async () => {
    const pipeline = new PipelineBuilder<string>()
      .step(okStep('a', (s: string) => s))
      .build('bad-resume')

    await expect(
      pipeline.run('x', mockCtx(), silentOptions({ resumeFrom: 'nonexistent' })),
    ).rejects.toThrow('resumeFrom step "nonexistent" not found')
  })
})

// ── Heartbeat ───────────────────────────────────────────────────────────────

describe('Heartbeat', () => {
  it('emits heartbeat events during slow steps', async () => {
    const heartbeats: number[] = []

    const slowStep: Step<string, string> = {
      name: 'slow',
      description: 'Slow step',
      kind: 'script',
      async execute(input) {
        await new Promise((r) => setTimeout(r, 150))
        return { status: 'ok', output: input, elapsedMs: 150, meta: { model: 'test', attempts: 1, promptLength: 0, rawLength: 0 } }
      },
    }

    const pipeline = new PipelineBuilder<string>()
      .step(slowStep)
      .build('heartbeat-test')

    await pipeline.run('x', mockCtx(), silentOptions({
      heartbeatIntervalMs: 50,
      onEvent: (e) => {
        if (e.type === 'step:heartbeat') heartbeats.push(e.elapsedMs)
      },
    }))

    expect(heartbeats.length).toBeGreaterThanOrEqual(1)
  })

  it('cleans up heartbeat on step failure', async () => {
    const heartbeats: number[] = []

    const failAfterDelay: Step<string, string> = {
      name: 'fail-slow',
      description: 'Fails after delay',
      kind: 'script',
      async execute() {
        await new Promise((r) => setTimeout(r, 80))
        return { status: 'error', error: 'delayed fail', elapsedMs: 80, retries: 0 }
      },
    }

    const pipeline = new PipelineBuilder<string>()
      .step(failAfterDelay)
      .build('heartbeat-cleanup')

    await pipeline.run('x', mockCtx(), silentOptions({
      heartbeatIntervalMs: 30,
      onEvent: (e) => {
        if (e.type === 'step:heartbeat') heartbeats.push(e.elapsedMs)
      },
    }))

    const countAfter = heartbeats.length
    // Wait to verify no more heartbeats arrive after step completes
    await new Promise((r) => setTimeout(r, 100))
    expect(heartbeats.length).toBe(countAfter)
  })

  it('cleans up heartbeat when step throws', async () => {
    const heartbeats: number[] = []

    const throwAfterDelay: Step<string, string> = {
      name: 'throw-slow',
      description: 'Throws after delay',
      kind: 'script',
      async execute() {
        await new Promise((r) => setTimeout(r, 80))
        throw new Error('kaboom')
      },
    }

    const pipeline = new PipelineBuilder<string>()
      .step(throwAfterDelay)
      .build('heartbeat-throw-cleanup')

    await pipeline.run('x', mockCtx(), silentOptions({
      heartbeatIntervalMs: 30,
      onEvent: (e) => {
        if (e.type === 'step:heartbeat') heartbeats.push(e.elapsedMs)
      },
    }))

    const countAfter = heartbeats.length
    await new Promise((r) => setTimeout(r, 100))
    expect(heartbeats.length).toBe(countAfter)
  })
})

// ── Parallel ────────────────────────────────────────────────────────────────

describe('parallel', () => {
  it('runs branches concurrently and returns named record', async () => {
    const step = parallel('both', {
      double: okStep('double', (n: number) => n * 2),
      triple: okStep('triple', (n: number) => n * 3),
    })

    const result = await step.execute(5, mockCtx())

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('Expected ok')
    expect(result.output).toEqual({ double: 10, triple: 15 })
  })

  it('has kind: parallel', () => {
    const step = parallel('p', {
      a: okStep('a', (x: string) => x),
    })
    expect(step.kind).toBe('parallel')
  })

  it('collects ALL branch errors with correct identity', async () => {
    const step = parallel('multi-fail', {
      alpha: errorStep('alpha', 'alpha broke'),
      beta: okStep('beta', (x: string) => x),
      gamma: errorStep('gamma', 'gamma broke'),
    })

    const result = await step.execute('x', mockCtx())

    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('Expected error')
    expect(result.error).toContain('alpha')
    expect(result.error).toContain('gamma')
    expect(result.error).toContain('2 parallel branch(es) failed')
    expect(result.retries).toBe(0)
  })

  it('preserves branch identity when step throws (not returns error)', async () => {
    const step = parallel('throw-branches', {
      good: okStep('good', (x: string) => x),
      bad: throwingStep('bad', new Error('thrown!')),
    })

    const result = await step.execute('x', mockCtx())

    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('Expected error')
    // Branch identity should be 'bad', not '(unknown)'
    expect(result.error).toContain('bad')
    expect(result.error).not.toContain('(unknown)')
  })

  it('handles non-Error throws in parallel branches', async () => {
    const step = parallel('string-throw-branch', {
      a: throwingStep('a', 'just a string'),
    })

    const result = await step.execute('x', mockCtx())

    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('Expected error')
    expect(result.error).toContain('just a string')
  })

  it('returns ParallelStepError with branchErrors map', async () => {
    const step = parallel('branch-map', {
      x: errorStep('x', 'x failed'),
      y: errorStep('y', 'y failed'),
    })

    const result = await step.execute('input', mockCtx()) as { branchErrors?: ReadonlyMap<string, Error> }

    expect(result).toHaveProperty('branchErrors')
    expect(result.branchErrors).toBeInstanceOf(Map)
    expect(result.branchErrors!.size).toBe(2)
    expect(result.branchErrors!.get('x')!.message).toBe('x failed')
    expect(result.branchErrors!.get('y')!.message).toBe('y failed')
  })
})
