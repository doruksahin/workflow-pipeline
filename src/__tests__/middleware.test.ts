/**
 * Tests for withMiddleware() — cross-cutting step wrapper.
 *
 * Covers: before transforms input, after transforms output, onError recovery, stacking order.
 */

import { describe, it, expect, vi } from 'vitest'

import { withMiddleware } from '../middleware.js'
import type { PipelineContext, Step, StepResult } from '../types.js'

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

function errorStep<TInput, TOutput>(name: string, error: string): Step<TInput, TOutput> {
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

describe('withMiddleware()', () => {
  it('calls before and passes transformed input to the step', async () => {
    const inner = okStep<number, number>('double', (n) => n * 2)

    const wrapped = withMiddleware(inner, {
      before: (input) => input + 10,
    })

    const ctx = mockCtx()
    const result = await wrapped.execute(5, ctx)

    expect(result.status).toBe('ok')
    // before: 5 + 10 = 15, then step doubles: 15 * 2 = 30
    expect(result.status === 'ok' && result.output).toBe(30)
  })

  it('calls after on success with transformed output', async () => {
    const inner = okStep<string, string>('upper', (s) => s.toUpperCase())

    const wrapped = withMiddleware(inner, {
      after: (output) => `[${output}]`,
    })

    const ctx = mockCtx()
    const result = await wrapped.execute('hello', ctx)

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' && result.output).toBe('[HELLO]')
  })

  it('calls onError on failure and supports recovery', async () => {
    const inner = errorStep<string, string>('failing', 'something broke')

    const wrapped = withMiddleware(inner, {
      onError: () => ({
        status: 'ok',
        output: 'recovered',
        elapsedMs: 0,
        meta: { model: 'recovery', attempts: 1, promptLength: 0, rawLength: 0 },
      }),
    })

    const ctx = mockCtx()
    const result = await wrapped.execute('input', ctx)

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' && result.output).toBe('recovered')
  })

  it('propagates error when onError returns undefined', async () => {
    const inner = errorStep<string, string>('failing', 'fatal error')

    const wrapped = withMiddleware(inner, {
      onError: () => undefined,
    })

    const ctx = mockCtx()
    const result = await wrapped.execute('input', ctx)

    expect(result.status).toBe('error')
    expect(result.status === 'error' && result.error).toBe('fatal error')
  })

  it('propagates error when no onError is provided', async () => {
    const inner = errorStep<string, string>('failing', 'no handler')

    const wrapped = withMiddleware(inner, {
      before: (input) => input.toUpperCase(),
    })

    const ctx = mockCtx()
    const result = await wrapped.execute('input', ctx)

    expect(result.status).toBe('error')
    expect(result.status === 'error' && result.error).toBe('no handler')
  })

  it('stacking: inner first, outer second (before hooks)', async () => {
    const log: string[] = []
    const inner = okStep<string, string>('identity', (s) => s)

    const withM1 = withMiddleware(inner, {
      before: (input) => {
        log.push('m1-before')
        return `m1(${input})`
      },
      after: (output) => {
        log.push('m1-after')
        return `m1-after(${output})`
      },
    })

    const withM2 = withMiddleware(withM1, {
      before: (input) => {
        log.push('m2-before')
        return `m2(${input})`
      },
      after: (output) => {
        log.push('m2-after')
        return `m2-after(${output})`
      },
    })

    const ctx = mockCtx()
    const result = await withM2.execute('x', ctx)

    // Execution order: m2-before → m1-before → step → m1-after → m2-after
    expect(log).toEqual(['m2-before', 'm1-before', 'm1-after', 'm2-after'])
    expect(result.status).toBe('ok')
    // m2 before: "m2(x)", m1 before: "m1(m2(x))", step identity: "m1(m2(x))"
    // m1 after: "m1-after(m1(m2(x)))", m2 after: "m2-after(m1-after(m1(m2(x))))"
    expect(result.status === 'ok' && result.output).toBe('m2-after(m1-after(m1(m2(x))))')
  })

  it('preserves step name, description, and kind', () => {
    const inner = okStep<string, string>('my-step', (s) => s)
    const wrapped = withMiddleware(inner, { before: (s) => s })

    expect(wrapped.name).toBe('my-step')
    expect(wrapped.description).toBe('Step my-step')
    expect(wrapped.kind).toBe('script')
  })

  it('does not call after when step fails', async () => {
    const afterFn = vi.fn()
    const inner = errorStep<string, string>('failing', 'oops')

    const wrapped = withMiddleware(inner, {
      after: afterFn,
    })

    const ctx = mockCtx()
    await wrapped.execute('input', ctx)

    expect(afterFn).not.toHaveBeenCalled()
  })

  it('returns StepError when before hook throws', async () => {
    const inner = okStep<string, string>('step', (s) => s)

    const wrapped = withMiddleware(inner, {
      before: () => { throw new Error('before exploded') },
    })

    const ctx = mockCtx()
    const result = await wrapped.execute('input', ctx)

    expect(result.status).toBe('error')
    expect(result.status === 'error' && result.error).toContain('Middleware before hook failed')
    expect(result.status === 'error' && result.error).toContain('before exploded')
  })

  it('returns StepError when after hook throws', async () => {
    const inner = okStep<string, string>('step', (s) => s)

    const wrapped = withMiddleware(inner, {
      after: () => { throw new Error('after exploded') },
    })

    const ctx = mockCtx()
    const result = await wrapped.execute('input', ctx)

    expect(result.status).toBe('error')
    expect(result.status === 'error' && result.error).toContain('Middleware after hook failed')
    expect(result.status === 'error' && result.error).toContain('after exploded')
  })

  it('async before/after hooks work', async () => {
    const inner = okStep<number, number>('add-one', (n) => n + 1)

    const wrapped = withMiddleware(inner, {
      before: async (input) => {
        await new Promise((r) => setTimeout(r, 1))
        return input * 2
      },
      after: async (output) => {
        await new Promise((r) => setTimeout(r, 1))
        return output + 100
      },
    })

    const ctx = mockCtx()
    const result = await wrapped.execute(3, ctx)

    // before: 3*2=6, step: 6+1=7, after: 7+100=107
    expect(result.status === 'ok' && result.output).toBe(107)
  })
})
