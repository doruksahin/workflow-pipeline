/**
 * Tests for runtime values exported from types.ts.
 */

import { describe, it, expect } from 'vitest'

import { VALID_CONFIDENCE, SILENT_LOGGER } from '../types.js'

describe('VALID_CONFIDENCE', () => {
  it('contains high, medium, low', () => {
    expect(VALID_CONFIDENCE.has('high')).toBe(true)
    expect(VALID_CONFIDENCE.has('medium')).toBe(true)
    expect(VALID_CONFIDENCE.has('low')).toBe(true)
    expect(VALID_CONFIDENCE.size).toBe(3)
  })
})

describe('SILENT_LOGGER', () => {
  it('has all four log methods', () => {
    expect(typeof SILENT_LOGGER.debug).toBe('function')
    expect(typeof SILENT_LOGGER.info).toBe('function')
    expect(typeof SILENT_LOGGER.warn).toBe('function')
    expect(typeof SILENT_LOGGER.error).toBe('function')
  })

  it('does not throw when called', () => {
    expect(() => SILENT_LOGGER.debug('test', {})).not.toThrow()
    expect(() => SILENT_LOGGER.info('test', { key: 'value' })).not.toThrow()
    expect(() => SILENT_LOGGER.warn('test', {})).not.toThrow()
    expect(() => SILENT_LOGGER.error('test', {})).not.toThrow()
  })
})
