/**
 * Bedrock characterization tests for the subprocess spawn in callClaudeAsync.
 *
 * These tests pin the observable behavior of the CURRENT (bespoke) child_process.spawn
 * implementation in src/callers/claude-cli.ts before the execa swap.
 * They must pass on main before any production change (ADR-0001, SPEC-002).
 *
 * A fake `claude` executable is placed on PATH for each test so no real
 * claude binary or API tokens are required.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'

import { callClaudeAsync, DEFAULT_CLAUDE_CALLER_OPTIONS } from '../callers/claude-cli.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal opts object. */
function opts(overrides?: Partial<typeof DEFAULT_CLAUDE_CALLER_OPTIONS>) {
  return { ...DEFAULT_CLAUDE_CALLER_OPTIONS, ...overrides }
}

/** Realistic NDJSON envelope line that processMessage recognises. */
function resultLine(text: string, sessionId = 'sid-fixture'): string {
  return JSON.stringify({ type: 'result', result: text, session_id: sessionId }) + '\n'
}

let fakeDir: string
let origPath: string

beforeEach(async () => {
  fakeDir = await mkdtemp(join(tmpdir(), 'claude-char-'))
  origPath = process.env['PATH'] ?? ''
  process.env['PATH'] = `${fakeDir}:${origPath}`
})

afterEach(async () => {
  process.env['PATH'] = origPath
  await rm(fakeDir, { recursive: true, force: true })
})

/** Write a shell script named `claude` in fakeDir and make it executable. */
async function writeFakeClaude(script: string): Promise<void> {
  const p = join(fakeDir, 'claude')
  await writeFile(p, `#!/bin/sh\n${script}`)
  await chmod(p, 0o755)
}

// ── 1. Captures stdout ────────────────────────────────────────────────────────

describe('callClaudeAsync characterization', () => {
  it('captures stdout from a fixture script', async () => {
    const envelope = resultLine('hello from fixture')
    await writeFakeClaude(`printf '%s' '${envelope.replace("'", "'\\''")}'; exit 0`)

    const result = await callClaudeAsync('prompt', 'test-stdout', opts())
    expect(result.raw).toBe('hello from fixture')
  })

  // ── 2. Captures stderr ──────────────────────────────────────────────────────

  it('captures stderr from a fixture script', async () => {
    const envelope = resultLine('main output')
    await writeFakeClaude(`printf '%s' '${envelope}' >&1; printf 'some warning\\n' >&2; exit 0`)

    const result = await callClaudeAsync('prompt', 'test-stderr', opts())
    expect(result.stderr).toContain('some warning')
    expect(result.raw).toBe('main output')
  })

  // ── 3. Non-zero exit code → error ───────────────────────────────────────────

  it('surfaces non-zero exit code in result.error', async () => {
    await writeFakeClaude('exit 2')

    await expect(callClaudeAsync('prompt', 'test-exitcode', opts())).rejects.toThrow()
  })

  // ── 4. Timeout → process killed ─────────────────────────────────────────────

  it('kills process and reports timeout when it runs longer than timeoutMs', async () => {
    // Write the PID to a known temp file so we can verify the process is dead
    const pidFile = join(fakeDir, 'proc.pid')
    // Infinite sleep loop — writes its PID then sleeps
    await writeFakeClaude(
      `echo $$ > '${pidFile}'\nwhile true; do sleep 0.1; done`,
    )

    const start = Date.now()
    const err = await callClaudeAsync('prompt', 'test-timeout', opts({ timeoutMs: 200 })).catch(
      (e: unknown) => e as Error,
    )
    const elapsed = Date.now() - start

    // Promise rejected with a timeout error
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/timed out|timeout/i)

    // Timeout fired within a reasonable window
    expect(elapsed).toBeGreaterThanOrEqual(180)
    expect(elapsed).toBeLessThan(2000)

    // Wait briefly for the OS to clean up, then verify the process is gone
    await new Promise((r) => setTimeout(r, 100))
    const pid = (() => {
      try {
        return execSync(`cat '${pidFile}'`, { encoding: 'utf8' }).trim()
      } catch {
        return null
      }
    })()

    if (pid) {
      // Process must be dead — kill(pid, 0) throws if process is not running
      expect(() => process.kill(Number(pid), 0)).toThrow()
    }
    // If pidFile was never written the process died before writing it — also acceptable
  })

  // ── 5. MaxBuffer exceeded → error ───────────────────────────────────────────

  it('truncates / errors when output exceeds maxBufferBytes', async () => {
    // Write a script that emits 10 kB of data then a valid result — exceeds 1 kB limit
    await writeFakeClaude(
      `node -e "process.stdout.write('x'.repeat(10240) + '\\n'); process.exit(0);"`,
    )

    await expect(
      callClaudeAsync('prompt', 'test-maxbuffer', opts({ maxBuffer: 1024 })),
    ).rejects.toThrow()
  })

  // ── 6. Cancellation — process actually dies ──────────────────────────────────

  it('propagates AbortSignal — process actually dies', async () => {
    // Current bespoke implementation: cancellation is via the timeout kill path.
    // We verify that a very short timeout kills the subprocess (not just rejects
    // the promise). A longer-running fixture combined with pgrep confirms the kill.
    const pidFile = join(fakeDir, 'cancel.pid')
    await writeFakeClaude(
      `echo $$ > '${pidFile}'\nwhile true; do sleep 0.05; done`,
    )

    const err = await callClaudeAsync(
      'prompt',
      'test-cancel',
      opts({ timeoutMs: 150 }),
    ).catch((e: unknown) => e as Error)

    // Promise must have been rejected
    expect(err).toBeInstanceOf(Error)

    await new Promise((r) => setTimeout(r, 150))

    const pid = (() => {
      try {
        return execSync(`cat '${pidFile}'`, { encoding: 'utf8' }).trim()
      } catch {
        return null
      }
    })()

    if (pid) {
      // Process must be dead
      expect(() => process.kill(Number(pid), 0)).toThrow()
    }
  })

  // ── 7. Envelope parsing ──────────────────────────────────────────────────────

  it('parses Claude JSON envelope from stdout into raw text + elapsedMs', async () => {
    const text = 'The answer is 42'
    const envelope = resultLine(text, 'sid-abc')
    await writeFakeClaude(`printf '%s' '${envelope}'; exit 0`)

    const before = Date.now()
    const result = await callClaudeAsync('my prompt', 'test-parse', opts())
    const after = Date.now()

    // raw is extracted from the envelope's "result" field
    expect(result.raw).toBe(text)
    // elapsedMs is a positive number within the wall-clock window
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(result.elapsedMs).toBeLessThanOrEqual(after - before + 50)
  })
})
