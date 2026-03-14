/**
 * Tests for writeStepFixture and readStepFixture.
 *
 * Covers: write artifacts, read with/without validator, { cause } on errors,
 * raw truncation.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { writeStepFixture, readStepFixture } from '../fixture-writer.js'
import { MAX_RAW_FIXTURE_LENGTH } from '../constants.js'

let testDir: string

beforeEach(() => {
  testDir = resolve(tmpdir(), `fixture-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('writeStepFixture', () => {
  it('writes prompt.txt', () => {
    writeStepFixture(testDir, 'run-1', 'step-a', { prompt: 'hello world' })

    const content = readFileSync(resolve(testDir, 'run-1', 'step-a', 'prompt.txt'), 'utf8')
    expect(content).toBe('hello world')
  })

  it('writes raw.txt', () => {
    writeStepFixture(testDir, 'run-1', 'step-a', { raw: '{"result": true}' })

    const content = readFileSync(resolve(testDir, 'run-1', 'step-a', 'raw.txt'), 'utf8')
    expect(content).toBe('{"result": true}')
  })

  it('writes actual.json', () => {
    writeStepFixture(testDir, 'run-1', 'step-a', { actual: { count: 42 } })

    const content = readFileSync(resolve(testDir, 'run-1', 'step-a', 'actual.json'), 'utf8')
    expect(JSON.parse(content)).toEqual({ count: 42 })
  })

  it('writes meta.json', () => {
    writeStepFixture(testDir, 'run-1', 'step-a', {
      meta: { model: 'opus', durationMs: 1234 },
    })

    const content = readFileSync(resolve(testDir, 'run-1', 'step-a', 'meta.json'), 'utf8')
    const meta = JSON.parse(content)
    expect(meta.model).toBe('opus')
    expect(meta.durationMs).toBe(1234)
  })

  it('truncates raw output exceeding MAX_RAW_FIXTURE_LENGTH', () => {
    const longRaw = 'x'.repeat(MAX_RAW_FIXTURE_LENGTH + 1000)
    writeStepFixture(testDir, 'run-1', 'step-a', { raw: longRaw })

    const content = readFileSync(resolve(testDir, 'run-1', 'step-a', 'raw.txt'), 'utf8')
    expect(content.length).toBe(MAX_RAW_FIXTURE_LENGTH)
  })

  it('returns the step path', () => {
    const path = writeStepFixture(testDir, 'run-1', 'step-a', { prompt: 'p' })
    expect(path).toBe(resolve(testDir, 'run-1', 'step-a'))
  })
})

describe('readStepFixture', () => {
  it('reads and parses actual.json', () => {
    const stepDir = resolve(testDir, 'run-1', 'step-a')
    mkdirSync(stepDir, { recursive: true })
    writeFileSync(resolve(stepDir, 'actual.json'), JSON.stringify({ value: 99 }), 'utf8')

    const result = readStepFixture<{ value: number }>(stepDir)
    expect(result.value).toBe(99)
  })

  it('throws with cause on missing file', () => {
    const stepDir = resolve(testDir, 'run-1', 'nonexistent')

    expect(() => readStepFixture(stepDir)).toThrow('Failed to read step fixture')

    try {
      readStepFixture(stepDir)
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).cause).toBeDefined()
    }
  })

  it('throws with cause on invalid JSON', () => {
    const stepDir = resolve(testDir, 'run-1', 'bad-json')
    mkdirSync(stepDir, { recursive: true })
    writeFileSync(resolve(stepDir, 'actual.json'), 'not json', 'utf8')

    expect(() => readStepFixture(stepDir)).toThrow('Failed to read step fixture')

    try {
      readStepFixture(stepDir)
    } catch (err) {
      expect((err as Error).cause).toBeDefined()
    }
  })

  it('validates with type guard', () => {
    const stepDir = resolve(testDir, 'run-1', 'valid')
    mkdirSync(stepDir, { recursive: true })
    writeFileSync(resolve(stepDir, 'actual.json'), JSON.stringify({ valid: true }), 'utf8')

    const guard = (data: unknown): data is { valid: boolean } =>
      typeof data === 'object' && data !== null && 'valid' in data

    const result = readStepFixture<{ valid: boolean }>(stepDir, guard)
    expect(result.valid).toBe(true)
  })

  it('throws on failed validation', () => {
    const stepDir = resolve(testDir, 'run-1', 'invalid')
    mkdirSync(stepDir, { recursive: true })
    writeFileSync(resolve(stepDir, 'actual.json'), JSON.stringify({ wrong: true }), 'utf8')

    const guard = (data: unknown): data is { valid: boolean } =>
      typeof data === 'object' && data !== null && 'valid' in data && (data as Record<string, unknown>).valid === true

    expect(() => readStepFixture<{ valid: boolean }>(stepDir, guard)).toThrow('Fixture validation failed')
  })
})
