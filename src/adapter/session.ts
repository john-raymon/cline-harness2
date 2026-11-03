import { z } from "zod"

import { API_KEY_ENV_CHAIN, type ApiKeySource } from "../config.ts"
import { canonicalSha256 } from "../domain/canonical.ts"
import { sha256HexSchema, type HarnessTree, type RunConfig } from "../domain/schemas.ts"
import { recordingHooks } from "../policy/hooks.ts"
import {
  buildContractPlugin,
  CONTRACT_PLUGIN_NAME,
  CONTRACT_RULE_ID,
  CONTRACT_RULE_TEXT,
  CONTRACT_TOOL_NAME,
  validateContractPlugin,
} from "../plugin/contract.ts"
import { buildToolInventory } from "../policy/inventory.ts"
import {
  allowedToolNames,
  parseToolPolicy,
  toolDecisionSchema,
  toolPolicySetOf,
  type ToolDecision,
  type ToolPolicyInput,
} from "../policy/policy.ts"
import {
  assertToolEntryBudget,
  collectSkills,
  declaredToolEntries,
  SKILLS_TOOL_NAME,
} from "../prompt/skills.ts"
import { assertClaimsSatisfied, requiredClaimsFor } from "./claim-gate.ts"
import { AdapterError } from "./errors.ts"
import { SUBAGENT_TOOL_NAME, spawnSubagent, spawnToolDefinition } from "../subagent/spawn.ts"
import { compilePrompt, PROMPT_SOURCES, type CompiledPrompt } from "../prompt/compile.ts"
import {
  composeProbeFingerprint,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_THINKING,
  probeFingerprintSha256,
  verifyHarnessBaseline,
} from "../fingerprint/probe.ts"
import type { BaselineFingerprint } from "../baseline/fingerprint.ts"
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
/** Tool decisions kept on the record. A session that calls more tools than this is not a probe. */
export const MAX_TOOL_DECISIONS = 64

export const API_KEY_SOURCES = [
  "--api-key",
  ...API_KEY_ENV_CHAIN,
  "absent",
] as const satisfies readonly ApiKeySource[]

/** The slice of `@cline/sdk` this module calls, declared locally rather than imported. */
export interface SdkSlice {
  readonly ClineCore: { create(options?: Record<string, unknown>): Promise<unknown> }
  /** `createTool` when the SDK exposes it; the contract plugin uses it instead of importing the SDK. */
  readonly createTool?: (definition: unknown) => unknown
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
  /**
   * What capture froze for this harness.
   *
   * Required rather than optional: a session that cannot compose a probe fingerprint produced a result
   * that cannot be compared with anything, and an optional field would let that happen silently.
   */
  readonly fingerprint: BaselineFingerprint
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
  /**
   * The task to run. The prompt is compiled here, from `baseline.tree`.
   *
   * Accepting a pre-built prompt would let a caller hand in text compiled from tree A while the session
   * mounts tree B, and every hash in the record would then describe the wrong harness while parsing
   * cleanly.
   */
  readonly task: string
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
  /**
   * What this session may call. Omitted means default-deny.
   *
   * There is deliberately no `hooks` parameter: the gate *is* the policy, and a caller who could pass
   * arbitrary hooks could run a session whose record claims a policy it never installed.
   */
  readonly toolPolicy?: ToolPolicyInput
  readonly maxIterations?: number
  /**
   * Register `spawn_subagent` and require `B6.subagent`.
   *
   * Opt-in rather than always-on: the tool costs a declared entry, and a harness that never delegates should
   * not be refused by a runtime without a verified spawn path.
   */
  readonly subagents?: boolean
  readonly deps?: SessionDeps
}

/**
 * What one bootstrap produced.
 *
 * `apiKeySource` records *which* input supplied the key and never the key; `sha256HexSchema` on the
 * hashes means a record cannot be hand-written into looking valid.
 */
export const sessionBootstrapRecordSchema = z.strictObject({
  version: z.literal(4),
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
  /**
   * Version 3 exists for these three fields.
   *
   * `promptSha256` covers the literal text and therefore includes the task; `compiledPromptHash` covers
   * only what the harness contributed, so two runs of the same harness on different tasks still compare
   * as one harness. `probeFingerprintSha256` says which `ProbeFingerprint` the run belonged to, and
   * `declaredToolEntries` is the size of the tool surface the tree declares — the number the tool-entry
   * budget is enforced against.
   */
  compiledPromptHash: sha256HexSchema,
  probeFingerprintSha256: sha256HexSchema,
  declaredToolEntries: z.int().nonnegative(),
  /**
   * Version 4 exists for these two fields.
   *
   * `contractPlugin` records what the injected plugin actually registered, and `hookEvidence` records which
   * hook phases fired. Without them a record could claim a guard it never installed — `B2.plugin` showed
   * the SDK accepts an over-claiming manifest silently, and `B5.hooks` showed `afterTool` fires even for a
   * refused call, so a phase counter is never evidence that a tool ran.
   */
  contractPlugin: z.strictObject({
    name: z.string().min(1),
    tools: z.array(z.string().min(1)),
    rules: z.array(z.string().min(1)),
    ruleSha256: sha256HexSchema,
  }),
  hookEvidence: z.strictObject({
    beforeRun: z.int().nonnegative(),
    afterRun: z.int().nonnegative(),
    beforeTool: z.int().nonnegative(),
    afterTool: z.int().nonnegative(),
    events: z.int().nonnegative(),
    afterToolOnSkipped: z.int().nonnegative(),
  }),
  /**
   * The policy the session actually ran under, and the inventory it was checked against.
   *
   * Version 2 exists for these three fields: a probe record that omits the policy in force cannot be
   * compared with another probe, because "same result under different permissions" is not the same
   * result. `default:deny` is recorded explicitly rather than as an empty list.
   */
  toolPolicySet: z.array(z.string().min(1)),
  toolInventoryHash: sha256HexSchema,
  toolDecisions: z.array(toolDecisionSchema).max(MAX_TOOL_DECISIONS),
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

  // The inventory is derived from the tree this session will mount, and validated before anything is
  // created: a malformed `tools/` directory is a reason not to make a run directory at all.
  // Snapshot the tree before anything else. `HarnessTree` is a plain object owned by the caller, and
  // every check below is separated from the write that follows by at least one await; reading the
  // caller's object again after verifying it would let a mutation in that window run a harness the
  // fingerprint does not describe. Values are strings, so a shallow copy is a complete snapshot.
  const tree: HarnessTree = { ...input.baseline.tree }
  const baseline = { ...input.baseline, tree }

  // The tree about to be mounted must be the one the baseline describes, and this runs first: every
  // check below is about *this* harness, so drift has to win over a derived complaint like a bad skill
  // name or an over-budget tool list. Both values are caller-supplied and both parse, so without this a
  // session can run harness A while recording harness B.
  verifyHarnessBaseline({
    tree,
    baselineSha: baseline.baselineSha,
    fingerprint: baseline.fingerprint,
  })

  const inventory = buildToolInventory(tree)
  // A mounted skill and the contract tool are only nameable if the policy knows they exist: one comes
  // from a directory, the other from the plugin this session installs.
  const skills = collectSkills(tree)
  const subagentToolName = input.subagents === true ? SUBAGENT_TOOL_NAME : undefined
  const extraKnownTools =
    subagentToolName === undefined
      ? [SKILLS_TOOL_NAME, CONTRACT_TOOL_NAME]
      : [SKILLS_TOOL_NAME, CONTRACT_TOOL_NAME, subagentToolName]
  const policy =
    input.toolPolicy === undefined
      ? undefined
      : parseToolPolicy(input.toolPolicy, inventory, { knownTools: extraKnownTools })
  const toolPolicySet = toolPolicySetOf(policy)

  // Declared entries, checked before anything is created: every tool entry is always-on context the
  // model pays for on every request. A skill and the contract tool each cost exactly one, and the count
  // is a union so a tree that already declares one is not charged twice.
  const toolEntries = assertToolEntryBudget(
    declaredToolEntries(
      inventory,
      skills,
      subagentToolName === undefined
        ? [CONTRACT_TOOL_NAME]
        : [CONTRACT_TOOL_NAME, subagentToolName],
    ),
  )

  // Compiled from the mounted tree, never accepted from the caller, so the prompt, the inventory, the
  // policy and the fingerprint all describe the same harness by construction.
  const prompt = compilePrompt({
    tree,
    task: input.task,
    allowedTools: allowedToolNames(policy),
    skills: skills.skills,
  })

  // Composition happens here, before any directory exists: a fingerprint with a hole in it is a reason
  // not to start a session, not a footnote on a run that already happened.
  const fingerprint = composeProbeFingerprint({
    baseline: baseline.fingerprint,
    prompt,
    toolPolicySet,
    toolInventoryHash: inventory.hash,
    config: input.config,
  })
  const toolDecisions: ToolDecision[] = []
  const hooks = recordingHooks({
    policy,
    onDecision: (decision) => {
      if (toolDecisions.length < MAX_TOOL_DECISIONS) toolDecisions.push(decision)
    },
  })

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
    requiredClaims: requiredClaimsFor(tree, { subagents: input.subagents === true }),
  })

  const runId = input.runId ?? newRunId(startedAt, deps.random)
  const prepared = await prepareRunDir({
    rootDir: input.rootDir ?? input.config.root,
    runId,
    tree,
  })

  const sdk = await (deps.loadSdk ?? defaultSdkLoader)().catch((error: unknown) => {
    throw new AdapterError(
      "SESSION_CREATE_FAILED",
      `@cline/sdk could not be loaded: ${describe(error)}`,
      { cause: error },
    )
  })
  // Built and validated before the runtime exists. `createTool` is the only thing the plugin needs from the
  // SDK, and a plugin that over-claims must fail *before* a core is created — after, the failure would leave
  // an undisposed runtime behind. `B2.plugin` recorded that the SDK accepts an over-claiming manifest
  // silently, so this validation-only load is the only place the over-claim is ever visible.
  const contractPlugin = buildContractPlugin(
    sdk.createTool === undefined ? {} : { createTool: sdk.createTool },
  )
  let contractRegistration: { tools: string[]; rules: string[] }
  try {
    contractRegistration = validateContractPlugin(contractPlugin)
  } catch (error) {
    throw new AdapterError(
      "HARNESS_PLUGIN_FAILED",
      `the contract plugin could not be installed: ${describe(error)}`,
      { cause: error },
    )
  }

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

    // A closure over *this* session's parent facts, so no process-global state decides what a spawn means and
    // two sessions running in one process cannot spawn under each other's paths.
    const extraTools: unknown[] = []
    if (subagentToolName !== undefined) {
      extraTools.push(
        spawnToolDefinition(async ({ task }) =>
        spawnSubagent({
          parent: {
            harnessDir: prepared.harnessDir,
            runDir: prepared.runDir,
            config: input.config,
            toolPolicy: policy,
            baselineSha: input.baseline.baselineSha,
            promptSha256: prompt.sha256,
            toolPolicySet,
            toolInventoryHash: inventory.hash,
            apiKey,
            apiKeySource: input.apiKeySource,
            evidencePath: input.evidencePath,
            installedSdkVersion: input.installedSdkVersion,
            // Recomputed per spawn: a helper asked for late in a run gets what is actually left.
            remainingMs: Math.max(1, timeoutMs - (now().getTime() - startedAt.getTime())),
            signal: input.signal,
            maxIterations: input.maxIterations ?? DEFAULT_MAX_ITERATIONS,
          },
          task,
          deps: input.deps?.loadSdk === undefined ? {} : { loadSdk: input.deps.loadSdk },
        }),
        ),
      )
    }

    const raw = await startWithDeadline({
      core,
      sessionId: runId,
      payload: {
        prompt: prompt.taskPrompt,
        config: sessionConfig({
          runId,
          harnessDir: prepared.harnessDir,
          apiKey,
          prompt,
          config: input.config,
          maxIterations: input.maxIterations ?? DEFAULT_MAX_ITERATIONS,
          hooks: hooks.hooks,
          extensions: [contractPlugin],
          extraTools,
        }),
      },
      timeoutMs,
      teardownMs: teardownTimeoutMs,
      signal: input.signal,
    })

    const result = parseStartResult(raw, runId)
    const durationMs = Math.max(0, Math.round(now().getTime() - startedAt.getTime()))

    const record = {
      version: 4,
      runId,
      runDir: prepared.runDir,
      harnessDir: prepared.harnessDir,
      sessionId: result.sessionId,
      baselineSha: input.baseline.baselineSha,
      providerId: input.config.providerId,
      modelId: input.config.modelId,
      baseUrl: input.config.baseUrl,
      apiKeySource: input.apiKeySource,
      promptSource: prompt.source,
      promptSha256: prompt.sha256,
      compiledPromptHash: prompt.compiledPromptHash,
      probeFingerprintSha256: probeFingerprintSha256(fingerprint),
      declaredToolEntries: toolEntries,
      contractPlugin: {
        name: CONTRACT_PLUGIN_NAME,
        tools: contractRegistration.tools,
        rules: contractRegistration.rules,
        ruleSha256: canonicalSha256(CONTRACT_RULE_TEXT),
      },
      hookEvidence: hooks.summary(),
      toolPolicySet,
      toolInventoryHash: inventory.hash,
      toolDecisions,
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
 * `cwd` and `workspaceRoot` both point at the materialised copy, so a turn *starts* inside a directory
 * this run created and a relative path has nowhere else to go. That is not containment: an allowed tool
 * sees the arguments it is given, and a command with an absolute path reaches whatever the process can.
 * Chunk 7's policy gates which tool may run, not what an allowed tool may touch — confinement is a
 * sandbox question and no chunk has answered it.
 *
 * `checkpoint` is switched off explicitly rather than relying on its default, because a future SDK
 * flipping that default would start taking git stash refs in the operator's repository. `yolo: true`
 * only stops a headless run from waiting on an approval dialog nobody will see; `beforeTool` is the gate.
 */
function sessionConfig(input: {
  runId: string
  harnessDir: string
  apiKey: string
  prompt: CompiledPrompt
  config: RunConfig
  maxIterations: number
  hooks: unknown
  extensions: readonly unknown[]
  extraTools: readonly unknown[]
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
    // `B2.plugin`: `pluginPaths` registered nothing, an object passed here registers its tool and rule.
    extensions: input.extensions,
    // `B6.subagent`: an `extraTools` entry that creates its own core really runs a child on the same `cwd`.
    // Empty unless this session may delegate, so a child can never recurse.
    extraTools: input.extraTools,
    // Sent rather than assumed: the fingerprint records these values, so a value the provider default
    // silently overrode would make the record claim a setting the run never used.
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    thinking: DEFAULT_THINKING,
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
 * Fail-closed default, expressed as the policy module's own hook.
 *
 * `B5.hooks` established that `{ skip: true }` from `beforeTool` really prevents the side effect, so a
 * session's gate is a decision and not a suggestion. There is no standalone deny-all hook any more:
 * `policyHooks({ policy: undefined })` denies every named tool and records the refusal, so the default
 * path and the policy path produce the same kind of evidence.
 */

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
