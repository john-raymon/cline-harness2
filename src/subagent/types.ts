import type { ApiKeySource } from "../config.ts"
import type { RunConfig } from "../domain/schemas.ts"
import type { RunOutcome } from "../ledger/events.ts"
import type { HookEvidenceSummary } from "../policy/hooks.ts"
import type { ToolPolicy } from "../policy/policy.ts"

/**
 * Errors a spawn can fail with.
 *
 * None of them may take the parent down: a subagent is an optimisation, and a run that dies because its
 * helper could not start would be worse than a run that did the work itself.
 */
export type SubagentErrorCode =
  | "SUBAGENT_UNAVAILABLE"
  | "SUBAGENT_START_FAILED"
  | "SUBAGENT_LEDGER_FAILED"
  | "SUBAGENT_BUDGET_EXHAUSTED"

export class SubagentError extends Error {
  override readonly name = "SubagentError"
  readonly code: SubagentErrorCode

  constructor(code: SubagentErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
  }
}

/** What the parent hands a child. Everything here is already parsed and verified by the parent. */
export interface SubagentParent {
  /** The materialised harness copy the parent runs in; the child starts in the same directory (B6). */
  readonly harnessDir: string
  /** The parent's run directory. The child gets a subdirectory and the parent ledger is never opened. */
  readonly runDir: string
  readonly config: RunConfig
  /** The parent's *parsed* policy. The child inherits it minus the spawn tool. */
  readonly toolPolicy: ToolPolicy | undefined
  readonly baselineSha: string
  readonly promptSha256: string
  readonly toolPolicySet: readonly string[]
  readonly toolInventoryHash: string
  readonly apiKey: string
  readonly apiKeySource: ApiKeySource
  readonly evidencePath: string
  readonly installedSdkVersion: string
  /** Remaining time from the parent's own deadline, so a child cannot outlive its parent. */
  readonly remainingMs?: number | undefined
  readonly signal?: AbortSignal | undefined
  readonly maxIterations?: number | undefined
}

export interface SubagentResult {
  readonly childRunId: string
  readonly ledgerPath: string
  readonly outcome: RunOutcome
  readonly text: string
  readonly durationMs: number
  readonly hookEvidence: HookEvidenceSummary
}

export interface SubagentDeps {
  readonly loadSdk?: (() => Promise<unknown>) | undefined
  readonly now?: (() => Date) | undefined
  readonly random?: (() => string) | undefined
}
