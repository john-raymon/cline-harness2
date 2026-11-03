import { mkdir } from "node:fs/promises"
import path from "node:path"

import { SUBAGENT_CLAIM_ID, assertClaimsSatisfied } from "../adapter/claim-gate.ts"
import { newRunId } from "../adapter/run-dir.ts"
import { LEDGER_FILE_NAME, RunLedger } from "../ledger/ledger.ts"
import type { RunOutcome } from "../ledger/events.ts"
import { buildContractPlugin, validateContractPlugin } from "../plugin/contract.ts"
import { recordingHooks } from "../policy/hooks.ts"
import { toolPolicySetOf, type ToolPolicy } from "../policy/policy.ts"
import { SubagentError, type SubagentDeps, type SubagentParent, type SubagentResult } from "./types.ts"

/**
 * Spawn a child `ClineCore` on the parent's `cwd` (B6).
 *
 * Three things this file refuses to assume, all recorded in `docs/ADAPTER.md`:
 *
 * 1. **A child escapes the parent's gate** unless the gate is installed on the child's own config, so the
 *    policy hooks and the contract plugin are rebuilt for the child rather than inherited.
 * 2. **A child would spend the parent's budget** if it appended to the parent ledger. It does not: this
 *    function never opens the parent's file, and the child gets its own ledger under
 *    `<runDir>/subagents/<childRunId>/`, so "child budget never counted" is a property of the files rather
 *    than a convention. The child is also denied the spawn tool, so it cannot recurse.
 * 3. **A child outlives its parent** unless it is given the parent's deadline, so the budget is one absolute
 *    instant computed before anything is created, not a fresh timer per step.
 */

export const SUBAGENT_TOOL_NAME = "spawn_subagent"
export const SUBAGENT_DIR = "subagents"

const DEFAULT_CHILD_TIMEOUT_MS = 600_000
const CHILD_TEARDOWN_MS = 10_000

interface ChildCore {
  start(input: Record<string, unknown>): Promise<unknown>
  abort(sessionId: string): Promise<unknown>
  dispose(): Promise<unknown>
}

/** What the tool object calls. A closure, not a registry: two sessions in one process must not share it. */
export type SubagentRunner = (input: { task: string }) => Promise<SubagentResult>

export interface SpawnInput {
  readonly parent: SubagentParent
  readonly task: string
  /** Defaults to the parent's remaining time. */
  readonly timeoutMs?: number
  readonly deps?: SubagentDeps
}

/**
 * Run one child to completion.
 *
 * Every early exit happens *before* the child directory exists, because a refused spawn that still left a
 * directory behind would look like a run that was attempted. Every exit after the ledger opens goes through
 * the `finally`, because a child ledger with no `run.finished` cannot be replayed and an unclosed writer
 * keeps its lock until the process exits.
 */
export async function spawnSubagent(input: SpawnInput): Promise<SubagentResult> {
  const { parent } = input
  const deps = input.deps ?? {}
  const now = deps.now ?? (() => new Date())
  const startedAt = now()
  const signal = parent.signal

  if (input.task.trim().length === 0) {
    throw new SubagentError("SUBAGENT_START_FAILED", "a subagent needs a task; the prompt was empty")
  }

  if (signal?.aborted === true) {
    throw new SubagentError("SUBAGENT_START_FAILED", "the parent was aborted before the child started")
  }

  // One absolute deadline, taken before any work. A per-step timer would let setup time spill past the
  // parent's own budget, and `Math.min` means an explicit `timeoutMs` can shorten a child but never extend it
  // beyond what the parent has left.
  const budgetMs = effectiveBudget(input.timeoutMs, parent.remainingMs)
  if (budgetMs <= 0) {
    throw new SubagentError(
      "SUBAGENT_BUDGET_EXHAUSTED",
      `no time left for a subagent: ${budgetMs}ms of budget remained`,
    )
  }
  const deadlineAt = startedAt.getTime() + budgetMs

  // Checked before the child directory or ledger exists, so an unverified runtime leaves no half-created
  // child behind.
  await assertClaimsSatisfied({
    evidencePath: parent.evidencePath,
    installedSdkVersion: parent.installedSdkVersion,
    requiredClaims: [SUBAGENT_CLAIM_ID],
  })

  const childRunId = newRunId(startedAt, deps.random)
  const childDir = path.join(parent.runDir, SUBAGENT_DIR, childRunId)
  await mkdir(childDir, { recursive: true })

  let ledger: RunLedger
  try {
    ledger = await RunLedger.open({ runDir: childDir, k: parent.config.k, now })
  } catch (error) {
    throw new SubagentError(
      "SUBAGENT_LEDGER_FAILED",
      `the child ledger for ${childRunId} could not be claimed: ${describe(error)}`,
      { cause: error },
    )
  }

  const ledgerPath = path.join(childDir, LEDGER_FILE_NAME)
  const childPolicy = policyWithoutSpawn(parent.toolPolicy)
  const recorder = recordingHooks({ policy: childPolicy })

  let core: ChildCore | undefined
  let outcome: RunOutcome = "failed"
  let runStarted = false
  let executionOpened = false
  let failed = false

  try {
    // The child's own identity. `toolPolicySet` is the child's, not the parent's: it carries the shadow ban
    // on the spawn tool, and recording the parent's set would describe a policy this child never ran under.
    // `toolInventoryHash` is shared on purpose — it is the digest of the tree both processes mount.
    await ledger.append({
      kind: "run.started",
      runId: childRunId,
      baselineSha: parent.baselineSha,
      probeSha: null,
      providerId: parent.config.providerId,
      modelId: parent.config.modelId,
      baseUrl: parent.config.baseUrl,
      promptSha256: parent.promptSha256,
      toolPolicySet: toolPolicySetOf(childPolicy),
      toolInventoryHash: parent.toolInventoryHash,
      k: parent.config.k,
    })
    runStarted = true

    const sdk = await (deps.loadSdk ?? defaultLoader)().catch((error: unknown) => {
      throw new SubagentError(
        "SUBAGENT_UNAVAILABLE",
        `@cline/sdk could not be loaded: ${describe(error)}`,
        { cause: error },
      )
    })
    const plugin = buildPlugin(sdk)
    core = await createChildCore(sdk, childRunId)

    // Recorded only once a core exists. Writing them earlier would credit the child with an attempt that
    // never happened when the SDK fails to load, and replay would happily believe the summary.
    await ledger.append({ kind: "execution.started", executionId: childRunId, taskId: childRunId })
    executionOpened = true
    await ledger.append({
      kind: "attempt.recorded",
      attemptId: `${childRunId}-1`,
      of: "execution",
      targetId: childRunId,
      reason: "initial",
    })

    const raw = await withDeadline(
      core,
      childRunId,
      {
        prompt: input.task,
        config: childConfig({ parent, childRunId, hooks: recorder.hooks, plugin }),
      },
      Math.max(1, deadlineAt - now().getTime()),
      signal,
    )

    outcome = "completed"
    return {
      childRunId,
      ledgerPath,
      outcome,
      text: textOf(raw),
      durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
      hookEvidence: recorder.summary(),
    }
  } catch (error) {
    failed = true
    outcome = abortedNow(signal) ? "halted" : "failed"
    throw new SubagentError("SUBAGENT_START_FAILED", `subagent ${childRunId} failed: ${describe(error)}`, {
      cause: error,
    })
  } finally {
    // The runtime is stopped before the record is closed: a child still running would keep writing into the
    // workspace this run owns, and its disposal is bounded so a wedged runtime cannot hang the parent.
    const child = core
    if (child !== undefined) {
      await child.abort(childRunId).catch(() => undefined)
      await settleWithin(() => child.dispose(), CHILD_TEARDOWN_MS)
    }

    try {
      if (executionOpened) {
        await ledger.append({
          kind: "execution.finished",
          executionId: childRunId,
          outcome: executionOutcomeOf(outcome),
        })
      }
      if (runStarted) {
        await ledger.append({
          kind: "run.finished",
          outcome,
          executions: executionOpened ? 1 : 0,
          improvements: 0,
          physicalAttempts: executionOpened ? 1 : 0,
        })
      }
    } catch (error) {
      // A ledger that cannot close its own run is a real failure on the success path. On the failure path the
      // original error is what the caller needs, so it is not replaced.
      if (!failed) {
        throw new SubagentError(
          "SUBAGENT_LEDGER_FAILED",
          `the child ledger for ${childRunId} could not be closed: ${describe(error)}`,
          { cause: error },
        )
      }
    } finally {
      await ledger.close().catch(() => undefined)
    }
  }
}

/**
 * The tool the parent registers so a model can ask for a helper.
 *
 * `B6.subagent` established that an `extraTools` entry which creates its own `ClineCore` really produces a
 * child session on the same `cwd`, so this definition is the production route, not a test fixture.
 */
export function spawnToolDefinition(runner: SubagentRunner): {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly execute: (args: unknown) => Promise<Record<string, unknown>>
} {
  return {
    name: SUBAGENT_TOOL_NAME,
    description:
      "Hand a self-contained task to a subagent that works in the same workspace. " +
      "It inherits this session's tool policy, cannot spawn further subagents, and reports its own result.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The complete task for the subagent, including context." },
      },
      required: ["task"],
      additionalProperties: false,
    },
    execute: async (args: unknown) => {
      const task = (args as { task?: unknown } | null | undefined)?.task
      if (typeof task !== "string") {
        return { ok: false, error: "spawn_subagent requires a string `task`" }
      }
      try {
        const result = await runner({ task })
        return {
          ok: true,
          childRunId: result.childRunId,
          outcome: result.outcome,
          text: result.text,
          ledgerPath: result.ledgerPath,
        }
      } catch (error) {
        // The parent keeps running: a helper that could not start is a failed helper, not a failed run.
        return { ok: false, error: describe(error) }
      }
    },
  }
}

function buildPlugin(sdk: unknown): ReturnType<typeof buildContractPlugin> {
  const createTool = (sdk as { createTool?: (definition: unknown) => unknown }).createTool
  const plugin = buildContractPlugin(createTool === undefined ? {} : { createTool })
  validateContractPlugin(plugin)
  return plugin
}

/**
 * The child's policy: the parent's, minus the spawn tool, which is added to `deny`.
 *
 * Deny wins, so recursion is an explicit refusal in the child's own record instead of an unnamed
 * "not-allowed". A parent with no policy leaves the child with no policy either, which is still default-deny,
 * and that is the only reason `undefined` is allowed to pass through here.
 */
function policyWithoutSpawn(policy: ToolPolicy | undefined): ToolPolicy | undefined {
  if (policy === undefined) return undefined
  return {
    allow: policy.allow.filter((name) => name !== SUBAGENT_TOOL_NAME),
    deny: [...policy.deny.filter((name) => name !== SUBAGENT_TOOL_NAME), SUBAGENT_TOOL_NAME].sort(),
  }
}

/** Read the flag through a call, so a narrowing from an earlier guard cannot turn it into a constant. */
function abortedNow(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

function effectiveBudget(explicit: number | undefined, remaining: number | undefined): number {
  const candidates = [explicit, remaining].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  )
  return candidates.length === 0 ? DEFAULT_CHILD_TIMEOUT_MS : Math.min(...candidates)
}

function executionOutcomeOf(outcome: RunOutcome): "pass" | "fail" | "error" {
  if (outcome === "completed") return "pass"
  return outcome === "halted" ? "fail" : "error"
}

function childConfig(input: {
  readonly parent: SubagentParent
  readonly childRunId: string
  readonly hooks: unknown
  readonly plugin: unknown
}): Record<string, unknown> {
  const { parent } = input
  return {
    sessionId: input.childRunId,
    cwd: parent.harnessDir,
    workspaceRoot: parent.harnessDir,
    providerId: parent.config.providerId,
    modelId: parent.config.modelId,
    baseUrl: parent.config.baseUrl,
    apiKey: parent.apiKey,
    enableTools: true,
    // No recursion: a child that could spawn children would multiply a budget nobody is counting.
    extraTools: [],
    enableSpawnAgent: false,
    enableAgentTeams: false,
    yolo: true,
    checkpoint: { enabled: false },
    maxIterations: parent.maxIterations ?? 4,
    hooks: input.hooks,
    extensions: [input.plugin],
  }
}

/**
 * Create the child runtime.
 *
 * `backendMode: "local"` is not a detail: the parent selects it, `B6.subagent` recorded the spawn against it,
 * and the SDK's auto-discovered hub forwards hooks but drops inline `localRuntime.extensions` — so a child on
 * the wrong backend would run without the contract plugin this function just built for it.
 */
async function createChildCore(sdk: unknown, childRunId: string): Promise<ChildCore> {
  const factory = (sdk as { ClineCore?: { create?: unknown } }).ClineCore
  if (factory === undefined || typeof factory.create !== "function") {
    throw new SubagentError(
      "SUBAGENT_UNAVAILABLE",
      "@cline/sdk does not export ClineCore.create(), so a subagent cannot be started",
    )
  }
  const created = await (
    factory.create as (options?: Record<string, unknown>) => Promise<unknown>
  )({
    clientName: "cline-harness2",
    distinctId: `cline-harness2-${childRunId}`,
    backendMode: "local",
  })
  const core = created as { start?: unknown; abort?: unknown; dispose?: unknown }
  if (typeof core.start !== "function") {
    throw new SubagentError("SUBAGENT_UNAVAILABLE", `child ${childRunId} produced no start() to call`)
  }
  return {
    start: core.start.bind(created) as ChildCore["start"],
    abort: async (sessionId) =>
      typeof core.abort === "function"
        ? (core.abort as (id: string) => Promise<unknown>).call(created, sessionId)
        : undefined,
    dispose: async () =>
      typeof core.dispose === "function"
        ? (core.dispose as () => Promise<unknown>).call(created)
        : undefined,
  }
}

/**
 * Start the child and refuse to wait past the absolute deadline or the parent's abort.
 *
 * The start promise is observed the moment it exists: an early return (parent already aborted) or a lost race
 * would otherwise leave it rejected with nobody listening, which Node reports as an unhandled rejection and
 * which shows up as a crash in the parent process rather than a failed helper.
 */
async function withDeadline(
  core: ChildCore,
  childRunId: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const start = core.start(payload)
  start.catch(() => undefined)

  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  const guards: Promise<never>[] = [
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new SubagentError("SUBAGENT_BUDGET_EXHAUSTED", "the child ran out of time")),
        timeoutMs,
      )
    }),
  ]
  if (signal !== undefined) {
    const parentSignal = signal
    guards.push(
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          // Stopping the clock is not stopping the work: ask the runtime to abort the child it is running.
          void core.abort(childRunId).catch(() => undefined)
          reject(new SubagentError("SUBAGENT_START_FAILED", "the parent was aborted"))
        }
        parentSignal.addEventListener("abort", onAbort, { once: true })
      }),
    )
  }

  try {
    return await Promise.race([start, ...guards])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined && signal !== undefined) signal.removeEventListener("abort", onAbort)
  }
}

/** Wait for a teardown call, but not forever. */
async function settleWithin(run: () => Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      run().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function textOf(raw: unknown): string {
  const result = (raw as { result?: { text?: unknown } } | null | undefined)?.result
  return typeof result?.text === "string" ? result.text : ""
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const defaultLoader = async (): Promise<unknown> => import("@cline/sdk")
