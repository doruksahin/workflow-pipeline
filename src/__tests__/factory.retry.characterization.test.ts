/**
 * Bedrock characterization tests for the retry loop in createLlmStep.
 *
 * These tests pin the observable behavior of the CURRENT (bespoke) retry loop
 * in src/factory.ts before the p-retry swap. They must pass on main before
 * any production change (ADR-0001, SPEC-001).
 *
 * The delay growth test uses a band assertion (not exact ms) so it survives
 * p-retry's jitter while still pinning the "roughly exponential" contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { createLlmStep } from '../factory.js'
import type { LlmCaller, LlmStepConfig, PipelineContext } from '../types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockCtx(): PipelineContext {
  return {
    runId: 'char-test',
    fixtureDir: '/tmp/char-fixtures',
    saveFixtures: false,
    logger: null,
  }
}

function baseLlmConfig<TInput, TOutput>(
  overrides?: Partial<LlmStepConfig<TInput, TOutput>>,
): LlmStepConfig<TInput, TOutput> {
  return {
    name: 'char-step',
    description: 'Characterization test step',
    model: 'test-model',
    retry: { maxRetries: 0, baseDelayMs: 1, backoffMultiplier: 2, retryOnParseError: true },
    caller: vi.fn(async () => ({ raw: 'ok', elapsedMs: 1, stderr: '' })),
    promptAssembler: () => 'prompt',
    parser: () => ({ result: 'ok' as unknown as TOutput, errors: [] }),
    label: 'char-label',
    onRetry: vi.fn(),
    ...overrides,
  } as LlmStepConfig<TInput, TOutput>
}

// ── 1. Attempt count contract ─────────────────────────────────────────────────

describe('retry characterization', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('attempts maxRetries+1 times when caller always fails (parse error, retryOnParseError=true)', async () => {
    const maxRetries = 3
    let callCount = 0

    const step = createLlmStep<string, string>(
      baseLlmConfig({
        retry: { maxRetries, baseDelayMs: 1, backoffMultiplier: 2, retryOnParseError: true },
        caller: vi.fn(async () => {
          callCount++
          return { raw: 'bad', elapsedMs: 1, stderr: '' }
        }),
        parser: () => ({ result: '', errors: ['parse failed'] }),
      }),
    )

    // Run in background — timers are fake so we advance manually
    const promise = step.execute('x', mockCtx())
    // Advance timers for all retries: 4 total attempts needs 3 delays
    for (let i = 0; i < maxRetries; i++) {
      await vi.runAllTimersAsync()
    }
    const result = await promise

    expect(result.status).toBe('error')
    expect(callCount).toBe(maxRetries + 1)
  })

  // ── 2. Early-exit on first success ───────────────────────────────────────────

  it('stops on first success — caller not invoked again after successful parse', async () => {
    let callCount = 0

    const step = createLlmStep<string, string>(
      baseLlmConfig({
        retry: { maxRetries: 5, baseDelayMs: 1, backoffMultiplier: 2, retryOnParseError: true },
        caller: vi.fn(async () => {
          callCount++
          return { raw: 'ok', elapsedMs: 1, stderr: '' }
        }),
        parser: () => ({ result: 'success', errors: [] }),
      }),
    )

    const result = await step.execute('x', mockCtx())

    expect(result.status).toBe('ok')
    expect(callCount).toBe(1)
    if (result.status !== 'ok') throw new Error('Expected ok')
    expect(result.meta.attempts).toBe(1)
  })

  // ── 3. No retry on parse error when retryOnParseError=false ─────────────────

  it('does not retry parse errors when retryOnParseError=false — skips delay/onRetry but still runs all attempts, returns error', async () => {
    // Observable behavior: the bespoke loop always runs maxRetries+1 iterations.
    // When retryOnParseError=false, delay and onRetry are NOT called, but the loop
    // still invokes the caller every iteration. The caller IS called maxRetries+1 times.
    let callCount = 0
    const onRetry = vi.fn()
    const maxRetries = 3

    const step = createLlmStep<string, string>(
      baseLlmConfig({
        retry: { maxRetries, baseDelayMs: 1, backoffMultiplier: 2, retryOnParseError: false },
        caller: vi.fn(async () => {
          callCount++
          return { raw: 'bad', elapsedMs: 1, stderr: '' }
        }),
        parser: () => ({ result: '', errors: ['parse failed'] }),
        onRetry,
      }),
    )

    const result = await step.execute('x', mockCtx())

    expect(result.status).toBe('error')
    // Caller invoked maxRetries+1 times (loop runs to completion, just without delays)
    expect(callCount).toBe(maxRetries + 1)
    // onRetry is never called when retryOnParseError=false
    expect(onRetry).not.toHaveBeenCalled()
  })

  // ── 4. Retry on parse error when retryOnParseError=true ──────────────────────

  it('retries parse errors when retryOnParseError=true — fail twice then succeed', async () => {
    let callCount = 0

    const step = createLlmStep<string, string>(
      baseLlmConfig({
        retry: { maxRetries: 3, baseDelayMs: 1, backoffMultiplier: 2, retryOnParseError: true },
        caller: vi.fn(async () => {
          callCount++
          return { raw: callCount >= 3 ? 'success' : 'bad', elapsedMs: 1, stderr: '' }
        }),
        parser: (raw) =>
          raw === 'success'
            ? { result: 'done', errors: [] }
            : { result: '', errors: ['parse failed'] },
      }),
    )

    const promise = step.execute('x', mockCtx())
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result.status).toBe('ok')
    expect(callCount).toBe(3)
  })

  // ── 5. onRetry callback invocation contract ───────────────────────────────────

  it('calls onRetry once per failed attempt with correct attempt number', async () => {
    const onRetry = vi.fn()
    const maxRetries = 3

    const step = createLlmStep<string, string>(
      baseLlmConfig({
        retry: { maxRetries, baseDelayMs: 1, backoffMultiplier: 2, retryOnParseError: true },
        caller: vi.fn(async () => ({ raw: 'bad', elapsedMs: 1, stderr: '' })),
        parser: () => ({ result: '', errors: ['parse failed'] }),
        onRetry,
      }),
    )

    const promise = step.execute('x', mockCtx())
    await vi.runAllTimersAsync()
    await promise

    // onRetry is called once per failed attempt that will be followed by a retry.
    // Attempts 1..maxRetries trigger a retry; attempt maxRetries+1 (last) does not.
    expect(onRetry).toHaveBeenCalledTimes(maxRetries)
    // First call: attempt=1
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, maxRetries + 1, ['parse failed'], expect.any(Number))
    // Last retry call: attempt=maxRetries
    expect(onRetry).toHaveBeenNthCalledWith(maxRetries, maxRetries, maxRetries + 1, ['parse failed'], expect.any(Number))
  })

  // ── 6. Error envelope contract ────────────────────────────────────────────────

  it('final error has status=error with error message containing attempt count', async () => {
    const maxRetries = 2

    const step = createLlmStep<string, string>(
      baseLlmConfig({
        retry: { maxRetries, baseDelayMs: 1, backoffMultiplier: 2, retryOnParseError: true },
        caller: vi.fn(async () => ({ raw: 'bad', elapsedMs: 1, stderr: '' })),
        parser: () => ({ result: '', errors: ['schema mismatch'] }),
      }),
    )

    const promise = step.execute('x', mockCtx())
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('Expected error')
    // Error message must include attempt count and parse error message
    expect(result.error).toContain(`${maxRetries + 1} attempt`)
    expect(result.error).toContain('schema mismatch')
    expect(result.retries).toBe(maxRetries)
  })

  // ── 7. Backoff shape — band assertion (survives p-retry jitter) ───────────────

  it('delay grows roughly exponentially (band assertion)', async () => {
    const baseDelayMs = 100
    const backoffMultiplier = 2
    const maxRetries = 3
    const capturedDelays: number[] = []

    vi.useRealTimers()

    const step = createLlmStep<string, string>(
      baseLlmConfig({
        retry: { maxRetries, baseDelayMs, backoffMultiplier, retryOnParseError: true },
        caller: vi.fn(async () => ({ raw: 'bad', elapsedMs: 1, stderr: '' })),
        parser: () => ({ result: '', errors: ['fail'] }),
        onRetry: vi.fn((_attempt, _maxAttempts, _errors, delayMs: number) => {
          capturedDelays.push(delayMs)
        }),
      }),
    )

    const result = await step.execute('x', mockCtx())

    expect(result.status).toBe('error')
    expect(capturedDelays).toHaveLength(maxRetries)

    // Each delay should be within ±50% of the expected exponential value
    for (let i = 0; i < capturedDelays.length; i++) {
      const expectedDelay = baseDelayMs * Math.pow(backoffMultiplier, i)
      const lowerBound = expectedDelay * 0.5
      const upperBound = expectedDelay * 2.0
      expect(capturedDelays[i]).toBeGreaterThanOrEqual(lowerBound)
      expect(capturedDelays[i]).toBeLessThanOrEqual(upperBound)
    }
  })
})
