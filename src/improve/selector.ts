import type { OracleReply, Selector } from "../oracle/client.ts"
import type { RawContextSource } from "../oracle/context.ts"
import { sha256HexSchema } from "../domain/schemas.ts"
import type { ImproveErrorCode } from "./errors.ts"

/**
 * Choosing between candidates, but only between *comparable* ones.
 *
 * A selection is a matched-contrast decision: candidate A is better than B because both were measured
 * under the same fingerprint, so the only thing that differs between the probes is the harness. If the
 * fingerprints disagree the comparison is confounded — a faster run might be a different model, a
 * different tool policy, a dirty tree — and the honest answer is to refuse rather than to pick the
 * number that looks better.
 *
 * The check is deterministic and runs before the oracle is asked. The oracle is *also* told the digests,
 * because a Selector that will not refuse a confounded comparison is not doing the job this chunk hired
 * it for; but the harness does not depend on the model's compliance.
 */

export interface Candidate {
  readonly id: string
  /** Digest of the `ProbeFingerprint` the candidate was measured under. */
  readonly fingerprintSha256: string
  /** The measurement itself: whatever the probe produced, as text. */
  readonly probe: string
}

export interface BaselineProbe {
  readonly id: string
  readonly fingerprintSha256: string
}

export interface SelectCandidateInput {
  readonly selector: Selector
  readonly baseline: BaselineProbe
  readonly candidates: readonly Candidate[]
  readonly ask?: string
  readonly timeoutMs?: number
}

export type SelectionResult =
  | { readonly status: "selected"; readonly reply: OracleReply; readonly candidateId: string }
  | {
      readonly status: "refused"
      readonly code: ImproveErrorCode
      readonly reason: string
      readonly reply?: OracleReply
    }

const CHOICE_LINE = /^CHOICE:[^\S\r\n]*(.+?)[^\S\r\n]*$/gm

export const DEFAULT_SELECTOR_ASK =
  "Choose exactly one candidate from the probes below. They were all measured against the baseline " +
  "under the same fingerprint; if any digest differs, refuse instead of choosing."

/** A digest, not a placeholder: two empty strings must never "match" each other. */
function isDigest(value: string): boolean {
  return sha256HexSchema.safeParse(value).success
}

export async function selectCandidate(input: SelectCandidateInput): Promise<SelectionResult> {
  const seen = new Set<string>()
  const mismatched: string[] = []

  if (!isDigest(input.baseline.fingerprintSha256)) {
    return {
      status: "refused",
      code: "SELECTION_UNMATCHED",
      reason:
        `the baseline fingerprint ${JSON.stringify(input.baseline.fingerprintSha256)} is not a sha256 ` +
        "digest, so no probe can be shown to match it",
    }
  }

  for (const candidate of input.candidates) {
    if (seen.has(candidate.id)) {
      return {
        status: "refused",
        code: "SELECTION_UNPARSEABLE",
        reason: `candidate id ${JSON.stringify(candidate.id)} appears twice; a choice between two ` +
          "rows with one name is not attributable",
      }
    }
    seen.add(candidate.id)
    if (candidate.fingerprintSha256 !== input.baseline.fingerprintSha256) {
      mismatched.push(`${candidate.id} (${candidate.fingerprintSha256})`)
    }
  }
  if (input.candidates.length === 0) {
    return {
      status: "refused",
      code: "SELECTION_UNMATCHED",
      reason: "there are no candidates to compare",
    }
  }

  const context: RawContextSource[] = [
    {
      path: `baseline/${input.baseline.id}/fingerprint.sha256`,
      body: `${input.baseline.fingerprintSha256}\n`,
    },
    ...input.candidates.flatMap((candidate) => [
      { path: `candidates/${candidate.id}/fingerprint.sha256`, body: `${candidate.fingerprintSha256}\n` },
      { path: `candidates/${candidate.id}/probe.md`, body: candidate.probe },
    ]),
  ]

  // A confounded contrast is refused before the call: the answer would be about two different
  // questions, and paying for it would only make the mistake more expensive.
  if (mismatched.length > 0) {
    return {
      status: "refused",
      code: "SELECTION_UNMATCHED",
      reason:
        `the probes do not share the baseline fingerprint (${input.baseline.fingerprintSha256}): ` +
        `${mismatched.join(", ")}. Unequal probes are not a comparison`,
    }
  }

  const reply = await input.selector.select({
    ask: input.ask === undefined || input.ask.trim().length === 0 ? DEFAULT_SELECTOR_ASK : input.ask,
    context,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  })

  const choices = [...reply.text.matchAll(CHOICE_LINE)]
    .map((match) => (match[1] ?? "").trim())
    .filter((value) => value.length > 0)
  if (choices.length > 1) {
    return {
      status: "refused",
      code: "SELECTION_UNPARSEABLE",
      reply,
      reason: `the reply names ${choices.length} choices (${choices.join(", ")}); a selection has to be one`,
    }
  }
  const chosen = choices.at(0) ?? ""
  if (chosen.length === 0) {
    return {
      status: "refused",
      code: "SELECTION_UNPARSEABLE",
      reply,
      reason: "the reply contains no `CHOICE: <candidate>` line, so there is no decision to record",
    }
  }
  if (!seen.has(chosen)) {
    return {
      status: "refused",
      code: "SELECTION_UNKNOWN_CANDIDATE",
      reply,
      reason: `the reply chose ${JSON.stringify(chosen)}, which is not one of the candidates ` +
        `(${[...seen].join(", ")})`,
    }
  }
  return { status: "selected", reply, candidateId: chosen }
}
