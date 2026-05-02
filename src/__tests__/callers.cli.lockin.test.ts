/**
 * Lock-in tests for the execa-backed callClaudeAsync in claude-cli.ts.
 *
 * Two kinds (ADR-0001, SPEC-002):
 *   1. Fixture replay — load a recorded envelope, parse through the caller's
 *      processMessage-based envelope-parser, snapshot the result.
 *   2. Property test via fast-check — random model/cost/turns combos in the
 *      result message, assert the parser extracts them correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fc from 'fast-check'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { callClaudeAsync, DEFAULT_CLAUDE_CALLER_OPTIONS } from '../callers/claude-cli.js'
import { processMessage } from '../callers/claude-stream.js'
import type { ToolCallTrace } from '../callers/claude-stream.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const FIXTURE_PATH = new URL('./fixtures/claude-cli-envelope.json', import.meta.url).pathname

function opts(overrides?: Partial<typeof DEFAULT_CLAUDE_CALLER_OPTIONS>) {
  return { ...DEFAULT_CLAUDE_CALLER_OPTIONS, ...overrides }
}

let fakeDir: string
let origPath: string

beforeEach(async () => {
  fakeDir = await mkdtemp(join(tmpdir(), 'claude-lockin-'))
  origPath = process.env['PATH'] ?? ''
  process.env['PATH'] = `${fakeDir}:${origPath}`
})

afterEach(async () => {
  process.env['PATH'] = origPath
  await rm(fakeDir, { recursive: true, force: true })
})

async function writeFakeClaude(script: string): Promise<void> {
  const p = join(fakeDir, 'claude')
  await writeFile(p, `#!/bin/sh\n${script}`)
  await chmod(p, 0o755)
}

// ── Fixture replay ────────────────────────────────────────────────────────────

describe('claude-cli lock-in: fixture replay', () => {
  it('parses recorded envelope fixture and extracts finalText correctly', async () => {
    // Load the recorded NDJSON fixture (stored as a JSON array for readability)
    const raw = await readFile(FIXTURE_PATH, 'utf8')
    const lines: unknown[] = JSON.parse(raw) as unknown[]

    // Run through the envelope parser (same logic as callClaudeAsync)
    const toolCalls: ToolCallTrace[] = []
    const pendingTools = new Map<string, { trace: ToolCallTrace; startMs: number }>()
    let finalText = ''
    let sessionId: string | undefined

    for (const line of lines) {
      const sid = processMessage(
        line as Parameters<typeof processMessage>[0],
        toolCalls,
        pendingTools,
        () => {},
        () => {},
        (text) => { finalText = text },
        () => {},
      )
      if (sid) sessionId = sid
    }

    // Snapshot the parsed result
    expect(finalText).toBe('The answer is 42.')
    expect(sessionId).toBe('sess-fixture-001')
    expect(toolCalls).toHaveLength(0)
  })

  it('callClaudeAsync with a fake claude emitting the fixture envelope resolves correctly', async () => {
    // Build an NDJSON stdout from the fixture file
    const raw = await readFile(FIXTURE_PATH, 'utf8')
    const lines: unknown[] = JSON.parse(raw) as unknown[]
    const ndjson = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'

    // Escape single quotes in ndjson for shell heredoc
    const escaped = ndjson.replace(/'/g, "'\\''")
    await writeFakeClaude(`printf '%s' '${escaped}'; exit 0`)

    const result = await callClaudeAsync('What is 6 times 7?', 'lockin-replay', opts())

    expect(result.raw).toBe('The answer is 42.')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(result.stderr).toBe('')
  })
})

// ── Property test ─────────────────────────────────────────────────────────────

describe('claude-cli lock-in: property tests', () => {
  it('processMessage extracts result text from envelope variations (random model/cost/turns)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),   // result text
        fc.string({ minLength: 1, maxLength: 40 }),    // model name
        fc.float({ min: 0, max: 1, noNaN: true }),     // cost
        fc.integer({ min: 1, max: 20 }),               // turns
        fc.string({ minLength: 1, maxLength: 40 }),    // session_id
        (resultText, model, cost, turns, sessionId) => {
          const toolCalls: ToolCallTrace[] = []
          const pendingTools = new Map<string, { trace: ToolCallTrace; startMs: number }>()
          let finalText = ''

          const msg = {
            type: 'result' as const,
            subtype: 'success',
            is_error: false,
            result: resultText,
            session_id: sessionId,
            total_cost_usd: cost,
            num_turns: turns,
            message: {
              model,
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          }

          processMessage(
            msg as Parameters<typeof processMessage>[0],
            toolCalls,
            pendingTools,
            () => {},
            () => {},
            (text) => { finalText = text },
            () => {},
          )

          // Invariant: result text is always extracted correctly regardless of model/cost/turns
          expect(finalText).toBe(resultText)
        },
      ),
      { numRuns: 200, seed: 42 },
    )
  })

  it('callClaudeAsync resolves with correct raw text for random result payloads', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 100 }).filter(
          // Avoid chars that break shell printf escaping
          (s) => !s.includes("'") && !s.includes('\\') && !s.includes('\n'),
        ),
        async (resultText) => {
          const ndjson = JSON.stringify({
            type: 'result',
            result: resultText,
            session_id: 'sid-prop',
          }) + '\n'
          const escaped = ndjson.replace(/'/g, "'\\''")
          await writeFakeClaude(`printf '%s' '${escaped}'; exit 0`)

          const r = await callClaudeAsync('p', 'prop-test', opts())
          expect(r.raw).toBe(resultText)
        },
      ),
      { numRuns: 50, seed: 99 },
    )
  })
})
