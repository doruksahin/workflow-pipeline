/**
 * Lock-in tests for the p-retry-backed retry loop in createLlmStep.
 *
 * These tests prevent future drift after the p-retry swap (ADR-0001, SPEC-001).
 * Two kinds:
 *   1. Property test via fast-check — invariant that caller is invoked
 *      between 1 and maxRetries+1 times across all random failure patterns.
 *   2. Snapshot test — deterministic fail-then-succeed sequence pins the
 *      resulting StepResult shape and onRetry invocation log.
 */

import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'

import { createLlmStep } from '../factory.js'
import type { LlmCaller, LlmStepConfig, PipelineContext } from '../types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockCtx(): PipelineContext {
  return {
    runId: 'lockin-test',
    fixtureDir: '/tmp/lockin-fixtures',
    saveFixtures: false,
    logger: null,
  }
}

function baseLlmConfig<TInput, TOutput>(
  overrides?: Partial<LlmStepConfig<TInput, TOutput>>,
): LlmStepConfig<TInput, TOutput> {
  return {
    name: 'lockin-step',
    description: 'Lock-in test step',
    model: 'test-model',
    retry: { maxRetries: 0, baseDelayMs: 1, backoffMultiplier: 2, retryOnParseError: true },
    caller: vi.fn(async () => ({ raw: 'ok', elapsedMs: 1, stderr: '' })),
    promptAssembler: () => 'prompt',
    parser: () => ({ result: 'ok' as unknown as TOutput, errors: [] }),
    label: 'lockin-label',
    onRetry: vi.fn(),
    ...overrides,
  } as LlmStepConfig<TInput, TOutput>
}

// ── Property test ─────────────────────────────────────────────────────────────

describe('retry lock-in: property tests', () => {
  it('caller invoked between 1 and maxRetries+1 times across random failure patterns', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }), // maxRetries
        fc.integer({ min: 0, max: 7 }), // failuresBeforeSuccess
        async (maxRetries, failuresBeforeSuccess) => {
          let attempts = 0

          const caller: LlmCaller = async () => {
            attempts++
            // After exhausting failures, the caller succeeds
            if (attempts <= failuresBeforeSuccess) {
              return { raw: 'bad', elapsedMs: 1, stderr: '' }
            }
            return { raw: 'ok', elapsedMs: 1, stderr: '' }
          }

          const step = createLlmStep<string, string>(
            baseLlmConfig({
              retry: { maxRetries, baseDelayMs: 1, backoffMultiplier: 1, retryOnParseError: true },
              caller,
              parser: (raw) =>
                raw === 'ok'
                  ? { result: 'success', errors: [] }
                  : { result: '', errors: ['bad output'] },
              onRetry: vi.fn(),
            }),
          )

          attempts = 0
          await step.execute('x', mockCtx())

          // Invariant: caller is always invoked between 1 and maxRetries+1 times
          expect(attempts).toBeGreaterThanOrEqual(1)
          expect(attempts).toBeLessThanOrEqual(maxRetries + 1)
        },
      ),
      { numRuns: 200, seed: 42 },
    )
  })
})

// ── Snapshot test ─────────────────────────────────────────────────────────────

describe('retry lock-in: snapshot tests', () => {
  it('fail-then-succeed: StepResult shape and onRetry invocation log match snapshot', async () => {
    // Fixed config: maxRetries=2, fail twice, succeed on attempt 3
    const maxRetries = 2
    const onRetryLog: Array<{ attempt: number; maxAttempts: number; errors: string[]; delayMs: number }> = []

    let callCount = 0
    const step = createLlmStep<string, { value: number }>(
      baseLlmConfig({
        name: 'snapshot-step',
        model: 'snap-model',
        retry: { maxRetries, baseDelayMs: 10, backoffMultiplier: 2, retryOnParseError: true },
        caller: vi.fn(async () => {
          callCount++
          return {
            raw: callCount >= 3 ? '{"value":42}' : 'NOT_JSON',
            elapsedMs: 5,
            stderr: '',
          }
        }),
        promptAssembler: () => 'snap prompt',
        parser: (raw) => {
          try {
            return { result: JSON.parse(raw) as { value: number }, errors: [] }
          } catch {
            return { result: { value: 0 }, errors: ['invalid json'] }
          }
        },
        label: 'snap-label',
        onRetry: vi.fn((attempt, maxAttempts, errors, delayMs) => {
          onRetryLog.push({ attempt, maxAttempts, errors, delayMs })
        }),
      }),
    )

    const result = await step.execute('snap-input', mockCtx())

    // Snapshot the StepResult shape
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('Expected ok')

    // Snapshot: meta fields (elapsedMs is non-deterministic — omit from snapshot)
    expect(result.meta.model).toBe('snap-model')
    expect(result.meta.attempts).toBe(3)
    expect(result.meta.promptLength).toBe('snap prompt'.length)
    expect(result.meta.rawLength).toBe('{"value":42}'.length)
    expect(result.output).toEqual({ value: 42 })

    // Snapshot: onRetry invocation log
    // p-retry calls onFailedAttempt maxRetries+1 times (including final exhausted attempt),
    // but this test succeeds on attempt 3 — so onRetry is called exactly twice (attempts 1 and 2).
    expect(onRetryLog).toHaveLength(2)
    expect(onRetryLog[0]).toMatchObject({
      attempt: 1,
      maxAttempts: maxRetries + 1,
      errors: ['invalid json'],
    })
    expect(onRetryLog[0]!.delayMs).toBeGreaterThan(0)
    expect(onRetryLog[1]).toMatchObject({
      attempt: 2,
      maxAttempts: maxRetries + 1,
      errors: ['invalid json'],
    })
    expect(onRetryLog[1]!.delayMs).toBeGreaterThan(0)
  })

  it('all-fail: StepResult is error with correct retries count and error message', async () => {
    const maxRetries = 2

    const step = createLlmStep<string, { v: number }>(
      baseLlmConfig({
        retry: { maxRetries, baseDelayMs: 1, backoffMultiplier: 2, retryOnParseError: true },
        caller: vi.fn(async () => ({ raw: 'bad', elapsedMs: 1, stderr: '' })),
        parser: () => ({ result: { v: 0 }, errors: ['schema error'] }),
        onRetry: vi.fn(),
      }),
    )

    const result = await step.execute('x', mockCtx())

    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('Expected error')
    expect(result.retries).toBe(maxRetries)
    expect(result.error).toContain('schema error')
    expect(result.error).toContain(`${maxRetries + 1} attempt`)
  })
})
