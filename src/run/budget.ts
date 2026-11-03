import { expectedExecutions, expectedImprovements } from "../domain/schemas.ts"
import type { RunOutcome } from "../ledger/events.ts"

/**
 * The `4k`/`3k` budget, as a question the loop asks before every step.
 *
 * The ledger already refuses to *record* an attempt past the limit, but a refusal that arrives after the
 * work is done has already spent it. This module answers "may I start?" first, so the budget stops a run
 * rather than describing one that overran. The arithmetic lives in `expectedExecutions` /
 * `expectedImprovements` and is not repeated here — a second copy of `4 * k` is a second thing to keep in
 * step with the ledger.
 */

export const BUDGET_REFUSALS = ["executions-exhausted", "improvements-exhausted"] as const
export type BudgetRefusal = (typeof BUDGET_REFUSALS)[number]

export interface Budget {
  readonly k: number
  readonly maxExecutions: number
  readonly maxImprovements: number
  /** Finished **plus in-flight** executions. This is what the ledger's own limit is checked against. */
  readonly executions: number
  readonly improvements: number
  readonly openExecutions: number
  readonly openImprovements: number
}

export type BudgetAllowance =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason: BudgetRefusal
      readonly used: number
      readonly limit: number
    }

/**
 * Compose a budget from the ledger's counters.
 *
 * `executions`/`improvements` are the ledger's *finished* counters, so in-flight operations are passed
 * separately and added here. The ledger enforces `finished + open + 1 > limit`, and a pre-flight check
 * that ignored the open half would allow a step the writer is about to refuse — the one disagreement
 * this module exists to prevent.
 */
export function budgetOf(input: {
  readonly k: number
  readonly executions: number
  readonly improvements: number
  readonly openExecutions?: number
  readonly openImprovements?: number
}): Budget {
  const openExecutions = input.openExecutions ?? 0
  const openImprovements = input.openImprovements ?? 0
  return {
    k: input.k,
    maxExecutions: expectedExecutions(input.k),
    maxImprovements: expectedImprovements(input.k),
    executions: input.executions + openExecutions,
    improvements: input.improvements + openImprovements,
    openExecutions,
    openImprovements,
  }
}

export function mayStartExecution(budget: Budget): BudgetAllowance {
  return budget.executions < budget.maxExecutions
    ? { ok: true }
    : {
        ok: false,
        reason: "executions-exhausted",
        used: budget.executions,
        limit: budget.maxExecutions,
      }
}

export function mayStartImprovement(budget: Budget): BudgetAllowance {
  return budget.improvements < budget.maxImprovements
    ? { ok: true }
    : {
        ok: false,
        reason: "improvements-exhausted",
        used: budget.improvements,
        limit: budget.maxImprovements,
      }
}

/** What is left of each counter, for a CLI or a status line. Never negative. */
export function remaining(budget: Budget): { executions: number; improvements: number } {
  return {
    executions: Math.max(0, budget.maxExecutions - budget.executions),
    improvements: Math.max(0, budget.maxImprovements - budget.improvements),
  }
}

/**
 * Why a run ended.
 *
 * `improvements-exhausted` is deliberately *not* here. Chunk 19 treated either counter as terminal; the
 * end-to-end loop showed that is wrong. Improvements are work the run chose to do, not work it owes, and a
 * run whose improvement budget is spent still has executions to spend — with `4 * k` executions and `3 * k`
 * improvements, stopping on the improvement counter makes the last execution of every round unreachable. A
 * spent improvement budget therefore stops *improving* (`mayStartImprovement`), and only the execution
 * budget ends the run.
 */
export const STOP_REASONS = ["executions-exhausted", "no-improvement", "error"] as const
export type StopReason = (typeof STOP_REASONS)[number]

export type RunStop =
  | { readonly stop: false }
  | {
      readonly stop: true
      readonly outcome: RunOutcome
      readonly reason: StopReason
      readonly detail: string
    }

export interface StopDecisionInput {
  readonly budget: Budget
  /** Whether the last improvement cycle was accepted. `undefined` means none has run yet. */
  readonly lastImprovementAccepted?: boolean
  /** A failure that ends the run. Checked first: a crash outranks a budget that is about to expire. */
  readonly error?: string
}

/**
 * Whether the run should stop, and why.
 *
 * Budget exhaustion is `completed`, not `halted`: the run did exactly what it was budgeted to do. A run
 * that stops only because the ledger is full should not look like one that gave up. `no-improvement` is
 * `halted`, because an iteration that learned nothing would otherwise repeat itself until the budget ran
 * out, which spends the budget and produces a record of identical attempts.
 */
export function stopDecision(input: StopDecisionInput): RunStop {
  if (input.error !== undefined) {
    // An empty message is still a failure: swallowing it would let a crashed step read as a normal one.
    const detail = input.error.trim().length === 0 ? "unknown failure" : input.error
    return { stop: true, outcome: "failed", reason: "error", detail }
  }

  const executions = mayStartExecution(input.budget)
  if (!executions.ok) {
    // Something is still open. A `run.finished` with `completed` is refused while an operation is
    // unfinished, so the honest answer is "not yet": close it, then ask again.
    if (input.budget.openExecutions > 0) return { stop: false }
    return {
      stop: true,
      outcome: "completed",
      reason: "executions-exhausted",
      detail: `${executions.used} of ${executions.limit} executions used (k=${input.budget.k})`,
    }
  }

  if (input.lastImprovementAccepted === false) {
    return {
      stop: true,
      outcome: "halted",
      reason: "no-improvement",
      detail: "the last improvement cycle produced nothing to carry forward",
    }
  }

  return { stop: false }
}
