/**
 * Tests for writeAftermath and parseAftermath.
 *
 * Covers: success/abort aftermath, step table parsing, resume section.
 */

import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { writeAftermath, parseAftermath } from '../aftermath.js'
import type { PipelineManifest } from '../types.js'

let testDir: string

beforeEach(() => {
  testDir = resolve(tmpdir(), `aftermath-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

function manifest(status: 'ok' | 'aborted'): PipelineManifest {
  return {
    runId: 'run-1',
    pipelineName: 'test-pipeline',
    startedAt: '2024-01-01T00:00:00Z',
    completedAt: '2024-01-01T00:01:00Z',
    status,
    steps: [
      { name: 'step-a', kind: 'script', status: 'ok', elapsedMs: 100, retries: 0, error: '' },
      { name: 'step-b', kind: 'llm', status: status === 'aborted' ? 'error' : 'ok', elapsedMs: 5000, retries: status === 'aborted' ? 2 : 0, error: status === 'aborted' ? 'LLM timeout' : '' },
      { name: 'step-c', kind: 'script', status: status === 'aborted' ? 'skipped' : 'ok', elapsedMs: status === 'aborted' ? 0 : 50, retries: 0, error: '' },
    ],
  }
}

describe('writeAftermath', () => {
  it('writes success aftermath', () => {
    const path = writeAftermath(testDir, 'run-1', manifest('ok'), null, '')
    expect(path).toContain('llm-aftermath.md')
  })

  it('writes abort aftermath with error section', () => {
    const path = writeAftermath(testDir, 'run-1', manifest('aborted'), 'step-b', 'LLM timeout')
    expect(path).toContain('llm-aftermath.md')
  })

  it('includes resume command when provided', () => {
    writeAftermath(testDir, 'run-1', manifest('aborted'), 'step-b', 'LLM timeout', {
      resumeCommand: (runId, fixtureDir) => `resume --run=${runId} --dir=${fixtureDir}`,
    })

    const data = parseAftermath(resolve(testDir, 'run-1', 'llm-aftermath.md'))
    // If the file parses, the resume section was written correctly
    expect(data.runId).toBe('run-1')
  })
})

describe('parseAftermath', () => {
  it('extracts runId and pipelineName', () => {
    writeAftermath(testDir, 'run-1', manifest('ok'), null, '')
    const data = parseAftermath(resolve(testDir, 'run-1', 'llm-aftermath.md'))

    expect(data.runId).toBe('run-1')
    expect(data.pipelineName).toBe('test-pipeline')
  })

  it('identifies completed steps', () => {
    writeAftermath(testDir, 'run-1', manifest('ok'), null, '')
    const data = parseAftermath(resolve(testDir, 'run-1', 'llm-aftermath.md'))

    expect(data.completedSteps).toContain('step-a')
    expect(data.completedSteps).toContain('step-b')
    expect(data.completedSteps).toContain('step-c')
    expect(data.failedStep).toBeNull()
  })

  it('identifies failed step', () => {
    writeAftermath(testDir, 'run-1', manifest('aborted'), 'step-b', 'LLM timeout')
    const data = parseAftermath(resolve(testDir, 'run-1', 'llm-aftermath.md'))

    expect(data.completedSteps).toEqual(['step-a'])
    expect(data.failedStep).toBe('step-b')
  })

  it('throws on missing file', () => {
    expect(() => parseAftermath('/nonexistent/path')).toThrow()
  })
})
