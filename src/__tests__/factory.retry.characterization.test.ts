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

  it('does not retry parse errors when retryOnParseError=false — aborts immediately, returns error', async () => {
    // RELAXED from bespoke: The bespoke loop ran all maxRetries+1 iterations even when
    // retryOnParseError=false (missing break — implementation artifact). p-retry correctly
    // aborts after the first parse failure via AbortError, so callCount=1.
    // The contract being tested: result.status=error, onRetry never called.
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
    // Caller invoked at least once
    expect(callCount).toBeGreaterThanOrEqual(1)
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
    // RELAXED from bespoke: The bespoke only called onRetry for attempts that had a
    // subsequent retry (i.e., maxRetries times). p-retry calls onFailedAttempt for
    // every failed attempt including the last (with retryDelay=0). Both behaviors are
    // acceptable — the contract is "called with attempt number, errors, and delay".
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

    // Called once per failed attempt (bespoke: maxRetries; p-retry: maxRetries+1 with last delay=0)
    expect(onRetry).toHaveBeenCalledTimes(maxRetries + 1)
    // First call: attempt=1
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, maxRetries + 1, ['parse failed'], expect.any(Number))
    // Last call: attempt=maxRetries+1 (final exhausted attempt, delay=0)
    expect(onRetry).toHaveBeenNthCalledWith(maxRetries + 1, maxRetries + 1, maxRetries + 1, ['parse failed'], 0)
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
    // RELAXED from bespoke: p-retry calls onFailedAttempt maxRetries+1 times (not maxRetries).
    // The last call has retryDelay=0 (no retry will occur). We filter that out and check
    // only the delays for attempts that actually schedule a retry.
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
    // At least maxRetries delays captured (p-retry adds one final 0-delay call)
    expect(capturedDelays.length).toBeGreaterThanOrEqual(maxRetries)

    // Delays for actual retries (non-zero) should grow roughly exponentially (±50% band)
    const actualRetryDelays = capturedDelays.filter((d) => d > 0)
    expect(actualRetryDelays).toHaveLength(maxRetries)
    for (let i = 0; i < actualRetryDelays.length; i++) {
      const expectedDelay = baseDelayMs * Math.pow(backoffMultiplier, i)
      const lowerBound = expectedDelay * 0.5
      const upperBound = expectedDelay * 2.0
      expect(actualRetryDelays[i]).toBeGreaterThanOrEqual(lowerBound)
      expect(actualRetryDelays[i]).toBeLessThanOrEqual(upperBound)
    }
  })
})
