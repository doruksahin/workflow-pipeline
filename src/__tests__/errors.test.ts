/**
 * Tests for error hierarchy classes.
 */

import { describe, it, expect } from 'vitest'

import { StepExecutionError, ParseError, PipelineAbortedError, ParallelBranchError } from '../errors.js'

describe('StepExecutionError', () => {
  it('includes step name in message', () => {
    const err = new StepExecutionError('classify', 'LLM timeout', new Error('timeout'), 5000, 2)
    expect(err.message).toContain('classify')
    expect(err.stepName).toBe('classify')
    expect(err.cause).toBeInstanceOf(Error)
    expect(err.elapsedMs).toBe(5000)
    expect(err.retries).toBe(2)
  })
})

describe('ParseError', () => {
  it('includes validation errors', () => {
    const err = new ParseError('classify', ['missing field A', 'invalid type B'], '{"bad": true}')
    expect(err.message).toContain('classify')
    expect(err.message).toContain('2 validation errors')
    expect(err.errors).toHaveLength(2)
    expect(err.rawSnippet).toBe('{"bad": true}')
  })

  it('truncates long raw output', () => {
    const longRaw = 'x'.repeat(1000)
    const err = new ParseError('step', ['err'], longRaw)
    expect(err.rawSnippet.length).toBeLessThan(longRaw.length)
    expect(err.rawSnippet).toContain('...')
  })
})

describe('PipelineAbortedError', () => {
  it('carries manifest', () => {
    const manifest = {
      runId: 'run-1',
      pipelineName: 'test',
      startedAt: '',
      completedAt: '',
      status: 'aborted' as const,
      steps: [],
    }
    const err = new PipelineAbortedError('classify', 'boom', manifest)
    expect(err.failedStep).toBe('classify')
    expect(err.manifest).toBe(manifest)
  })
})

describe('ParallelBranchError', () => {
  it('aggregates branch errors', () => {
    const branches = new Map<string, Error>([
      ['alpha', new Error('alpha failed')],
      ['beta', new Error('beta failed')],
    ])
    const err = new ParallelBranchError('parallel-step', branches)
    expect(err.message).toContain('2 branch(es) failed')
    expect(err.message).toContain('alpha')
    expect(err.message).toContain('beta')
    expect(err.branchErrors.size).toBe(2)
  })
})
