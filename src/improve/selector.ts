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

/** Tokens a model uses when it means "I will not pick one of these". Compared case-insensitively. */
const DECLINE_TOKENS = new Set(["none", "refuse", "refused", "decline", "declined"])

/** Wrappers a model puts around a token it was asked to repeat: backticks, quotes, emphasis, full stop. */
function stripWrappers(value: string, ids: ReadonlySet<string>): string {
  let out = value.trim()
  for (;;) {
    // Never damage a token the gate already accepts: an id may legitimately begin or end with `_` or `*`.
    if (ids.has(out)) return out
    const before = out
    out = out
      .replace(/^[`'"*_]+/, "")
      .replace(/[`'"*_]+$/, "")
      .replace(/[.,;]+$/, "")
      .trim()
    if (out === before) return out
  }
}

export type ChoiceReading =
  | { readonly kind: "candidate"; readonly id: string }
  | { readonly kind: "declined" }
  | { readonly kind: "ambiguous"; readonly mentioned: readonly string[] }
  | { readonly kind: "unknown" }

/** The id a piece of text names outright: the bare id, its wrapper, or its `candidates/<id>/...` context path. */
function exactId(text: string, ids: ReadonlySet<string>): string | undefined {
  const cleaned = stripWrappers(text, ids)
  if (cleaned.length === 0) return undefined
  if (ids.has(cleaned)) return cleaned
  const segments = cleaned.replace(/^(?:\.\/|\/)+/, "").split("/").map((part) => stripWrappers(part, ids))
  const named = segments.length > 1 && segments[0]?.toLowerCase() === "candidates" ? segments[1] : undefined
  return named !== undefined && ids.has(named) ? named : undefined
}

/** Every candidate id that appears as a standalone token anywhere in the text. */
function mentionedIds(text: string, ids: ReadonlySet<string>): string[] {
  const found: string[] = []
  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (new RegExp(`(^|[^A-Za-z0-9._-])${escaped}(?=$|[^A-Za-z0-9._-])`).test(text)) found.push(id)
  }
  return found
}

/**
 * Read a reply as the bare id the gate is going to check.
 *
 * Two things made a live run refuse every selection. The probes reach the model as `candidates/<id>/probe.md`,
 * so the most natural reply names the path it can see (`CHOICE: candidates/exec-2`) rather than the bare id —
 * the prompt and the gate have to encode the same invariant or an obedient model fails the check it was
 * answering. And a decline is a decision: `NONE`/`REFUSED` reported as `SELECTION_UNKNOWN_CANDIDATE` were
 * indistinguishable from an invented id, which threw away the only information the reply carried.
 *
 * A reply with no `CHOICE:` line is still read, but only when it *is* a decision: the whole text, or its
 * first/last non-empty line, has to name one candidate outright. Prose that merely mentions candidate ids is
 * never upgraded into a choice, because "not candidates/exec-2" would then select the very probe it rejected.
 */
export function readChoice(reply: string, ids: ReadonlySet<string>): ChoiceReading {
  const values = [...reply.matchAll(CHOICE_LINE)]
    .map((match) => (match[1] ?? "").trim())
    .filter((value) => value.length > 0)

  if (values.length > 0) {
    const value = values[0] as string
    // `REFUSE: the probes are not comparable` — the decision is the first token, the rest is the reason.
    const head = stripWrappers(value.split(/[:\s]/, 1)[0] ?? "", ids)
    if (DECLINE_TOKENS.has(head.toLowerCase())) return { kind: "declined" }
    const exact = exactId(value, ids)
    if (exact !== undefined) return { kind: "candidate", id: exact }
    // `exec-2 because it cites the rule it applies` — the id is the first token of a sentence.
    const first = stripWrappers(value.split(/\s/, 1)[0] ?? "", ids)
    if (ids.has(first)) return { kind: "candidate", id: first }
    return { kind: "unknown" }
  }

  const trimmed = reply.trim()
  if (trimmed.length === 0) return { kind: "unknown" }

  const wholeExact = exactId(trimmed, ids)
  if (wholeExact !== undefined) return { kind: "candidate", id: wholeExact }

  // A bare decline — `NONE`, `REFUSED`, `REFUSE: ...` — is a decision even without the `CHOICE:` label.
  const bareHead = stripWrappers(trimmed.split(/[:\s]/, 1)[0] ?? "", ids)
  if (DECLINE_TOKENS.has(bareHead.toLowerCase())) return { kind: "declined" }

  // Otherwise only an exact match counts: a sentence that happens to contain an id is prose, not a choice.
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  for (const text of [lines[0] ?? "", lines.at(-1) ?? ""]) {
    const exact = exactId(text, ids)
    if (exact !== undefined) return { kind: "candidate", id: exact }
  }

  const mentioned = mentionedIds(trimmed, ids)
  if (mentioned.length > 1) return { kind: "ambiguous", mentioned }
  return { kind: "unknown" }
}

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
  "change being judged. Put your answer on the very first line of your reply — either `CHOICE: <id>` naming " +
  "exactly one of the listed probe ids, or `CHOICE: NONE` if none of them should be kept. Write nothing " +
  "before that line."

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

  // The bare ids the gate will accept, listed for the model *and* supplied as context. The probes are
  // labelled with their paths, so without this the only identifier visible in the request is
  // `candidates/<id>` — a token the gate does not accept.
  const ids = [...seen]

  const context: RawContextSource[] = [
    { path: "candidates/ids.txt", body: `${ids.join("\n")}\n` },
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

  const baseAsk =
    input.ask === undefined || input.ask.trim().length === 0 ? DEFAULT_SELECTOR_ASK : input.ask.trim()
  // Stated in the ask itself, not only in the context: the rule the gate applies is the rule the model is
  // given, and a naming convention it has to infer from file paths is not a rule it was told.
  const ask =
    `${baseAsk}\n\nValid candidate ids: ${ids.map((id) => `\`${id}\``).join(", ")}. ` +
    "Answer with exactly one of those tokens, not a path such as `candidates/<id>`."

  const reply = await input.selector.select({
    ask,
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
  const reading = readChoice(reply.text, seen)
  if (reading.kind === "candidate") return { status: "selected", reply, candidateId: reading.id }
  if (reading.kind === "declined") {
    return {
      status: "refused",
      code: "SELECTION_MODEL_DECLINED",
      reply,
      reason:
        `the reply declined to choose (${JSON.stringify(choices.at(0) ?? reply.text.trim())}). A decline is a ` +
        "decision, so it is recorded as one rather than as a candidate nobody named",
    }
  }
  if (reading.kind === "ambiguous") {
    return {
      status: "refused",
      code: "SELECTION_UNPARSEABLE",
      reply,
      reason:
        `the reply names ${reading.mentioned.length} candidates (${reading.mentioned.join(", ")}) without a ` +
        "`CHOICE:` line, so there is no decision to record",
    }
  }
  // Nothing usable. With a `CHOICE:` line the model named somebody who is not a candidate; without one it
  // never made a choice at all. Those are different failures and keep different codes.
  if (choices.length > 0) {
    return {
      status: "refused",
      code: "SELECTION_UNKNOWN_CANDIDATE",
      reply,
      reason: `the reply chose ${JSON.stringify(choices.at(0) ?? "")}, which is not one of the candidates ` +
        `(${ids.join(", ")})`,
    }
  }
  return {
    status: "refused",
    code: "SELECTION_UNPARSEABLE",
    reply,
    reason:
      "the reply has no `CHOICE: <candidate>` line and does not name one candidate on its own, so there is " +
      "no decision to record",
  }
}
