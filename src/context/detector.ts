import { ContextError } from "./errors.ts"
import { messageGroups, normalizeMessages, tailBoundary } from "./messages.ts"
import { DEFAULT_ESTIMATOR, type TokenEstimator } from "./tokens.ts"

/**
 * The T4 ladder: `tail < target < b1 < b2`.
 *
 * `tier` is a **recommendation**, not a promise. `B4.compaction` is unverified, so a `compact` here says "the
 * hard threshold was crossed", never "a summariser ran". The executor is allowed — and for the SDK's own
 * `compact` hook, required — to refuse, which is why `feasibility` is part of the assessment instead of a
 * separate question the executor has to re-derive.
 */
export type ContextTier = "ok" | "stub" | "compact"

export type SummaryFeasibility =
  | { readonly kind: "fits"; readonly summaryBudget: number }
  | { readonly kind: "blocked"; readonly reason: "NOTHING_ELIGIBLE" | "TARGET_UNREACHABLE" }

export interface ContextThresholds {
  readonly tailTokens: number
  readonly targetTokens: number
  readonly b1Tokens: number
  readonly b2Tokens: number
}

export interface ContextAssessment {
  readonly tier: ContextTier
  readonly measurement: {
    readonly kind: "estimate"
    readonly estimatorId: string
    readonly total: number
    readonly fixed: number
    readonly tail: number
    readonly eligible: number
  }
  readonly tailStart: number
  /** The mandatory final group alone is larger than the tail budget. */
  readonly oversizeTailGroup: boolean
  /** Indices `[0, tailStart)` that may be rewritten. Index 0 and system messages are never candidates. */
  readonly stubCandidates: readonly number[]
  readonly feasibility: SummaryFeasibility
  readonly thresholds: ContextThresholds
  readonly reason: string
}

/** Allowance for the wrapper a summary is delivered in, charged before deciding a target is reachable. */
export const SUMMARY_FRAMING_TOKENS = 200

/**
 * Validate the thresholds this module is about to divide by.
 *
 * The schema already enforces this order, but a hand-built config never passes through it, and `NaN` defeats
 * every natural comparison (`NaN <= x` is false, so an `if (tail >= target)` guard would wave it through).
 * Hence safe integers and a single positively-phrased chain.
 */
export function assertThresholds(input: ContextThresholds): ContextThresholds {
  const entries: readonly (readonly [string, number])[] = [
    ["tailTokens", input.tailTokens],
    ["targetTokens", input.targetTokens],
    ["b1Tokens", input.b1Tokens],
    ["b2Tokens", input.b2Tokens],
  ]
  for (const [name, value] of entries) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ContextError(
        "CONTEXT_THRESHOLDS_INVALID",
        `${name} must be a positive safe integer, got ${String(value)}`,
      )
    }
  }
  const ordered =
    input.tailTokens < input.targetTokens &&
    input.targetTokens < input.b1Tokens &&
    input.b1Tokens < input.b2Tokens
  if (!ordered) {
    throw new ContextError(
      "CONTEXT_THRESHOLDS_INVALID",
      `T4 thresholds must increase tail < target < b1 < b2, got ${input.tailTokens} / ` +
        `${input.targetTokens} / ${input.b1Tokens} / ${input.b2Tokens}`,
    )
  }
  return {
    tailTokens: input.tailTokens,
    targetTokens: input.targetTokens,
    b1Tokens: input.b1Tokens,
    b2Tokens: input.b2Tokens,
  }
}

/**
 * Measure the context and say what, if anything, T4 should do about it.
 *
 * `fixed` is the always-on text the builder never sees (system prompt, tool definitions) and is supplied
 * explicitly: substituting the compiler's character count or a tool-inventory hash for the real text would
 * measure something other than the request. `tail` is the verbatim part, `eligible` is what may be rewritten.
 */
export function detectContext(input: {
  readonly messages: unknown
  readonly thresholds: ContextThresholds
  readonly systemPrompt?: string | undefined
  readonly tools?: readonly unknown[] | undefined
  readonly estimator?: TokenEstimator | undefined
}): ContextAssessment {
  const thresholds = assertThresholds(input.thresholds)
  const estimator = input.estimator ?? DEFAULT_ESTIMATOR
  const messages = normalizeMessages(input.messages)

  const fixed = estimator.estimateText(input.systemPrompt ?? "") + estimator.estimateTools(input.tools)
  let conversation = 0
  for (const message of messages) conversation += estimator.estimateMessage(message)

  const tail = tailBoundary(messages, { tailTokens: thresholds.tailTokens, estimator })

  // Candidates are runs, not indices: a message that belongs to a group is only rewritable together with the
  // rest of it, so enumerating positions would offer a `tool` result for stubbing while its request stayed
  // preserved. The task (index 0) and any system message are standing instruction, never candidates.
  const stubCandidates: number[] = []
  let eligible = 0
  for (const group of messageGroups(messages)) {
    if (group.end >= tail.start) break
    const members = messages.slice(group.start, group.end + 1)
    if (group.start === 0 || members.some((message) => message.role === "system")) continue
    for (const message of members) {
      eligible += estimator.estimateMessage(message)
      stubCandidates.push(message.index)
    }
  }

  const total = fixed + conversation
  const tier: ContextTier =
    total >= thresholds.b2Tokens ? "compact" : total >= thresholds.b1Tokens ? "stub" : "ok"

  // What a summary may cost. `total - eligible` is everything rewriting cannot touch: the always-on text, the
  // preserved tail, the task and any system message in the prefix. Subtracting all of it is the difference
  // between "there is room" and "there is room after the parts you may not change" — the earlier form left
  // out the retained prefix and reported `fits` for targets that a 110k task alone already exceeded.
  const retained = total - eligible
  const summaryBudget = thresholds.targetTokens - retained - SUMMARY_FRAMING_TOKENS
  const feasibility: SummaryFeasibility =
    eligible === 0
      ? { kind: "blocked", reason: "NOTHING_ELIGIBLE" }
      : summaryBudget > 0
        ? { kind: "fits", summaryBudget }
        : { kind: "blocked", reason: "TARGET_UNREACHABLE" }

  return {
    tier,
    measurement: {
      kind: "estimate",
      estimatorId: estimator.id,
      total,
      fixed,
      tail: tail.tokens,
      eligible,
    },
    tailStart: tail.start,
    oversizeTailGroup: tail.oversizeGroup,
    stubCandidates,
    feasibility,
    thresholds,
    reason: describeTier({ tier, total, thresholds, feasibility, estimatorId: estimator.id }),
  }
}

function describeTier(input: {
  readonly tier: ContextTier
  readonly total: number
  readonly thresholds: ContextThresholds
  readonly feasibility: SummaryFeasibility
  readonly estimatorId: string
}): string {
  const measured = `${input.total} estimated tokens (${input.estimatorId})`
  if (input.tier === "ok") {
    return `${measured} is below b1=${input.thresholds.b1Tokens}; no T4 action`
  }
  const verb = input.tier === "compact" ? "compact" : "stub"
  const blocked =
    input.feasibility.kind === "blocked" ? `, but ${input.feasibility.reason} — the executor must refuse` : ""
  const limit = input.tier === "compact" ? input.thresholds.b2Tokens : input.thresholds.b1Tokens
  return `${measured} crossed the ${verb} threshold at ${limit}${blocked}`
}
