import type { RunLedger } from "../ledger/ledger.ts"
import { ContextError } from "./errors.ts"
import { detectContext, type ContextAssessment, type ContextThresholds } from "./detector.ts"
import { normalizeMessages } from "./messages.ts"
import { extractiveSummariser, type Summariser } from "./summarise.ts"
import { DEFAULT_ESTIMATOR, MESSAGE_OVERHEAD_TOKENS, type TokenEstimator } from "./tokens.ts"

/** Marker the replacement carries, so a later turn can tell a summary from something the user said. */
export const SUMMARY_PREFIX = "[harness2 T4 summary of earlier turns]"

export type CompactionRefusal =
  | "NOTHING_ELIGIBLE"
  | "TARGET_UNREACHABLE"
  | "TARGET_NOT_MET"
  | "SUMMARY_EMPTY"

export type CompactionResult =
  | { readonly kind: "skipped"; readonly assessment: ContextAssessment }
  | {
      readonly kind: "refused"
      readonly reason: CompactionRefusal
      readonly assessment: ContextAssessment
      /** Estimated tokens that stay above target even at best effort. Zero when the refusal is not about size. */
      readonly residual: number
    }
  | {
      readonly kind: "applied"
      readonly messages: readonly Record<string, unknown>[]
      readonly assessment: ContextAssessment
      /** Re-measured after the rewrite, with the same estimator. */
      readonly postAssessment: ContextAssessment
      readonly summary: string
      readonly summariserId: string
      readonly residual: 0
    }

/**
 * Rewrite the eligible prefix into a summary, keep the tail, and prove the result is smaller.
 *
 * The rewrite is only returned when a re-measure of the assembled messages is at or below `targetTokens`.
 * That check is the difference between "a summariser ran" and "compaction happened": a summariser that
 * returns prose longer than what it replaced would otherwise be reported as a success because it was called.
 *
 * Nothing here talks to the SDK. `registerMessageBuilder` was verified as a hook, not as an async-capable
 * one, so wiring this in is a separate decision with its own evidence. Nothing here writes to the ledger
 * either: `recordOverflowRecovery` does that, and only when the caller has an execution to charge it to.
 */
export async function compactContext(input: {
  readonly messages: unknown
  readonly thresholds: ContextThresholds
  readonly systemPrompt?: string | undefined
  readonly tools?: readonly unknown[] | undefined
  readonly estimator?: TokenEstimator | undefined
  readonly summariser?: Summariser | undefined
}): Promise<CompactionResult> {
  const estimator = input.estimator ?? DEFAULT_ESTIMATOR
  const summariser = input.summariser ?? extractiveSummariser()
  const messages = normalizeMessages(input.messages)

  const measure = (raw: readonly Record<string, unknown>[]): ContextAssessment =>
    detectContext({
      messages: raw,
      thresholds: input.thresholds,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      estimator,
    })

  const assessment = measure(messages.map((message) => message.raw))
  if (assessment.tier === "ok") return { kind: "skipped", assessment }

  const overTarget = Math.max(0, assessment.measurement.total - input.thresholds.targetTokens)
  if (assessment.feasibility.kind === "blocked") {
    const reason: CompactionRefusal = assessment.feasibility.reason
    // Every refusal that happens while over target leaves the same residual: the amount the run will stay
    // over budget by. Reporting zero here because "we could not try" would be indistinguishable from a run
    // that met its target, and there would be nothing to record.
    return { kind: "refused", reason, assessment, residual: overTarget }
  }

  const candidateIndices = new Set(assessment.stubCandidates)
  const spans = contiguousSpans(messages, candidateIndices)

  // One summary per contiguous run, each placed where its run was. A single summary hoisted to the first
  // candidate slot would move the account of late turns in front of turns that never left, inverting the
  // history it is meant to compress.
  const rewritten: Record<string, unknown>[] = []
  const summaries: { readonly summary: string; readonly span: readonly number[] }[] = []
  let index = 0
  let spent = 0
  for (const span of spans) {
    while (index < span.start) {
      const retained = messages[index]
      if (retained !== undefined) rewritten.push(retained.raw)
      index += 1
    }
    const budget = Math.max(0, assessment.feasibility === undefined ? 0 : remainingBudget(assessment, spent))
    const members = messages.slice(span.start, span.end + 1)
    const summary =
      budget === 0
        ? ""
        : (
            await summariser.summarise({
              messages: members,
              budgetTokens: budget,
              estimator,
            })
          ).trim()

    // A run that produced nothing keeps its messages: deleting them would be the one outcome worse than
    // staying over budget.
    if (summary.length === 0) {
      for (const member of members) rewritten.push(member.raw)
    } else {
      rewritten.push({ role: "user", content: `${SUMMARY_PREFIX}\n${summary}` })
      summaries.push({ summary, span: spanIndices(span) })
      spent += estimator.estimateText(summary) + MESSAGE_OVERHEAD_TOKENS
    }
    index = span.end + 1
  }
  while (index < messages.length) {
    const retained = messages[index]
    if (retained !== undefined) rewritten.push(retained.raw)
    index += 1
  }

  if (summaries.length === 0) {
    return { kind: "refused", reason: "SUMMARY_EMPTY", assessment, residual: overTarget }
  }

  const summary = summaries.map((entry) => entry.summary).join("\n")
  const postAssessment = measure(rewritten)
  if (postAssessment.measurement.total > input.thresholds.targetTokens) {
    return {
      kind: "refused",
      reason: "TARGET_NOT_MET",
      assessment,
      residual: postAssessment.measurement.total - input.thresholds.targetTokens,
    }
  }

  return {
    kind: "applied",
    messages: rewritten,
    assessment,
    postAssessment,
    summary,
    summariserId: summariser.id,
    residual: 0,
  }
}

/** A contiguous run of candidate indices, in ascending order. */
interface Span {
  readonly start: number
  readonly end: number
}

function contiguousSpans(
  messages: readonly { readonly index: number }[],
  candidates: ReadonlySet<number>,
): Span[] {
  const spans: Span[] = []
  for (const message of messages) {
    if (!candidates.has(message.index)) continue
    const last = spans[spans.length - 1]
    if (last !== undefined && last.end === message.index - 1) {
      spans[spans.length - 1] = { start: last.start, end: message.index }
      continue
    }
    spans.push({ start: message.index, end: message.index })
  }
  return spans
}

function spanIndices(span: Span): number[] {
  const indices: number[] = []
  for (let index = span.start; index <= span.end; index += 1) indices.push(index)
  return indices
}

/** What is left of the summary budget after the summaries already written. */
function remainingBudget(assessment: ContextAssessment, spent: number): number {
  return assessment.feasibility.kind === "fits" ? assessment.feasibility.summaryBudget - spent : 0
}

/**
 * Log an uncompacted overflow against the execution it happened in.
 *
 * `attempt.recorded` is the right kind: replay counts it as a physical attempt, which is what a residual is —
 * work that happened and could not be reclaimed — and it leaves `LEDGER_EVENT_VERSION` at 1. The event is
 * only valid against an **open** execution, which is why the caller must supply the id rather than this
 * function inventing one.
 */
export async function recordOverflowRecovery(input: {
  readonly ledger: Pick<RunLedger, "append">
  readonly executionId: string
  readonly attemptId: string
  readonly residual: number
}): Promise<void> {
  if (!Number.isSafeInteger(input.residual) || input.residual <= 0) {
    throw new ContextError(
      "CONTEXT_RESIDUAL_INVALID",
      `an overflow recovery records a positive residual, got ${String(input.residual)}; ` +
        "a run that met its target has nothing to record",
    )
  }
  await input.ledger.append({
    kind: "attempt.recorded",
    attemptId: input.attemptId,
    of: "execution",
    targetId: input.executionId,
    reason: "overflow-recovery",
  })
}
