/**
 * Build-phase MCP tools — write + restricted Bash operations for the build agent.
 *
 * These tools run verification commands in the target codebase directory.
 * They use execFileSync (not exec) to prevent shell injection.
 */
import { execFileSync } from 'node:child_process'

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod/v4'

// ── typecheck ────────────────────────────────────────────────────────────────

/**
 * Run `npx tsc --noEmit` in the given directory and return the output.
 */
export const typecheckTool = tool(
  'typecheck',
  'Run TypeScript type-checking (tsc --noEmit) in the given directory. Returns compiler errors or empty string on success.',
  { cwd: z.string().describe('Absolute path to the directory containing tsconfig.json') },
  async ({ cwd }) => {
    try {
      execFileSync('npx', ['tsc', '--noEmit'], {
        cwd,
        encoding: 'utf8',
        timeout: 60_000,
        stdio: 'pipe',
      })
      return { content: [{ type: 'text' as const, text: 'Type check passed — no errors.' }], isError: false }
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      const output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim()
      return { content: [{ type: 'text' as const, text: output || 'Type check failed (no output).' }], isError: true }
    }
  },
)

// ── runTests ─────────────────────────────────────────────────────────────────

/**
 * Run `npx vitest run` in the given directory, with optional test name filter.
 */
export const runTestsTool = tool(
  'runTests',
  'Run the test suite with Vitest in the given directory. Optionally filter by test name pattern.',
  {
    cwd: z.string().describe('Absolute path to the directory containing vitest.config.ts or package.json'),
    filter: z.string().optional().describe('Optional test name filter pattern passed to vitest run -t'),
  },
  async ({ cwd, filter }) => {
    const args = ['vitest', 'run']
    if (filter) args.push('-t', filter)
    try {
      const stdout = execFileSync('npx', args, {
        cwd,
        encoding: 'utf8',
        timeout: 120_000,
        stdio: 'pipe',
      })
      return { content: [{ type: 'text' as const, text: stdout.trim() || 'Tests passed.' }], isError: false }
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      const output = [e.stdout, e.stderr].filter(Boolean).join('\n').trim()
      return { content: [{ type: 'text' as const, text: output || 'Tests failed (no output).' }], isError: true }
    }
  },
)

// ── lint ─────────────────────────────────────────────────────────────────────

/**
 * Run `npx eslint` on the src directory in the given cwd.
 */
export const lintTool = tool(
  'lint',
  'Run ESLint on the source directory. Returns lint errors or empty string on success.',
  { cwd: z.string().describe('Absolute path to the project root (must have eslint.config.* or .eslintrc)') },
  async ({ cwd }) => {
    try {
      const stdout = execFileSync('npx', ['eslint', 'src/', '--max-warnings=0'], {
        cwd,
        encoding: 'utf8',
        timeout: 60_000,
        stdio: 'pipe',
      })
      return { content: [{ type: 'text' as const, text: stdout.trim() || 'Lint passed — no issues.' }], isError: false }
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      const output = [e.stdout, e.stderr].filter(Boolean).join('\n').trim()
      return { content: [{ type: 'text' as const, text: output || 'Lint failed (no output).' }], isError: true }
    }
  },
)

/** All build-phase tools as an array for createSdkMcpServer. */
export const buildTools = [typecheckTool, runTestsTool, lintTool]
