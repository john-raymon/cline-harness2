import type { ArbitrationMode } from "../domain/schemas.ts"
import type { ImprovementStage } from "../ledger/events.ts"
import type { RunLedger } from "../ledger/ledger.ts"
import {
  writeArbitrationArtifact,
  type ArbitrationArtifact,
  type ArbitrationArtifactAnswer,
} from "./artifacts.ts"
import type { OracleAsk, OracleClient, OracleReply } from "./client.ts"
import { OracleError } from "./errors.ts"
import type { OracleRole } from "./roles.ts"

/**
 * Two oracles, one question, and no averaging.
 *
 * The whole module exists to answer a question the harness is not allowed to answer by itself: when a
 * second model disagrees with the first, which one is right? Averaging is not an option — a merged
 * answer is an answer neither model produced, and it destroys the only evidence that a decision was
 * contested. So a disagreement is *surfaced*: the primary answer stands as the answer, the second is
 * kept beside it, and the record says `disagreed` and where the texts first diverge.
 *
 * `probe` mode costs a second call per question, so it is off by default and its events never touch
 * the `4k`/`3k` budget.
 */

/** Where two answers first diverge, quoted short enough to keep the artifact readable. */
export interface Divergence {
  readonly line: number
  readonly primary: string
  readonly secondary: string
}

export type ArbitrationOutcomeStatus = "skipped" | "agreed" | "disagreed" | "partial"

export interface ArbitrationOutcome {
  readonly mode: ArbitrationMode
  /** `skipped` means no second call was made — not that the two silently agreed. */
  readonly status: ArbitrationOutcomeStatus
  /** Whatever the primary answered. Always present: a failed probe never loses the answer. */
  readonly primary: OracleReply
  readonly secondary?: OracleReply
  /** Why the outcome is `skipped` or `partial`. */
  readonly reason?: string
  readonly divergence?: Divergence
}

export interface ArbitrateInput {
  readonly mode: ArbitrationMode
  readonly primary: OracleClient
  /** The second opinion. Absent when only one provider is configured. */
  readonly secondary?: OracleClient | undefined
  readonly request: OracleAsk
}

const DIVERGENCE_PREVIEW_CHARS = 200

/**
 * Normalise for comparison only.
 *
 * Line endings, trailing spaces and blank lines at the end carry no meaning in a model answer, and
 * treating them as disagreement would report noise as a finding. Everything *inside* the text is
 * compared as written — including leading lines, because `divergence.line` has to be the line number a
 * reader would count in the verbatim `text` stored beside it.
 */
function comparableLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/, ""))
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

function preview(line: string | undefined): string {
  if (line === undefined) return ""
  return line.length <= DIVERGENCE_PREVIEW_CHARS ? line : `${line.slice(0, DIVERGENCE_PREVIEW_CHARS)}…`
}

/**
 * Compare two answers, exactly.
 *
 * The bias is deliberate and one-directional: two answers that mean the same thing but are worded
 * differently are reported as a disagreement. Calling a real difference "agreement" because a model
 * paraphrased is the failure this module exists to prevent; the reverse costs a human a glance.
 */
export function compareAnswers(
  primaryText: string,
  secondaryText: string,
): { readonly agreed: boolean; readonly divergence?: Divergence } {
  const primary = comparableLines(primaryText)
  const secondary = comparableLines(secondaryText)
  const length = Math.max(primary.length, secondary.length)
  for (let index = 0; index < length; index += 1) {
    if ((primary[index] ?? "") === (secondary[index] ?? "")) continue
    return {
      agreed: false,
      divergence: {
        line: index + 1,
        primary: preview(primary[index]),
        secondary: preview(secondary[index]),
      },
    }
  }
  return { agreed: true }
}

/**
 * Ask both oracles, and say what happened.
 *
 * `off` still asks the primary — the caller needed an answer; what it does not do is spend a second
 * call. A failing second oracle produces `partial` with the answer that did arrive, because losing a
 * good answer to report a transport error is the worst of both outcomes.
 */
export async function arbitrate(input: ArbitrateInput): Promise<ArbitrationOutcome> {
  if (input.mode === "off") {
    const primary = await input.primary.ask(input.request)
    return {
      mode: "off",
      status: "skipped",
      primary,
      reason:
        "arbitration is off by default; a second oracle call is opted into with --arbitration probe",
    }
  }

  if (input.secondary === undefined) {
    const primary = await input.primary.ask(input.request)
    return {
      mode: input.mode,
      status: "skipped",
      primary,
      reason: `probe mode needs a second provider and only ${input.primary.provider} is configured`,
    }
  }

  const primary = await input.primary.ask(input.request)
  let secondary: OracleReply
  try {
    secondary = await input.secondary.ask(input.request)
  } catch (error) {
    if (!(error instanceof OracleError)) throw error
    return {
      mode: input.mode,
      status: "partial",
      primary,
      reason: `${error.code}: ${error.message}`,
    }
  }

  const comparison = compareAnswers(primary.text, secondary.text)
  return comparison.agreed
    ? { mode: input.mode, status: "agreed", primary, secondary }
    : {
        mode: input.mode,
        status: "disagreed",
        primary,
        secondary,
        ...(comparison.divergence === undefined ? {} : { divergence: comparison.divergence }),
      }
}

/**
 * The four oracle roles and the four improvement stages are the same four words.
 *
 * Written as an exhaustive switch rather than a cast so adding a role without deciding which stage it
 * counts as is a compile error, not a silent miscount in `byStage`.
 */
function stageOf(role: OracleRole): ImprovementStage {
  switch (role) {
    case "improver":
      return "improver"
    case "composer":
      return "composer"
    case "selector":
      return "selector"
    case "reflector":
      return "reflector"
  }
}

function answerOf(reply: OracleReply): ArbitrationArtifactAnswer {
  return {
    provider: reply.provider,
    modelId: reply.modelId,
    transport: reply.transport,
    roleId: reply.roleId,
    promptSha256: reply.promptSha256,
    chars: reply.text.length,
    latencyMs: reply.latencyMs,
    text: reply.text,
  }
}

export interface RecordArbitrationInput {
  readonly ledger: Pick<RunLedger, "append">
  readonly runDir: string
  readonly arbitrationId: string
  /** The question both oracles were asked. Frozen with the answers so the pair is self-describing. */
  readonly ask: string
  readonly outcome: ArbitrationOutcome
}

/**
 * Freeze the answers, then leave one compact pointer in the ledger.
 *
 * Order matters: the artifact is durable before the pointer that cites it exists, so a crash between
 * the two leaves evidence no event mentions rather than an event whose evidence was never written.
 * A `skipped` outcome is refused outright — recording it would make "we chose not to probe"
 * indistinguishable from "we probed and found nothing", which is the one thing this module must not
 * do.
 */
export async function recordArbitration(
  input: RecordArbitrationInput,
): Promise<{ readonly path: string; readonly artifactSha256: string }> {
  const { outcome } = input
  if (outcome.status === "skipped") {
    throw new OracleError(
      "ARBITRATION_REFUSED",
      `arbitration ${input.arbitrationId} was skipped (${outcome.reason ?? "no reason given"}); there ` +
        "is no second answer to freeze",
    )
  }

  if (outcome.secondary !== undefined && outcome.secondary.contextSha256 !== outcome.primary.contextSha256) {
    throw new OracleError(
      "ARBITRATION_REFUSED",
      `arbitration ${input.arbitrationId} compared two different contexts ` +
        `(${outcome.primary.contextSha256} vs ${outcome.secondary.contextSha256}); disagreement between ` +
        "answers to different questions is not a finding",
    )
  }

  if (outcome.secondary !== undefined && outcome.secondary.role !== outcome.primary.role) {
    throw new OracleError(
      "ARBITRATION_REFUSED",
      `arbitration ${input.arbitrationId} compared a ${outcome.primary.role} answer with a ` +
        `${outcome.secondary.role} answer; the second role would be recorded as the first`,
    )
  }

  const artifact: ArbitrationArtifact = {
    version: 1,
    status: outcome.status,
    role: outcome.primary.role,
    ask: input.ask,
    contextSha256: outcome.primary.contextSha256,
    answers:
      outcome.secondary === undefined
        ? [answerOf(outcome.primary)]
        : [answerOf(outcome.primary), answerOf(outcome.secondary)],
    failure: outcome.secondary === undefined ? (outcome.reason ?? "no second answer") : null,
    divergence: outcome.divergence ?? null,
  }

  const stored = await writeArbitrationArtifact({ runDir: input.runDir, artifact })

  await input.ledger.append({
    kind: "arbitration.recorded",
    arbitrationId: input.arbitrationId,
    role: stageOf(outcome.primary.role),
    status: outcome.status,
    artifactSha256: stored.sha256,
    contextSha256: outcome.primary.contextSha256,
    primaryProvider: outcome.primary.provider,
    secondaryProvider: outcome.secondary?.provider ?? null,
  })

  return { path: stored.path, artifactSha256: stored.sha256 }
}
