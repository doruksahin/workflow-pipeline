/**
 * Tests for createLlmStep and createScriptStep factories.
 *
 * Covers: required fields on StepOk/StepError, safe error stringify,
 * fixture write protection, retry with onRetry, StepMeta population.
 */

import { describe, it, expect, vi } from 'vitest'

import { createLlmStep, createScriptStep } from '../factory.js'
import type { LlmCaller, LlmStepConfig, PipelineContext, ScriptStepConfig } from '../types.js'
import { DEFAULT_RETRY } from '../constants.js'

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

function mockCaller(raw = '{"result": "ok"}'): LlmCaller {
  return vi.fn(async () => ({ raw, elapsedMs: 100, stderr: '' }))
}

function failingCaller(error: unknown): LlmCaller {
  return vi.fn(async () => {
    throw error
  })
}

function baseLlmConfig<TInput, TOutput>(
  overrides?: Partial<LlmStepConfig<TInput, TOutput>>,
): LlmStepConfig<TInput, TOutput> {
  return {
    name: 'test-llm',
    description: 'Test LLM step',
    model: 'test-model',
    retry: { ...DEFAULT_RETRY, maxRetries: 0 },
    caller: mockCaller(),
    promptAssembler: () => 'test prompt',
    parser: (raw) => ({ result: JSON.parse(raw) as TOutput, errors: [] }),
    label: 'test-llm',
    onRetry: vi.fn(),
    ...overrides,
  } as LlmStepConfig<TInput, TOutput>
}

// ── createScriptStep ────────────────────────────────────────────────────────

describe('createScriptStep', () => {
  it('returns StepOk with all required fields on success', async () => {
    const step = createScriptStep<string, number>({
      name: 'count',
      description: 'Count characters',
      transform: (input) => input.length,
    })

    const result = await step.execute('hello', mockCtx())

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('Expected ok')
    expect(result.output).toBe(5)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(result.meta).toEqual({
      model: 'script',
      attempts: 1,
      promptLength: 0,
      rawLength: 0,
    })
  })

  it('returns StepError with all required fields on failure', async () => {
    const step = createScriptStep<string, number>({
      name: 'fail',
      description: 'Always fails',
      transform: () => {
        throw new Error('boom')
      },
    })

    const result = await step.execute('x', mockCtx())

    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('Expected error')
    expect(result.error).toBe('boom')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(result.retries).toBe(0)
  })

  it('handles non-Error throws via String()', async () => {
    const step = createScriptStep<string, number>({
      name: 'string-throw',
      description: 'Throws a string',
      transform: () => {
        throw 'just a string'
      },
    })

    const result = await step.execute('x', mockCtx())

    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('Expected error')
    expect(result.error).toBe('just a string')
  })

  it('handles null/undefined throws', async () => {
    const step = createScriptStep<string, number>({
      name: 'null-throw',
      description: 'Throws null',
      transform: () => {
        throw null
      },
    })

    const result = await step.execute('x', mockCtx())

    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('Expected error')
    expect(result.error).toBe('null')
  })

  it('has kind: script', () => {
    const step = createScriptStep<string, string>({
      name: 'identity',
      description: 'Identity transform',
      transform: (x) => x,
    })

    expect(step.kind).toBe('script')
  })
})

// ── createLlmStep ───────────────────────────────────────────────────────────

describe('createLlmStep', () => {
  it('returns StepOk with meta on success', async () => {
    const step = createLlmStep<string, { result: string }>(
      baseLlmConfig({
        caller: mockCaller('{"result": "ok"}'),
        promptAssembler: (input) => `Process: ${input}`,
        parser: (raw) => ({ result: JSON.parse(raw), errors: [] }),
      }),
    )

    const result = await step.execute('test input', mockCtx())

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('Expected ok')
    expect(result.output).toEqual({ result: 'ok' })
    expect(result.meta.model).toBe('test-model')
    expect(result.meta.attempts).toBe(1)
    expect(result.meta.promptLength).toBeGreaterThan(0)
    expect(result.meta.rawLength).toBeGreaterThan(0)
  })

  it('returns StepError with retries on LLM call failure', async () => {
    const step = createLlmStep<string, unknown>(
      baseLlmConfig({
        caller: failingCaller(new Error('LLM timeout')),
      }),
    )

    const result = await step.execute('x', mockCtx())

    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('Expected error')
    expect(result.error).toBe('LLM timeout')
    expect(result.retries).toBe(0) // first attempt, no retries
  })

  it('handles non-Error throws from LLM caller', async () => {
    const step = createLlmStep<string, unknown>(
      baseLlmConfig({
        caller: failingCaller({ code: 'WEIRD' }),
      }),
    )

    const result = await step.execute('x', mockCtx())

    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('Expected error')
    expect(result.error).toBe('[object Object]')
  })

  it('retries on parse errors and calls onRetry', async () => {
    let callCount = 0
    const onRetry = vi.fn()

    const step = createLlmStep<string, { value: number }>(
      baseLlmConfig({
        retry: { maxRetries: 2, baseDelayMs: 1, backoffMultiplier: 1, retryOnParseError: true },
        caller: vi.fn(async () => {
          callCount++
          return { raw: callCount >= 3 ? '{"value": 42}' : 'invalid', elapsedMs: 50, stderr: '' }
        }),
        parser: (raw) => {
          try {
            const parsed = JSON.parse(raw) as { value: number }
            return { result: parsed, errors: [] }
          } catch {
            return { result: { value: 0 } as { value: number }, errors: ['Invalid JSON'] }
          }
        },
        onRetry,
      }),
    )

    const result = await step.execute('x', mockCtx())

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('Expected ok')
    expect(result.output.value).toBe(42)
    expect(result.meta.attempts).toBe(3)
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledWith(1, 3, ['Invalid JSON'], expect.any(Number))
    expect(onRetry).toHaveBeenCalledWith(2, 3, ['Invalid JSON'], expect.any(Number))
  })

  it('returns retries count when all attempts exhausted', async () => {
    const step = createLlmStep<string, unknown>(
      baseLlmConfig({
        retry: { maxRetries: 2, baseDelayMs: 1, backoffMultiplier: 1, retryOnParseError: true },
        caller: mockCaller('not json'),
        parser: () => ({ result: null, errors: ['bad'] }),
      }),
    )

    const result = await step.execute('x', mockCtx())

    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('Expected error')
    expect(result.retries).toBe(2)
    expect(result.error).toContain('Parse failed after 3 attempt(s)')
  })

  it('uses label in caller invocation', async () => {
    const caller = mockCaller('{}')

    const step = createLlmStep<string, unknown>(
      baseLlmConfig({
        caller,
        label: 'my-custom-label',
        parser: (raw) => ({ result: JSON.parse(raw), errors: [] }),
      }),
    )

    await step.execute('x', mockCtx())

    expect(caller).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('my-custom-label'),
    )
  })

  it('has kind: llm', () => {
    const step = createLlmStep<string, unknown>(baseLlmConfig())
    expect(step.kind).toBe('llm')
  })
})
