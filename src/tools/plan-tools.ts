/**
 * Plan-phase MCP tools — read-only operations for the planning agent.
 *
 * All tools are scoped to a `cwd` root — file reads and searches cannot
 * escape the session directory.
 *
 * Usage:
 *   import { createPlanTools } from 'step-pipeline/tools'
 *   const tools = createPlanTools(worktreePath)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, normalize } from 'node:path'

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod/v4'

// ── createPlanTools ──────────────────────────────────────────────────────────

/**
 * Create plan-phase tools scoped to `cwd`.
 * File reads and searches are restricted to paths under `cwd`.
 *
 * @param cwd Absolute path to the session root. Paths outside this are denied.
 */
export function createPlanTools(cwd: string) {
  const root = normalize(resolve(cwd))

  // ── readFile ──────────────────────────────────────────────────────────────

  const readFileTool = tool(
    'readFile',
    'Read the contents of a file. Path is relative to the project root.',
    { path: z.string().describe('Relative or absolute path to the file') },
    async ({ path }) => {
      const resolved = normalize(resolve(root, path))
      if (!resolved.startsWith(root + '/') && resolved !== root) {
        return { content: [{ type: 'text' as const, text: `Access denied: path is outside project root` }], isError: true }
      }
      try {
        const content = readFileSync(resolved, 'utf8')
        return { content: [{ type: 'text' as const, text: content }], isError: false }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text' as const, text: `Error reading file: ${msg}` }], isError: true }
      }
    },
  )

  // ── searchCode ────────────────────────────────────────────────────────────

  const searchCodeTool = tool(
    'searchCode',
    'Search for a regex pattern in source files. Returns matching lines with file:line context.',
    {
      pattern: z.string().describe('Regex pattern to search for'),
      path: z.string().optional().describe('Sub-directory or file to search in (relative to project root)'),
    },
    async ({ pattern, path }) => {
      const searchPath = path ? normalize(resolve(root, path)) : root
      if (!searchPath.startsWith(root)) {
        return { content: [{ type: 'text' as const, text: 'Access denied: path is outside project root' }], isError: true }
      }
      try {
        let output: string
        try {
          // Prefer ripgrep — args are safe array, no shell interpolation
          output = execFileSync('rg', ['--line-number', '--no-heading', '--color=never', pattern, searchPath], {
            encoding: 'utf8',
            timeout: 10_000,
            maxBuffer: 2 * 1024 * 1024,
            stdio: 'pipe',
          })
        } catch {
          // Fallback to grep — args are safe array, no shell interpolation
          output = execFileSync('grep', ['-rn', '--', pattern, searchPath], {
            encoding: 'utf8',
            timeout: 10_000,
            maxBuffer: 2 * 1024 * 1024,
            stdio: 'pipe',
          })
        }
        const text = output.trim() || '(no matches)'
        return { content: [{ type: 'text' as const, text }], isError: false }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text' as const, text: `Search error: ${msg}` }], isError: true }
      }
    },
  )

  // ── decreeLint ────────────────────────────────────────────────────────────

  const decreeLintTool = tool(
    'decreeLint',
    'Run decree lint to validate the document lifecycle (PRD → ADR → SPEC) and return the result.',
    {},
    async () => {
      try {
        // execFileSync — no shell, stderr captured via stdio: 'pipe'
        let output: string
        try {
          output = execFileSync('decree', ['lint'], {
            cwd: root,
            encoding: 'utf8',
            timeout: 30_000,
            maxBuffer: 512 * 1024,
            stdio: 'pipe',
          })
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; message?: string }
          output = [e.stdout, e.stderr].filter(Boolean).join('\n')
        }
        return { content: [{ type: 'text' as const, text: output.trim() || '(no output)' }], isError: false }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text' as const, text: `decree lint failed: ${msg}` }], isError: true }
      }
    },
  )

  return [readFileTool, searchCodeTool, decreeLintTool]
}
