/**
 * Pipeline framework types — single source of truth.
 *
 * Every step has one contract: execute(input, ctx) => Promise<StepResult<TOutput>>.
 * LlmStep adds prompt assembly + output parsing (via createLlmStep factory).
 * ScriptStep is a pure synchronous or async transform (via createScriptStep factory).
 */

// ── Confidence (inlined from lib/types.ts) ───────────────────────────────────

export const VALID_CONFIDENCE = new Set(['high', 'medium', 'low'])

export type Confidence = 'high' | 'medium' | 'low'

// ── ParseResult (inlined from lib/types.ts) ──────────────────────────────────

export interface ParseResult<T> {
  result: T
  errors: string[]
}

// ── LLM Caller ───────────────────────────────────────────────────────────────

export interface LlmCallerResult {
  raw: string
  elapsedMs: number
  stderr: string
}

export type LlmCaller = (prompt: string, label: string, ctx?: PipelineContext) => Promise<LlmCallerResult>

// ── Retry ────────────────────────────────────────────────────────────────────

export interface RetryConfig {
  /** Total retry attempts after initial failure. 0 = no retry. */
  maxRetries: number
  /** Base delay between retries in ms. */
  baseDelayMs: number
  /** Multiplier applied per retry: delay = baseDelayMs * multiplier^(attempt-1). */
  backoffMultiplier: number
  /** Whether to retry when the LLM call succeeds but parse validation fails. */
  retryOnParseError: boolean
}

// ── Step Result (discriminated union) ────────────────────────────────────────

export interface StepMeta {
  model: string
  attempts: number
  promptLength: number
  rawLength: number
}

export interface StepOk<T> {
  status: 'ok'
  output: T
  elapsedMs: number
  meta: StepMeta
}

export interface StepError {
  status: 'error'
  error: string
  elapsedMs: number
  retries: number
}

export interface ParallelStepError extends StepError {
  branchErrors: ReadonlyMap<string, Error>
}

export type StepResult<T> = StepOk<T> | StepError

// ── Pipeline Context ─────────────────────────────────────────────────────────

export interface PipelineContext<TLogger = unknown> {
  /** Unique identifier for this pipeline run. Used for fixture paths. */
  runId: string
  /** Root directory for fixture output: {fixtureDir}/{runId}/{stepName}/ */
  fixtureDir: string
  /** Whether to persist fixtures to disk. */
  saveFixtures: boolean
  /** Logger — consumers bring their own type. */
  logger: TLogger
  /** Event emitter — injected by the runner so steps can emit tool:start/tool:done events. */
  onEvent?: (event: PipelineEvent) => void
  /** Current step name — set by the runner before each step.execute(). */
  currentStep?: string
}

// ── Step Interface ───────────────────────────────────────────────────────────

export interface Step<TInput, TOutput> {
  /** Unique name within a pipeline. Used for fixtures, logs, manifest. */
  readonly name: string
  /** Human-readable description for logs and aftermath. */
  readonly description: string
  /** Step classification — 'llm' | 'script' | 'parallel'. */
  readonly kind: StepKind
  /** The runner calls this. Takes typed input + shared context. */
  execute(input: TInput, ctx: PipelineContext): Promise<StepResult<TOutput>>
}

// ── Step Config Interfaces (for factories) ───────────────────────────────────

export interface LlmStepConfig<TInput, TOutput> {
  name: string
  description: string
  model: string
  retry: RetryConfig
  /** Injectable LLM caller. */
  caller: LlmCaller
  /** Assemble the full prompt string from typed input. Pure function. */
  promptAssembler: (input: TInput) => string
  /** Parse raw LLM text into typed output. Must return ParseResult. */
  parser: (raw: string) => ParseResult<TOutput>
  /** Label for logging. Use `name` if you don't need a custom label. */
  label: string
  /** Retry callback. Called before each retry delay. Use () => {} for no-op. */
  onRetry: (attempt: number, maxAttempts: number, errors: string[], delayMs: number) => void
}

// ── Pipeline Events ─────────────────────────────────────────────────────────

export interface StepStartEvent {
  type: 'step:start'
  step: string
  kind: StepKind
  index: number
  total: number
  timestamp: number
}

export interface StepDoneEvent {
  type: 'step:done'
  step: string
  kind: StepKind
  status: 'ok' | 'error'
  error?: string
  elapsedMs: number
  timestamp: number
}

export interface StepHeartbeatEvent {
  type: 'step:heartbeat'
  step: string
  elapsedMs: number
  timestamp: number
}

export interface StepRetryEvent {
  type: 'step:retry'
  step: string
  attempt: number
  maxAttempts: number
  errors: string[]
  delayMs: number
  timestamp: number
}

export interface ToolStartEvent {
  type: 'tool:start'
  step: string
  toolId: string
  toolName: string
  inputSummary?: string
  timestamp: number
}

export interface ToolDoneEvent {
  type: 'tool:done'
  step: string
  toolId: string
  toolName: string
  elapsedMs: number
  outputSummary?: string
  isError?: boolean
  timestamp: number
}

export interface StepTokensEvent {
  type: 'step:tokens'
  step: string
  inputTokens: number
  outputTokens: number
  timestamp: number
}

export interface StepMetaEvent {
  type: 'step:meta'
  step: string
  model: string
  promptLength: number
  rawLength: number
  attempts: number
  timestamp: number
}

export interface StepSessionEvent {
  type: 'step:session'
  step: string
  sessionId: string
  timestamp: number
}

export interface StepOutputLineEvent {
  type: 'step:output-line'
  step: string
  line: string
  timestamp: number
}

export interface FixtureWrittenEvent {
  type: 'fixture:written'
  step: string
  artifact: string
  path: string
  timestamp: number
}

export interface PipelineStartEvent {
  type: 'pipeline:start'
  name: string
  stepCount: number
  version: number
  timestamp: number
}

export interface PipelineDoneEvent {
  type: 'pipeline:done'
  name: string
  status: 'ok' | 'aborted'
  elapsedMs: number
  timestamp: number
}

export type PipelineEvent =
  | PipelineStartEvent
  | PipelineDoneEvent
  | StepStartEvent
  | StepDoneEvent
  | StepHeartbeatEvent
  | StepRetryEvent
  | ToolStartEvent
  | ToolDoneEvent
  | StepTokensEvent
  | StepMetaEvent
  | StepSessionEvent
  | StepOutputLineEvent
  | FixtureWrittenEvent

// ── Pipeline Run Options ────────────────────────────────────────────────────

export interface PipelineRunOptions {
  /** Callback for pipeline lifecycle events. */
  onEvent: (event: PipelineEvent) => void
  /** Heartbeat interval in ms. 0 disables. */
  heartbeatIntervalMs: number
  /** Step name to skip to — null means start from beginning. */
  resumeFrom: string | null
  /** Framework-level logger for pipeline internals (separate from ctx.logger). */
  pipelineLogger: PipelineLogger
}

// ── Pipeline Logger ─────────────────────────────────────────────────────────

export interface PipelineLogger {
  debug(msg: string, data: Record<string, unknown>): void
  info(msg: string, data: Record<string, unknown>): void
  warn(msg: string, data: Record<string, unknown>): void
  error(msg: string, data: Record<string, unknown>): void
}

export const SILENT_LOGGER: PipelineLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

// ── Pipeline Manifest ────────────────────────────────────────────────────────

export type StepKind = 'llm' | 'script' | 'parallel' | 'conditional' | 'pipeline'
export type StepStatus = 'ok' | 'error' | 'skipped'

export interface StepManifestEntry {
  name: string
  kind: StepKind
  status: StepStatus
  elapsedMs: number
  retries: number
  error: string
  /** For conditional steps: which branch was taken. */
  branch?: string
  /** For asStep (pipeline-as-step): nested step entries from child pipeline. */
  substeps?: StepManifestEntry[]
}

export interface PipelineManifest {
  runId: string
  pipelineName: string
  startedAt: string
  completedAt: string
  status: 'ok' | 'aborted'
  steps: StepManifestEntry[]
}

// ── Pipeline Result ──────────────────────────────────────────────────────────

export type PipelineResult<TOutput> =
  | {
      status: 'ok'
      output: TOutput
      manifest: PipelineManifest
      elapsedMs: number
    }
  | {
      status: 'aborted'
      manifest: PipelineManifest
      elapsedMs: number
    }

// ── Pipeline Interface ───────────────────────────────────────────────────────

export interface Pipeline<TInput, TOutput> {
  readonly name: string
  run(input: TInput, ctx: PipelineContext, options: PipelineRunOptions): Promise<PipelineResult<TOutput>>
}

// ── Fixture Validator ────────────────────────────────────────────────────────

export type FixtureValidator<T> = (data: unknown) => data is T

// ── ScriptStepConfig ────────────────────────────────────────────────────────

export interface ScriptStepConfig<TInput, TOutput> {
  name: string
  description: string
  /** Pure transform. May be sync or async. Throws on failure. */
  transform: (input: TInput, ctx: PipelineContext) => TOutput | Promise<TOutput>
}

// ── Parallel ─────────────────────────────────────────────────────────────────

export type ParallelSteps<TInput> = Record<string, Step<TInput, unknown>>

/**
 * Extracts the output type from a Step.
 * Used by parallel() to build the named record output type.
 */
export type StepOutputType<S> = S extends Step<unknown, infer O> ? O : never

// ── Conditional Config ──────────────────────────────────────────────────────

export interface ConditionalConfig<TInput, TOutput> {
  /** Inspects input and returns a branch key. */
  router: (input: TInput) => string
  /** Named branch steps — keys must match router return values. */
  branches: Record<string, Step<TInput, TOutput>>
  /** If set, use this branch key when router returns an unknown key. */
  fallback?: string
}

/** Step subtype returned by conditional() — exposes branch for manifest enrichment. */
export interface ConditionalStep<TInput, TOutput> extends Step<TInput, TOutput> {
  /** Returns the branch key from the last execution (for manifest enrichment). */
  getLastBranch(): string | undefined
}

// ── Step Middleware ──────────────────────────────────────────────────────────

export interface StepMiddleware<TInput, TOutput> {
  /** Transform input before the step executes. */
  before?: (input: TInput, ctx: PipelineContext) => TInput | Promise<TInput>
  /** Transform output after a successful step execution. */
  after?: (output: TOutput, result: StepOk<TOutput>, ctx: PipelineContext) => TOutput | Promise<TOutput>
  /** Handle errors. Return a StepResult to recover, or undefined to propagate. */
  onError?: (error: StepError, ctx: PipelineContext) => StepResult<TOutput> | undefined
}

// ── Pipeline-as-Step (asStep) ──────────────────────────────────────────────

export interface AsStepOptions {
  /** Subdirectory for child pipeline fixtures (scoped under parent's fixture dir). */
  fixtureSubdir?: string
}

/** Step subtype returned by asStep() — exposes substeps for manifest enrichment. */
export interface PipelineStep<TInput, TOutput> extends Step<TInput, TOutput> {
  /** Returns substeps from the last execution (for manifest enrichment). */
  getSubsteps(): StepManifestEntry[] | undefined
}

// ── Manifest Enrichment ─────────────────────────────────────────────────────

/**
 * Optional enrichment data that steps can provide for manifest entries.
 * Used by conditional (branch) and asStep (substeps) steps.
 * The runner checks for this method — no duck-typing, compiler-verified.
 */
export interface StepManifestEnrichment {
  branch?: string
  substeps?: StepManifestEntry[]
}

/** A step that provides extra manifest metadata. Runner detects via this interface. */
export interface EnrichableStep<TInput, TOutput> extends Step<TInput, TOutput> {
  getManifestEnrichment(): StepManifestEnrichment
}
