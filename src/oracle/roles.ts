/**
 * The four jobs an oracle does in the improvement loop.
 *
 * A role is a contract, not a persona: it fixes what the oracle is asked to produce, so the call site
 * cannot drift into asking the Selector to rewrite a harness or the Reflector to pick a winner. The
 * instruction and the reply contract live in one table for the same reason `CONFIG_KEYS` does — a
 * prompt assembled here and a test asserting the prompt cannot describe different roles.
 */

export const ORACLE_ROLES = ["improver", "composer", "selector", "reflector"] as const
export type OracleRole = (typeof ORACLE_ROLES)[number]

export interface OracleRoleSpec {
  readonly role: OracleRole
  /** Stable identifier, so a recorded call says which text asked for it. */
  readonly id: string
  readonly purpose: string
  /** Prepended to every call. Says what to do and what not to do. */
  readonly instruction: string
  /**
   * Lines the reply must carry, in order.
   *
   * Advisory for a model and binding for this module: the client puts every line into the prompt, so
   * the requirement is at least *stated*. Whether a model complies is a model property, and nothing
   * here pretends to have verified one.
   */
  readonly replyContract: readonly string[]
}

export const ORACLE_ROLE_SPECS: Readonly<Record<OracleRole, OracleRoleSpec>> = {
  improver: {
    role: "improver",
    id: "improver-v1",
    purpose: "propose the next harness from the evidence of the current one",
    instruction: [
      "You are the Improver in a harness-improvement loop.",
      "You are given the current harness e_k as raw files and the evidence recorded for it.",
      "Propose the smallest set of edits that would plausibly improve the next execution.",
      "Propose edits, never a replacement harness: a proposal a reviewer cannot apply selectively is",
      "rejected. Do not invent files or results that were not supplied.",
    ].join(" "),
    replyContract: [
      "PATCH <path>: the exact change, as before/after lines",
      "RATIONALE: why this change follows from the supplied evidence",
      "EVIDENCE: the specific rows or files the rationale rests on",
    ],
  },
  composer: {
    role: "composer",
    id: "composer-v1",
    purpose: "assemble and repair prompt and context components",
    instruction: [
      "You are the Composer in a harness-improvement loop.",
      "You are given harness components and the context they will be assembled into.",
      "Assemble the requested component, or repair the one supplied, keeping every fact that the",
      "supplied evidence establishes. Compress by removing redundancy, never by inventing content.",
    ].join(" "),
    replyContract: [
      "COMPOSED <path>: the assembled text",
      "DROPPED: what you removed and why it was redundant",
    ],
  },
  selector: {
    role: "selector",
    id: "selector-v1",
    purpose: "choose between candidates that were probed under one fingerprint",
    instruction: [
      "You are the Selector in a harness-improvement loop.",
      "You are given candidate harnesses and the probes that measured them.",
      "Choose exactly one candidate and justify it from the probe results.",
      "If the probes do not share a fingerprint, refuse: unequal probes are not a comparison.",
    ].join(" "),
    replyContract: [
      "CHOICE: the candidate identifier",
      "WHY: the comparison that decided it",
      "REFUSED: any comparison you would not make, with the reason",
    ],
  },
  reflector: {
    role: "reflector",
    id: "reflector-v1",
    purpose: "turn failures into a transferable lesson",
    instruction: [
      "You are the Reflector in a harness-improvement loop.",
      "You are given the failure rows of an execution.",
      "Extract at most one transferable lesson: what kind of situation this was, what to do about it",
      "in a harness, and which rows support it. A lesson that only restates this task is not a lesson.",
    ].join(" "),
    replyContract: [
      "CUE: the shape of situation, without this task's facts",
      "LESSON: the operation on a harness",
      "EVIDENCE: the rows it rests on",
      "CONFIDENCE: high, medium or low, with the reason",
    ],
  },
}

export function isOracleRole(value: unknown): value is OracleRole {
  return typeof value === "string" && (ORACLE_ROLES as readonly string[]).includes(value)
}

/** The block every call of this role starts with. */
export function roleInstruction(role: OracleRole): string {
  const spec = ORACLE_ROLE_SPECS[role]
  return [
    // The id travels with the prompt so a recorded call says which text asked for it, and a reply
    // that quotes its contract can be matched to it without guessing.
    `Role contract: ${spec.id} (${spec.role})`,
    spec.instruction,
    "",
    "Your reply must contain these lines, in this order:",
    ...spec.replyContract.map((line) => `- ${line}`),
  ].join("\n")
}
