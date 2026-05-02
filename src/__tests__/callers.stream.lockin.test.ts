/**
 * Lock-in tests for the split2-backed NDJSON streaming in claude-stream.ts.
 *
 * Two kinds (ADR-0001, SPEC-003):
 *   1. Property test via fast-check — random valid JSON arrays and chunk sizes,
 *      asserting that split2 produces the same parsed sequence regardless of
 *      chunk boundaries. This is THE headline test for the split2 swap.
 *   2. Replay test — pipe the committed NDJSON fixture through split2 and
 *      through processMessage, snapshot the message sequence and tool-call traces.
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { Readable } from 'node:stream'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import split2 from 'split2'

import { processMessage } from '../callers/claude-stream.js'
import type { ToolCallTrace } from '../callers/claude-stream.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const FIXTURE_PATH = new URL('./fixtures/claude-stream.ndjson', import.meta.url).pathname

/**
 * Split a string into chunks of at most `size` characters.
 */
function chunkString(s: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < s.length; i += size) {
    chunks.push(s.slice(i, i + size))
  }
  return chunks
}

/**
 * Build a Node.js Readable from an array of string chunks.
 */
function makeReadable(chunks: string[]): Readable {
  return new Readable({
    read() {
      for (const chunk of chunks) {
        this.push(chunk, 'utf8')
      }
      this.push(null)
    },
  })
}

/**
 * Stream an array of chunks through split2(JSON.parse) and collect parsed
 * messages. This exercises the exact same transform used in claude-stream.ts.
 */
async function streamThrough(chunks: string[]): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const messages: unknown[] = []
    const readable = makeReadable(chunks)
    const lines = readable.pipe(split2(JSON.parse))

    lines.on('data', (msg: unknown) => {
      messages.push(msg)
    })

    lines.on('error', (err: Error) => {
      // Parse errors are observable (malformed lines) — collect them as
      // an error sentinel so callers can assert on them if needed.
      // For the property test all input is valid JSON so this should never fire.
      reject(err)
    })

    lines.on('end', () => resolve(messages))
  })
}

// ── Property test — THE headline test for the split2 swap ─────────────────────

describe('NDJSON streaming lock-in: property tests', () => {
  it('any chunking of valid NDJSON produces same parsed message sequence', async () => {
    // Note: We use fc.record({ type: fc.string(), value: fc.jsonValue() }) to generate
    // JSON-safe objects that are always truthy at top level. We restrict to objects
    // because split2 drops falsy top-level results (null, false, 0, "") from its data
    // stream — correct for our usage: real Claude NDJSON streams always emit objects
    // with a "type" discriminant field, never bare primitives.
    // Ground truth is derived by JSON-round-tripping the input (same as NDJSON does),
    // which normalises undefined → null and avoids false test failures from JS-only
    // values that JSON.stringify drops.
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({ type: fc.string(), value: fc.jsonValue() }),
          { minLength: 1, maxLength: 20 },
        ),
        fc.integer({ min: 1, max: 100 }), // chunk size in bytes
        async (rawMessages, chunkSize) => {
          // Encode as NDJSON: one serialised JSON object per line
          const ndjson = rawMessages.map((m) => JSON.stringify(m)).join('\n') + '\n'
          // Ground truth: what you get after JSON round-trip (same as stream parsing does)
          const groundTruth = rawMessages.map((m) => JSON.parse(JSON.stringify(m)) as unknown)
          // Split the NDJSON string into chunks of at most chunkSize characters
          const chunks = chunkString(ndjson, chunkSize)

          const parsed = await streamThrough(chunks)

          // Invariant: regardless of chunk boundaries, the parsed sequence must
          // match the reference sequence exactly — same count, same objects.
          expect(parsed).toEqual(groundTruth)
        },
      ),
      { numRuns: 500, seed: 12345 },
    )
  }, 30_000) // allow up to 30s for 500 property runs
})

// ── Fixture replay test ────────────────────────────────────────────────────────

describe('NDJSON streaming lock-in: fixture replay', () => {
  it('pipes the fixture NDJSON through split2 and produces correct message sequence', async () => {
    const ndjson = await readFile(FIXTURE_PATH, 'utf8')
    const lines = ndjson.split('\n').filter(Boolean)

    // Parse each line for ground truth
    const expectedMessages = lines.map((l) => JSON.parse(l) as unknown)

    // Stream the fixture as one single chunk through split2
    const parsed = await streamThrough([ndjson])

    expect(parsed).toHaveLength(expectedMessages.length)
    expect(parsed).toEqual(expectedMessages)
  })

  it('fixture replay through processMessage produces correct tool-call traces and final text', async () => {
    const ndjson = await readFile(FIXTURE_PATH, 'utf8')
    const rawLines = ndjson.split('\n').filter(Boolean)

    const toolCalls: ToolCallTrace[] = []
    const pendingTools = new Map<string, { trace: ToolCallTrace; startMs: number }>()
    let finalText = ''
    let tokenUsage: { input: number; output: number } = { input: 0, output: 0 }
    const onToolStart = () => {}
    const onToolCall = () => {}

    // Stream each line through processMessage (same as the real caller does)
    for (const line of rawLines) {
      const msg = JSON.parse(line) as Parameters<typeof processMessage>[0]
      processMessage(
        msg,
        toolCalls,
        pendingTools,
        onToolStart,
        onToolCall,
        (text) => { finalText = text },
        (usage) => { tokenUsage = usage },
      )
    }

    // Two tool calls in the fixture: bash and read_file
    expect(toolCalls).toHaveLength(2)
    expect(toolCalls[0]!.name).toBe('bash')
    expect(toolCalls[0]!.id).toBe('tu-001')
    expect(toolCalls[0]!.result).toContain('package.json')
    expect(toolCalls[1]!.name).toBe('read_file')
    expect(toolCalls[1]!.id).toBe('tu-002')
    expect(toolCalls[1]!.result).toContain('workflow-pipeline')

    // Final result text and token usage extracted from the result line
    expect(finalText).toBe('The package is workflow-pipeline at version 0.1.0.')
    expect(tokenUsage).toEqual({ input: 120, output: 35 })

    // pendingTools must be empty after processing all lines (all traces completed)
    expect(pendingTools.size).toBe(0)
  })

  it('pipes the fixture through split2 in random chunk sizes and matches ground truth', async () => {
    // Additional chunking replay — confirms split2 handles our exact fixture at
    // various boundaries (1 byte, 10 bytes, 50 bytes, 500 bytes, full file).
    const ndjson = await readFile(FIXTURE_PATH, 'utf8')
    const rawLines = ndjson.split('\n').filter(Boolean)
    const expectedMessages = rawLines.map((l) => JSON.parse(l) as unknown)

    for (const chunkSize of [1, 7, 10, 50, 200, ndjson.length]) {
      const parsed = await streamThrough(chunkString(ndjson, chunkSize))
      expect(parsed).toEqual(expectedMessages)
    }
  })
})
