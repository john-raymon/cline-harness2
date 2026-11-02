import { z } from "zod"

import { API_KEY_ENV_CHAIN, type ApiKeySource } from "../config.ts"
import { sha256HexSchema, type HarnessTree, type RunConfig } from "../domain/schemas.ts"
import { assertClaimsSatisfied, requiredClaimsFor } from "./claim-gate.ts"
import { AdapterError } from "./errors.ts"
import { PROMPT_SOURCES, type CompiledPrompt } from "./prompt.ts"
import { newRunId, prepareRunDir } from "./run-dir.ts"

/**
 * The one chunk that starts a real `ClineCore` session.
 *
 * Every SDK value crossing this boundary is `unknown` and is validated here, because the SDK's own
 * declarations decay to `unknown` under `skipLibCheck` (see `EXPERIENCE.md`): a wrong `enableTools`
 * shape or a `result` that is missing its text would otherwise flow straight into the ledger as if it
 * had been checked.
 *
 * What this module deliberately does *not* do: persist anything. Chunk 6 owns run artifacts, so the
 * only durable effect here is the run directory the tree is materialised into.
 */

export const DEFAULT_SESSION_TIMEOUT_MS = 120_000
export const DEFAULT_TEARDOWN_TIMEOUT_MS = 10_000
export const DEFAULT_MAX_ITERATIONS = 2
/** Node clamps a larger delay to 1ms, which would fire the deadline immediately. */
const MAX_TIMEOUT_MS = 2_147_483_647
/** Distinct event types kept on the record. Streaming deltas are many; their *types* are few. */
export const MAX_EVENT_TYPES = 128

export const API_KEY_SOURCES = [
  "--api-key",
  ...API_KEY_ENV_CHAIN,
  "absent",
] as const satisfies readonly ApiKeySource[]

/** The slice of `@cline/sdk` this module calls, declared locally rather than imported. */
export interface SdkSlice {
  readonly ClineCore: { create(options?: Record<string, unknown>): Promise<unknown> }
}
export type SdkLoader = () => Promise<SdkSlice>

interface CoreHandle {
  start(input: Record<string, unknown>): Promise<unknown>
  subscribe(listener: (event: unknown) => void): () => void
  abort(sessionId: string): Promise<unknown>
  dispose(): Promise<unknown>
}

export interface HarnessBaseline {
  readonly tree: HarnessTree
  readonly baselineSha: string
}

export interface SessionDeps {
  readonly loadSdk?: SdkLoader
  readonly now?: () => Date
  readonly random?: () => string
  /** How long to wait for `abort`/`dispose` before giving up on them. */
  readonly teardownTimeoutMs?: number
}

export interface SessionBootstrapInput {
  readonly config: RunConfig
  readonly baseline: HarnessBaseline
  readonly prompt: CompiledPrompt
  readonly apiKeySource: ApiKeySource
  /** Where the spike evidence lives; the gate is the only reader. */
  readonly evidencePath: string
  readonly installedSdkVersion: string
  /** Defaults to `config.root`. */
  readonly rootDir?: string
  /** Defaults to a freshly generated id; tests pin it. */
  readonly runId?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  /** Overrides the deny-all default. Chunk 7 supplies the real policy. */
  readonly hooks?: unknown
  readonly maxIterations?: number
  readonly deps?: SessionDeps
}

/**
 * What one bootstrap produced.
 *
 * `apiKeySource` records *which* input supplied the key and never the key; `sha256HexSchema` on the
 * hashes means a record cannot be hand-written into looking valid.
 */
export const sessionBootstrapRecordSchema = z.strictObject({
  version: z.literal(1),
  runId: z.string().min(1),
  runDir: z.string().min(1),
  harnessDir: z.string().min(1),
  sessionId: z.string().min(1),
  baselineSha: sha256HexSchema,
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  baseUrl: z.string().min(1),
  apiKeySource: z.enum(API_KEY_SOURCES),
  promptSource: z.enum(PROMPT_SOURCES),
  promptSha256: sha256HexSchema,
  eventCount: z.int().nonnegative(),
  eventTypes: z.array(z.string().min(1)),
  turns: z.int().nonnegative(),
  finishReason: z.string().min(1).nullable(),
  text: z.string(),
  toolCallCount: z.int().nonnegative(),
  pluginIssues: z.array(z.string()),
  manifestPath: z.string().min(1).nullable(),
  messagesPath: z.string().min(1).nullable(),
  durationMs: z.int().nonnegative(),
})

export type SessionBootstrapRecord = z.infer<typeof sessionBootstrapRecordSchema>

/**
 * The start result, as far as this module trusts it.
 *
 * `looseObject` because the SDK adds fields between releases and rejecting a new one would make the
 * adapter refuse a perfectly good session; the fields we *do* read are typed.
 */
const startResultSchema = z.looseObject({
  sessionId: z.string().min(1),
  manifestPath: z.string().min(1).optional(),
  messagesPath: z.string().min(1).optional(),
  result: z
    .looseObject({
      text: z.string(),
      iterations: z.number().optional(),
      finishReason: z.unknown().optional(),
      toolCalls: z.array(z.unknown()).optional(),
    })
    .optional(),
  pluginIssues: z.array(z.unknown()).optional(),
})

export async function bootstrapSession(
  input: SessionBootstrapInput,
): Promise<SessionBootstrapRecord> {
  const deps = input.deps ?? {}
  const now = deps.now ?? (() => new Date())
  const startedAt = now()
  const timeoutMs = normaliseTimeout(input.timeoutMs, DEFAULT_SESSION_TIMEOUT_MS, "timeoutMs")
  const teardownTimeoutMs = normaliseTimeout(
    deps.teardownTimeoutMs,
    DEFAULT_TEARDOWN_TIMEOUT_MS,
    "teardownTimeoutMs",
  )

  const apiKey = input.config.apiKey
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new AdapterError(
      "API_KEY_MISSING",
      "no API key reached the session; supply --api-key or one of the SOLVER_* variables " +
        "(docs/ADAPTER.md lists the precedence order)",
    )
  }

  // Pre-flight before any filesystem or SDK work: a claim this session depends on being unverified is
  // a reason not to create a run directory at all.
  await assertClaimsSatisfied({
    evidencePath: input.evidencePath,
    installedSdkVersion: input.installedSdkVersion,
    requiredClaims: requiredClaimsFor(input.baseline.tree),
  })

  const runId = input.runId ?? newRunId(startedAt, deps.random)
  const prepared = await prepareRunDir({
    rootDir: input.rootDir ?? input.config.root,
    runId,
    tree: input.baseline.tree,
  })

  const sdk = await (deps.loadSdk ?? defaultSdkLoader)().catch((error: unknown) => {
    throw new AdapterError(
      "SESSION_CREATE_FAILED",
      `@cline/sdk could not be loaded: ${describe(error)}`,
      { cause: error },
    )
  })
  const core = await createCore(sdk, runId)

  const eventTypes: string[] = []
  let eventCount = 0
  let unsubscribe: (() => void) | undefined
  let failed = false

  try {
    try {
      unsubscribe = core.subscribe((event) => {
        eventCount += 1
        const type = eventTypeOf(event)
        if (type === null || eventTypes.length >= MAX_EVENT_TYPES) return
        if (!eventTypes.includes(type)) eventTypes.push(type)
      })
    } catch (error) {
      throw new AdapterError(
        "SESSION_CREATE_FAILED",
        `session ${runId} could not be subscribed to: ${describe(error)}`,
        { cause: error },
      )
    }

    const raw = await startWithDeadline({
      core,
      sessionId: runId,
      payload: {
        prompt: input.prompt.taskPrompt,
        config: sessionConfig({
          runId,
          harnessDir: prepared.harnessDir,
          apiKey,
          prompt: input.prompt,
          config: input.config,
          maxIterations: input.maxIterations ?? DEFAULT_MAX_ITERATIONS,
          hooks: input.hooks ?? denyAllToolHooks(),
        }),
      },
      timeoutMs,
      teardownMs: teardownTimeoutMs,
      signal: input.signal,
    })

    const result = parseStartResult(raw, runId)
    const durationMs = Math.max(0, Math.round(now().getTime() - startedAt.getTime()))

    const record = {
      version: 1,
      runId,
      runDir: prepared.runDir,
      harnessDir: prepared.harnessDir,
      sessionId: result.sessionId,
      baselineSha: input.baseline.baselineSha,
      providerId: input.config.providerId,
      modelId: input.config.modelId,
      baseUrl: input.config.baseUrl,
      apiKeySource: input.apiKeySource,
      promptSource: input.prompt.source,
      promptSha256: input.prompt.sha256,
      eventCount,
      eventTypes,
      turns: result.turns,
      finishReason: result.finishReason,
      text: result.text,
      toolCallCount: result.toolCallCount,
      pluginIssues: result.pluginIssues,
      manifestPath: result.manifestPath,
      messagesPath: result.messagesPath,
      durationMs,
    }

    try {
      return sessionBootstrapRecordSchema.parse(record)
    } catch (error) {
      // A schema failure on data this module just built is our bug, not the SDK's; wrapping it keeps
      // every adapter failure carrying a code instead of leaking a bare ZodError.
      throw new AdapterError(
        "SESSION_INVALID_RESULT",
        `the bootstrap record for ${runId} failed its own schema: ${describeAnyIssue(error)}`,
        { cause: error },
      )
    }
  } catch (error) {
    failed = true
    throw error
  } finally {
    // Teardown runs in a fixed order and never replaces the error that caused it: an unsubscribe that
    // throws is noise, and a dispose failure only matters when the session itself succeeded.
    if (unsubscribe !== undefined) {
      try {
        unsubscribe()
      } catch {
        // ignored on purpose — dispose below is what actually releases the runtime
      }
    }
    const outcome = await settleWithin(() => core.dispose(), teardownTimeoutMs)
    if (!failed && outcome.status !== "ok") {
      // A runtime that will not release is worth reporting on the success path: the alternative is a
      // live agent nobody owns. On the failure path it is swallowed so it cannot hide the real error.
      throw new AdapterError(
        "SESSION_DISPOSE_FAILED",
        outcome.status === "timeout"
          ? `session ${runId} finished but its runtime did not dispose within ${teardownTimeoutMs}ms, ` +
              "so it may still be running"
          : `session ${runId} finished but its runtime would not dispose, so it may still be ` +
              `running: ${describe(outcome.error)}`,
        { cause: outcome.status === "failed" ? outcome.error : undefined },
      )
    }
  }
}

interface StartResult {
  readonly sessionId: string
  readonly manifestPath: string | null
  readonly messagesPath: string | null
  readonly turns: number
  readonly finishReason: string | null
  readonly text: string
  readonly toolCallCount: number
  readonly pluginIssues: readonly string[]
}

/**
 * Turn an `unknown` start result into something the record can carry.
 *
 * A session that resolves without `result` did not complete a turn, and one whose text is empty
 * produced nothing to measure. Both are failures of this chunk's gate, so both throw — and the message
 * carries `finishReason`/`iterations` because "the loop hit its cap" and "the provider said stop" are
 * different bugs that look identical from the outside.
 */
function parseStartResult(raw: unknown, runId: string): StartResult {
  const parsed = startResultSchema.safeParse(raw)
  if (!parsed.success) {
    throw new AdapterError(
      "SESSION_INVALID_RESULT",
      `session ${runId} resolved with a result this adapter cannot read: ${describeIssue(parsed.error)}`,
    )
  }

  const value = parsed.data
  const result = value.result
  if (result === undefined) {
    throw new AdapterError(
      "SESSION_INVALID_RESULT",
      `session ${runId} resolved without a result, so no turn completed`,
    )
  }

  const finishReason =
    typeof result.finishReason === "string" && result.finishReason.length > 0
      ? result.finishReason
      : null
  const iterations = result.iterations
  const turns =
    typeof iterations === "number" && Number.isFinite(iterations) && iterations >= 1
      ? Math.trunc(iterations)
      : 1

  if (result.text.trim().length === 0) {
    throw new AdapterError(
      "SESSION_INVALID_RESULT",
      `session ${runId} completed without any text (finishReason=${finishReason ?? "unknown"}, ` +
        `iterations=${iterations === undefined ? "unknown" : String(iterations)})`,
    )
  }

  return {
    sessionId: value.sessionId,
    manifestPath: value.manifestPath ?? null,
    messagesPath: value.messagesPath ?? null,
    turns,
    finishReason,
    text: result.text,
    toolCallCount: result.toolCalls?.length ?? 0,
    pluginIssues: (value.pluginIssues ?? []).map(describePluginIssue),
  }
}

/**
 * The start payload.
 *
 * `cwd` and `workspaceRoot` both point at the materialised copy, so anything the runtime or a tool
 * touches stays inside a directory this run created. `checkpoint` is switched off explicitly rather
 * than relying on its default, because a future SDK flipping that default would start taking git
 * stash refs in the operator's repository. `yolo` is safe here only because `beforeTool` denies every
 * tool: the hook is the gate, and `yolo` merely stops a headless run from waiting on an approval
 * dialog nobody will ever see.
 */
function sessionConfig(input: {
  runId: string
  harnessDir: string
  apiKey: string
  prompt: CompiledPrompt
  config: RunConfig
  maxIterations: number
  hooks: unknown
}): Record<string, unknown> {
  return {
    sessionId: input.runId,
    cwd: input.harnessDir,
    workspaceRoot: input.harnessDir,
    providerId: input.config.providerId,
    modelId: input.config.modelId,
    baseUrl: input.config.baseUrl,
    apiKey: input.apiKey,
    systemPrompt: input.prompt.systemPrompt,
    enableTools: true,
    enableSpawnAgent: false,
    enableAgentTeams: false,
    yolo: true,
    checkpoint: { enabled: false },
    maxIterations: input.maxIterations,
    hooks: input.hooks,
  }
}

/**
 * Fail-closed default for Chunk 5.
 *
 * `B5.hooks` established that `{ skip: true }` from `beforeTool` really prevents the side effect, so
 * this is a gate rather than a suggestion. Chunk 7 replaces it with the tree's actual policy.
 */
export function denyAllToolHooks(): {
  beforeTool: (context: unknown) => { skip: true; appendContext: string }
} {
  return {
    beforeTool: () => ({
      skip: true,
      appendContext:
        "harness2 bootstrap: tool execution is disabled for this session until the tool policy lands",
    }),
  }
}

function eventTypeOf(event: unknown): string | null {
  if (typeof event !== "object" || event === null) return null
  const type = (event as { type?: unknown }).type
  return typeof type === "string" && type.length > 0 ? type : null
}

function describePluginIssue(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "object" && value !== null) {
    const issue = value as {
      name?: unknown
      pluginPath?: unknown
      state?: unknown
      reason?: unknown
    }
    const name = typeof issue.name === "string" ? issue.name : "(unnamed plugin)"
    const at = typeof issue.pluginPath === "string" ? ` at ${issue.pluginPath}` : ""
    const state = typeof issue.state === "string" ? issue.state : "unknown state"
    const reason = typeof issue.reason === "string" ? ` (${issue.reason})` : ""
    return `${name}${at}: ${state}${reason}`
  }
  return String(value)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return "no issue reported"
  const at = issue.path.length === 0 ? "<root>" : issue.path.map(String).join(".")
  return `${at}: ${issue.message}`
}

function describeAnyIssue(error: unknown): string {
  return error instanceof z.ZodError ? describeIssue(error) : describe(error)
}

/**
 * Reject a delay Node would silently reinterpret.
 *
 * `setTimeout` clamps anything above `2**31 - 1` and treats `NaN`/negatives as ~1ms, so a rushed
 * `--timeout 0` would abort the session on the next tick and look like a hung provider.
 */
function normaliseTimeout(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new AdapterError(
      "TIMEOUT_INVALID",
      `${label} must be a positive integer of at most ${MAX_TIMEOUT_MS}ms, got ${String(value)}`,
    )
  }
  return value
}

type SettleOutcome =
  | { readonly status: "ok" }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "timeout" }

/**
 * Wait for a teardown call, but not forever.
 *
 * A session that already hit its deadline must not then hang forever on `abort()`/`dispose()` — that
 * would move the timeout from "bounded turn" to "bounded turn plus an unbounded epilogue".
 */
async function settleWithin(run: () => Promise<unknown>, ms: number): Promise<SettleOutcome> {
  let promise: Promise<unknown>
  try {
    // Called through a thunk so a *synchronous* throw from abort/dispose becomes a "failed" outcome
    // instead of escaping past the deadline and, in the dispose case, masking the real error.
    promise = run()
  } catch (error) {
    return { status: "failed", error }
  }

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<SettleOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), ms)
  })
  const settled = promise.then<SettleOutcome, SettleOutcome>(
    () => ({ status: "ok" }),
    (error: unknown) => ({ status: "failed", error }),
  )
  try {
    return await Promise.race([settled, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function createCore(sdk: SdkSlice, runId: string): Promise<CoreHandle> {
  const factory = (sdk as { ClineCore?: { create?: unknown } }).ClineCore
  if (factory === undefined || typeof factory.create !== "function") {
    throw new AdapterError(
      "SESSION_CREATE_FAILED",
      "@cline/sdk does not export a ClineCore.create(); the adapter cannot start a session",
    )
  }

  let raw: unknown
  try {
    raw = await factory.create({
      clientName: "cline-harness2",
      // A per-run id keeps telemetry attributable without letting the SDK read or write the shared
      // machine id under the operator's real home directory.
      distinctId: `cline-harness2-${runId}`,
      backendMode: "local",
    })
  } catch (error) {
    throw new AdapterError("SESSION_CREATE_FAILED", `ClineCore.create failed: ${describe(error)}`, {
      cause: error,
    })
  }

  return asCoreHandle(raw)
}

/**
 * Structural check of the handle.
 *
 * zod cannot validate a class instance with methods, so the boundary check is a `typeof` sweep over
 * exactly the four calls this module makes. Missing one of them is a create failure, not a later
 * "start is not a function".
 */
function asCoreHandle(value: unknown): CoreHandle {
  const candidate = value as Record<string, unknown> | null
  for (const method of ["start", "subscribe", "abort", "dispose"] as const) {
    if (typeof candidate?.[method] !== "function") {
      throw new AdapterError(
        "SESSION_CREATE_FAILED",
        `ClineCore.create resolved without a ${method}() method, so the handle is not a session`,
      )
    }
  }
  return value as CoreHandle
}

class DeadlineError extends Error {
  override readonly name = "DeadlineError"
  readonly reason: "timeout" | "aborted"

  constructor(reason: "timeout" | "aborted") {
    super(reason === "timeout" ? "session deadline exceeded" : "session aborted")
    this.reason = reason
  }
}

/**
 * Race the first turn against a deadline and the caller's abort signal.
 *
 * `abort` is called with the id *we* supplied, because the id in the result only exists once `start`
 * resolves — the exact case where an abort is needed. Without this a timed-out turn leaves an agent
 * running against a live endpoint with nobody listening.
 */
async function startWithDeadline(options: {
  core: CoreHandle
  sessionId: string
  payload: Record<string, unknown>
  timeoutMs: number
  teardownMs: number
  signal: AbortSignal | undefined
}): Promise<unknown> {
  const { signal } = options
  if (signal?.aborted === true) {
    throw new AdapterError(
      "SESSION_ABORTED",
      `session ${options.sessionId} was aborted before it started`,
    )
  }

  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineError("timeout")), options.timeoutMs)
  })
  const racers: Promise<never>[] = [deadline]

  if (signal !== undefined) {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new DeadlineError("aborted"))
      signal.addEventListener("abort", onAbort, { once: true })
    })
    racers.push(aborted)
  }

  try {
    // Called inside the try so a synchronous throw from start() is reported the same way as a rejected
    // promise instead of escaping as a bare Error.
    const starting = options.core.start(options.payload)
    return await Promise.race([starting, ...racers])
  } catch (error) {
    if (error instanceof DeadlineError) {
      await settleWithin(() => options.core.abort(options.sessionId), options.teardownMs)
      throw new AdapterError(
        error.reason === "timeout" ? "SESSION_TIMEOUT" : "SESSION_ABORTED",
        error.reason === "timeout"
          ? `session ${options.sessionId} did not complete a turn within ${options.timeoutMs}ms; ` +
              "aborted it rather than leaving it running"
          : `session ${options.sessionId} was aborted by the caller; aborted it`,
      )
    }
    throw new AdapterError(
      "SESSION_START_FAILED",
      `session ${options.sessionId} failed: ${describe(error)}`,
      { cause: error },
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort)
    }
  }
}

/**
 * Imported lazily and only here.
 *
 * `@cline/sdk` latches `HOME` when it initialises its SQLite stores, so whoever owns the process must
 * be able to set that up before this runs. A static import would evaluate the SDK while the module
 * graph loads, long before any caller could redirect it.
 */
const defaultSdkLoader: SdkLoader = async () =>
  (await import("@cline/sdk")) as unknown as SdkSlice
