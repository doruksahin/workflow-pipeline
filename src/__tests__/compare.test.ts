/**
 * Tests for diffRuns and renderRunDiff.
 */

import { describe, it, expect } from 'vitest'

import { diffRuns, renderRunDiff } from '../compare.js'
import type { PipelineManifest } from '../types.js'

function manifest(runId: string, steps: Array<{ name: string; elapsedMs: number; status?: 'ok' | 'error' | 'skipped' }>): PipelineManifest {
  return {
    runId,
    pipelineName: 'test',
    startedAt: '2024-01-01T00:00:00Z',
    completedAt: '2024-01-01T00:01:00Z',
    status: 'ok',
    steps: steps.map((s) => ({
      name: s.name,
      kind: 'script' as const,
      status: s.status ?? 'ok',
      elapsedMs: s.elapsedMs,
      retries: 0,
      error: '',
    })),
  }
}

describe('diffRuns', () => {
  it('computes deltas for matching steps', () => {
    const before = manifest('run-1', [
      { name: 'classify', elapsedMs: 12000 },
      { name: 'map', elapsedMs: 15000 },
    ])
    const after = manifest('run-2', [
      { name: 'classify', elapsedMs: 8000 },
      { name: 'map', elapsedMs: 14800 },
    ])

    const diff = diffRuns(before, after)

    expect(diff.runIdBefore).toBe('run-1')
    expect(diff.runIdAfter).toBe('run-2')
    expect(diff.steps).toHaveLength(2)
    expect(diff.steps[0].deltaMs).toBe(-4000)
    expect(diff.steps[1].deltaMs).toBe(-200)
    expect(diff.totalDeltaMs).toBe(-4200)
  })

  it('handles steps only in one manifest', () => {
    const before = manifest('run-1', [{ name: 'a', elapsedMs: 1000 }])
    const after = manifest('run-2', [
      { name: 'a', elapsedMs: 900 },
      { name: 'b', elapsedMs: 500 },
    ])

    const diff = diffRuns(before, after)

    expect(diff.steps).toHaveLength(2)
    const stepB = diff.steps.find((s) => s.step === 'b')!
    expect(stepB.elapsedMsBefore).toBe(0)
    expect(stepB.elapsedMsAfter).toBe(500)
  })
})

describe('renderRunDiff', () => {
  it('produces aligned text table', () => {
    const before = manifest('run-1', [
      { name: 'classify', elapsedMs: 12300 },
      { name: 'map', elapsedMs: 15000 },
    ])
    const after = manifest('run-2', [
      { name: 'classify', elapsedMs: 8100 },
      { name: 'map', elapsedMs: 14800 },
    ])

    const output = renderRunDiff(diffRuns(before, after))

    expect(output).toContain('Step')
    expect(output).toContain('Before')
    expect(output).toContain('After')
    expect(output).toContain('Delta')
    expect(output).toContain('Total')
    expect(output).toContain('classify')
    expect(output).toContain('map')
  })
})
