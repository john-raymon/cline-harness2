import { z } from "zod"

import { sha256HexSchema } from "../domain/schemas.ts"

/**
 * The `LedgerEvent` schema Chunk 1 deliberately deferred to its owner.
 *
 * One event per line of JSONL, and every event carries its own position: `seq` is contiguous from 1
 * and `at` is the moment the *writer* accepted it, not the caller's idea of time. A record whose
 * ordering has to be inferred from file order is a record that cannot be checked, and checking it is
 * the entire point — `4k` executions and `3k` improvements have to be countable by a reader that was
 * not there when they happened.
 *
 * Every member is a `strictObject`: an unknown field means the writer and the reader disagree about
 * what a run is, and silently dropping it would make two different runs replay identically.
 */

export const LEDGER_EVENT_VERSION = 1

/** Exactly what `Date.prototype.toISOString` emits, so a stored instant always round-trips. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * Identifiers are bounded and shell-safe.
 *
 * They reach filenames, log lines and operator-facing messages, so a newline or a quote here is a
 * log-injection primitive rather than a cosmetic problem.
 */
export const ledgerIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
    "must be 1–128 characters of [A-Za-z0-9._:-] and must start with an alphanumeric",
  )

export const EXECUTION_OUTCOMES = ["pass", "fail", "error"] as const
export const executionOutcomeSchema = z.enum(EXECUTION_OUTCOMES)
export type ExecutionOutcome = z.infer<typeof executionOutcomeSchema>

/**
 * The four oracle stages, in pipeline order.
 *
 * Ordered on purpose: `byStage` is reported in this order, so a replay summary does not depend on
 * which stage happened to run first.
 */
export const IMPROVEMENT_STAGES = ["improver", "composer", "selector", "reflector"] as const
export const improvementStageSchema = z.enum(IMPROVEMENT_STAGES)
export type ImprovementStage = z.infer<typeof improvementStageSchema>

export const IMPROVEMENT_OUTCOMES = ["accepted", "rejected", "error"] as const
export const improvementOutcomeSchema = z.enum(IMPROVEMENT_OUTCOMES)
export type ImprovementOutcome = z.infer<typeof improvementOutcomeSchema>

/**
 * Why a physical attempt happened.
 *
 * `initial` is not optional detail: without it ordinary runs record zero attempts, because every
 * attempt would be a retry of something. Attempts are the physical cost — tokens spent, provider
 * calls made — and they never move the logical `4k`/`3k` counters.
 */
export const ATTEMPT_REASONS = [
  "initial",
  "retry",
  "schema-repair",
  "oracle-substitution",
  /**
   * An overflow that T4 could not fully recover, recorded against the execution it happened in.
   *
   * Folding this into the reason enum rather than adding an event kind keeps `LEDGER_EVENT_VERSION` at 1: the
   * residual is a physical attempt like any other, and a new kind would have forced every v1 fixture and
   * every existing ledger to be re-read for a line that says "still over target by N".
   */
  "overflow-recovery",
] as const
export const attemptReasonSchema = z.enum(ATTEMPT_REASONS)
export type AttemptReason = z.infer<typeof attemptReasonSchema>

export const RUN_OUTCOMES = ["completed", "halted", "failed"] as const
export const runOutcomeSchema = z.enum(RUN_OUTCOMES)
export type RunOutcome = z.infer<typeof runOutcomeSchema>

/**
 * How two oracles answered the same question.
 *
 * `partial` exists because a second opinion that never arrived is not agreement: one answer plus one
 * failure has to be distinguishable from two answers that matched.
 */
export const ARBITRATION_STATUSES = ["agreed", "disagreed", "partial"] as const
export const arbitrationStatusSchema = z.enum(ARBITRATION_STATUSES)
export type ArbitrationStatus = z.infer<typeof arbitrationStatusSchema>

const envelope = {
  version: z.literal(LEDGER_EVENT_VERSION),
  /** Contiguous from 1. A gap means a line was lost or written elsewhere. */
  seq: z.int().positive(),
  at: z.string().regex(ISO_INSTANT, "expected an ISO-8601 instant with milliseconds and a Z suffix"),
}

/**
 * The first event, and the only one that may start a run.
 *
 * `toolPolicySet` and `toolInventoryHash` are caller-supplied identity, exactly like `baselineSha`:
 * this module records the policy a run used, it does not compute one. `probeSha` is the digest of the
 * persisted probe artifact's bytes, or `null` when the run never wrote one — deliberately not a
 * `ProbeFingerprint`, which carries no paths and no timings and is composed in Chunks 7–8.
 */
const runStartedEventSchema = z.strictObject({
  ...envelope,
  kind: z.literal("run.started"),
  runId: ledgerIdSchema,
  baselineSha: sha256HexSchema,
  probeSha: sha256HexSchema.nullable(),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  baseUrl: z.string().min(1),
  promptSha256: sha256HexSchema,
  toolPolicySet: z.array(z.string().min(1)),
  toolInventoryHash: sha256HexSchema,
  k: z.int().positive(),
})

const executionStartedEventSchema = z.strictObject({
  ...envelope,
  kind: z.literal("execution.started"),
  executionId: ledgerIdSchema,
  taskId: ledgerIdSchema,
})

const executionFinishedEventSchema = z.strictObject({
  ...envelope,
  kind: z.literal("execution.finished"),
  executionId: ledgerIdSchema,
  outcome: executionOutcomeSchema,
})

const improvementStartedEventSchema = z.strictObject({
  ...envelope,
  kind: z.literal("improvement.started"),
  improvementId: ledgerIdSchema,
  stage: improvementStageSchema,
})

const improvementFinishedEventSchema = z.strictObject({
  ...envelope,
  kind: z.literal("improvement.finished"),
  improvementId: ledgerIdSchema,
  outcome: improvementOutcomeSchema,
})

const attemptRecordedEventSchema = z.strictObject({
  ...envelope,
  kind: z.literal("attempt.recorded"),
  attemptId: ledgerIdSchema,
  of: z.enum(["execution", "improvement"]),
  targetId: ledgerIdSchema,
  reason: attemptReasonSchema,
})

/**
 * A dual-oracle probe, recorded as a pointer.
 *
 * The two replies live in a content-addressed artifact under `<runDir>/artifacts/`; this event carries
 * only the digest that names it. That keeps `ledger.jsonl` small — every append replays the whole file,
 * so a ledger that inlined two multi-kilobyte model answers would get slower with every disagreement it
 * recorded — and it makes the evidence verifiable: the artifact's bytes are re-hashed on read, so a
 * pointer that no longer matches its file is reported instead of quietly quoted.
 *
 * Adding a kind rather than a reason keeps the *shape* honest: an arbitration probe is not a physical
 * attempt and must not move `physicalAttempts`, which is what `attempt.recorded` would have done.
 * `LEDGER_EVENT_VERSION` stays 1 because every existing v1 event still validates; only new files can
 * carry this kind.
 */
const arbitrationRecordedEventSchema = z.strictObject({
  ...envelope,
  kind: z.literal("arbitration.recorded"),
  arbitrationId: ledgerIdSchema,
  /** Which role was asked. Same four names as the improvement stages, so the two cannot diverge. */
  role: improvementStageSchema,
  status: arbitrationStatusSchema,
  /** Digest of the frozen artifact holding both replies. Verified against the file on read. */
  artifactSha256: sha256HexSchema,
  /** Digest of the raw context both oracles read, so the pair is attributable to one question. */
  contextSha256: sha256HexSchema,
  primaryProvider: z.string().min(1),
  /** `null` for a `partial` probe: the second oracle never answered, so there is no provider to name. */
  secondaryProvider: z.string().min(1).nullable(),
})

const runFinishedEventSchema = z.strictObject({
  ...envelope,
  kind: z.literal("run.finished"),
  outcome: runOutcomeSchema,
  /**
   * Totals as the writer counted them. Replay re-derives these from the events themselves and refuses
   * a mismatch, so a hand-written summary cannot disagree with the record it summarises.
   */
  executions: z.int().nonnegative(),
  improvements: z.int().nonnegative(),
  physicalAttempts: z.int().nonnegative(),
})

export const ledgerEventSchema = z.discriminatedUnion("kind", [
  runStartedEventSchema,
  executionStartedEventSchema,
  executionFinishedEventSchema,
  improvementStartedEventSchema,
  improvementFinishedEventSchema,
  attemptRecordedEventSchema,
  arbitrationRecordedEventSchema,
  runFinishedEventSchema,
])

export type LedgerEvent = z.infer<typeof ledgerEventSchema>

type EnvelopeKey = "version" | "seq" | "at"

/** What a caller hands to `append`; the writer owns the envelope. */
export type LedgerEventInput =
  | Omit<z.infer<typeof runStartedEventSchema>, EnvelopeKey>
  | Omit<z.infer<typeof executionStartedEventSchema>, EnvelopeKey>
  | Omit<z.infer<typeof executionFinishedEventSchema>, EnvelopeKey>
  | Omit<z.infer<typeof improvementStartedEventSchema>, EnvelopeKey>
  | Omit<z.infer<typeof improvementFinishedEventSchema>, EnvelopeKey>
  | Omit<z.infer<typeof attemptRecordedEventSchema>, EnvelopeKey>
  | Omit<z.infer<typeof arbitrationRecordedEventSchema>, EnvelopeKey>
  | Omit<z.infer<typeof runFinishedEventSchema>, EnvelopeKey>

export type RunStartedEvent = z.infer<typeof runStartedEventSchema>
