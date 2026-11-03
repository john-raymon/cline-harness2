import type { OracleReply, Selector } from "../oracle/client.ts"
import type { RawContextSource } from "../oracle/context.ts"
import {
  environmentMismatches,
  type ProbeEnvironment,
} from "../fingerprint/probe.ts"
import { sha256HexSchema } from "../domain/schemas.ts"
import type { ImproveErrorCode } from "./errors.ts"

/**
 * Choosing between candidates, but only between *comparable* ones.
 *
 * A selection is a matched-contrast decision: candidate A is better than B because both were measured
 * under the same *environment*, so the only thing that differs between the probes is the harness. If the
 * environments disagree the comparison is confounded — a faster run might be a different model, a
 * different tool policy, a dirty tree — and the honest answer is to refuse rather than to pick the number
 * that looks better.
 *
 * **What "matched" means, and what it cannot mean.** Chunk 17 compared the whole fingerprint digest, which
 * made the stage unusable: a candidate exists to change the harness, `treeSha`/`compiledPromptHash` move
 * when it does, and `baselineSha` is a digest *over* those fields. Requiring the digests to agree therefore
 * refused every real candidate and left the Selector able to compare a harness only with itself. The gate
 * now compares the invariant projection — repository state, model, endpoint, tool surface, context policy —
 * and lets the harness fields move, which is the entire point of a candidate.
 *
 * A probe with no environment still has to match on the digest: absent evidence is not evidence of a match.
 */

export interface Candidate {
  readonly id: string
  /** Digest of the `ProbeFingerprint` the candidate was measured under. Recorded, not gated. */
  readonly fingerprintSha256: string
  /** The measurement itself: whatever the probe produced, as text. */
  readonly probe: string
  /** The invariant half of that fingerprint. Omitted means the digest check is the only evidence. */
  readonly environment?: ProbeEnvironment
}

export interface BaselineProbe {
  readonly id: string
  readonly fingerprintSha256: string
  readonly environment?: ProbeEnvironment
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

/**
 * The instruction the Selector receives.
 *
 * It said "same fingerprint; if any digest differs, refuse" — which was true of the gate it was written for,
 * and would now be actively harmful: a candidate that edits the harness *must* have a different digest, so an
 * obedient model would refuse exactly the comparison it is being asked to make. The invariant is the
 * environment; the digest moving is the change under review.
 */
export const DEFAULT_SELECTOR_ASK =
  "Choose exactly one of the probes below. They were all measured under the same environment — same " +
  "repository state, model, endpoint, tool policy and context policy — so the only thing that differs " +
  "between them is the harness. Their harness digests do differ, and that is expected: the difference is the " +
  "change being judged. Answer with a single line `CHOICE: <id>` naming one of the listed probe ids."

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

    // Environment first: it is the stronger evidence and the only one a harness change cannot move. The
    // digest comparison is the fallback for probes that carry no environment, never an additional hurdle —
    // a candidate that edits the harness *must* differ in digest, so requiring both would refuse it.
    const bothHaveEnvironment =
      candidate.environment !== undefined && input.baseline.environment !== undefined
    if (bothHaveEnvironment) {
      const differing = environmentMismatches(
        input.baseline.environment as ProbeEnvironment,
        candidate.environment as ProbeEnvironment,
      )
      if (differing.length > 0) {
        mismatched.push(`${candidate.id} (${differing.join(", ")} differ)`)
      }
      continue
    }
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

  const environmentEntry = (id: string, environment: ProbeEnvironment | undefined): RawContextSource[] =>
    environment === undefined
      ? []
      : [{ path: `${id}/environment.json`, body: `${JSON.stringify(environment, null, 2)}\n` }]

  const context: RawContextSource[] = [
    {
      path: `baseline/${input.baseline.id}/fingerprint.sha256`,
      body: `${input.baseline.fingerprintSha256}\n`,
    },
    ...environmentEntry(`baseline/${input.baseline.id}`, input.baseline.environment),
    ...input.candidates.flatMap((candidate) => [
      { path: `candidates/${candidate.id}/fingerprint.sha256`, body: `${candidate.fingerprintSha256}\n` },
      ...environmentEntry(`candidates/${candidate.id}`, candidate.environment),
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
        `the probes are not comparable with the baseline (${input.baseline.id}): ` +
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
