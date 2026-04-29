/**
 * Custom MCP tools for SDK-based agents.
 *
 * Plan phase (read-only, cwd-scoped):
 *   createPlanTools(cwd) → [readFile, searchCode, decreeLint]
 *
 * Build phase (write + restricted bash):
 *   buildTools → [typecheck, runTests, lint]
 *
 * Usage:
 *   import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
 *   import { createPlanTools, buildTools } from 'step-pipeline/tools'
 *
 *   const planServer = createSdkMcpServer({ name: 'plan', tools: createPlanTools(cwd) })
 *   const buildServer = createSdkMcpServer({ name: 'build', tools: buildTools })
 *
 *   // Pass to query():
 *   options: { mcpServers: { plan: planServer, build: buildServer } }
 */
export { createPlanTools } from './plan-tools.js'
export { typecheckTool, runTestsTool, lintTool, buildTools } from './build-tools.js'
