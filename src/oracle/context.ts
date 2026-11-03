import { canonicalSha256, sha256Hex } from "../domain/canonical.ts"
import { isWellFormedText, relPathSchema } from "../domain/schemas.ts"
import { OracleError } from "./errors.ts"
import type { OracleRole } from "./roles.ts"

/**
 * The raw material of an oracle call.
 *
 * "Raw context in every call" is the only gate that makes an oracle's answer attributable. An oracle
 * shown a summary of `e_k` can only propose edits to that summary, and one shown nothing can only
 * guess — so the client accepts no other input than a non-empty set of *verbatim* files and records
 * their digests in the reply. Whatever the oracle read is therefore reconstructable from the ledger
 * without trusting the oracle's own account of it.
 *
 * Order is the caller's and is part of the digest: evidence rows have a sequence, and two calls that
 * supplied the same bytes in a different order asked different questions.
 */

export interface RawContextSource {
  /** Where the text came from: a harness path, or a synthetic label like `evidence/attempt-7`. */
  readonly path: string
  readonly body: string
}

export interface RawContextEntry extends RawContextSource {
  readonly sha256: string
  readonly chars: number
}

export interface RawContext {
  readonly role: OracleRole
  readonly entries: readonly RawContextEntry[]
  /** Digest of every `{path, body}` as supplied — not of the rendering. */
  readonly sha256: string
  readonly chars: number
}

/** A body may not fake a fence. Same rule as the prompt compiler, for the same reason. */
const FENCE_LINE = /^<<<.*$/m

/**
 * Validate, hash and freeze the context for one call.
 *
 * Every refusal here happens before anything is sent, which is why they are distinct codes: a caller
 * that forgot the context and a caller that supplied two files under one path are different bugs, and
 * neither should look like a transport failure.
 */
export function buildRawContext(input: {
  readonly role: OracleRole
  readonly entries: readonly RawContextSource[]
}): RawContext {
  if (input.entries.length === 0) {
    throw new OracleError(
      "RAW_CONTEXT_MISSING",
      `${input.role}: refusing to ask an oracle with no raw context; an answer with no input is a ` +
        "guess that reads like a result",
    )
  }

  const seen = new Set<string>()
  const entries: RawContextEntry[] = []
  for (const source of input.entries) {
    if (!relPathSchema.safeParse(source.path).success) {
      throw new OracleError(
        "RAW_CONTEXT_INVALID",
        `${input.role}: context path ${JSON.stringify(source.path)} is not a safe relative path`,
      )
    }
    if (seen.has(source.path)) {
      throw new OracleError(
        "RAW_CONTEXT_DUPLICATE",
        `${input.role}: context path ${JSON.stringify(source.path)} was supplied twice; two bodies ` +
          "under one label make the rendering ambiguous and the digest dishonest",
      )
    }
    seen.add(source.path)
    if (FENCE_LINE.test(source.body)) {
      throw new OracleError(
        "RAW_CONTEXT_FENCE",
        `${input.role}: ${JSON.stringify(source.path)} contains a line beginning with "<<<", which ` +
          "can close its own block and impersonate the next entry; escape it before asking",
      )
    }
    // A lone surrogate is written to disk (and to UTF-8) as U+FFFD, so the digest would describe bytes
    // that are not the bytes the model reads. The tree store refuses this for the same reason.
    if (!isWellFormedText(source.body)) {
      throw new OracleError(
        "RAW_CONTEXT_INVALID",
        `${input.role}: ${JSON.stringify(source.path)} is not well-formed UTF-16; an unpaired ` +
          "surrogate becomes U+FFFD and the entry could not be re-derived from its digest",
      )
    }
    entries.push({
      path: source.path,
      body: source.body,
      sha256: sha256Hex(source.body),
      chars: source.body.length,
    })
  }

  return {
    role: input.role,
    entries,
    sha256: canonicalSha256({
      role: input.role,
      entries: entries.map((entry) => ({ path: entry.path, body: entry.body })),
    }),
    chars: entries.reduce((total, entry) => total + entry.chars, 0),
  }
}

/**
 * Render the context as labelled blocks.
 *
 * Labelled on both sides, like the prompt compiler: two files that each end mid-list must not be
 * readable as one, and a reply that cites `rules/x.md` must be citing text that file actually held.
 */
export function renderRawContext(context: RawContext): string {
  const blocks: string[] = []
  for (const entry of context.entries) {
    if (FENCE_LINE.test(entry.body)) {
      throw new OracleError(
        "RAW_CONTEXT_FENCE",
        `${context.role}: ${JSON.stringify(entry.path)} contains a line beginning with "<<<"`,
      )
    }
    const label = `context:${entry.path}`
    const body = entry.body.endsWith("\n") ? entry.body : `${entry.body}\n`
    blocks.push(`<<<${label}>>>\n${body}<<<end ${label}>>>`)
  }
  return blocks.join("\n")
}
