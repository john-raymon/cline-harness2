import { canonicalSha256 } from "../domain/canonical.ts"
import type { HarnessTree } from "../domain/schemas.ts"
import { PromptError } from "./errors.ts"
import type { Skill } from "./skills.ts"

/**
 * Which parts of the tree become system-prompt text, in which order.
 *
 * The order is this file's, never the tree's. A `HarnessTree` is a plain object, so "insertion order"
 * is whatever the producer happened to do; hashing a prompt built from it would make the same harness
 * produce different digests depending on how it was materialised.
 */

export const SLICE_IDS = ["core", "rules", "memory", "instructions", "skills"] as const
export type SliceId = (typeof SLICE_IDS)[number]

export interface SliceEntry {
  readonly path: string
  readonly body: string
}

export interface RenderedSlice {
  readonly id: SliceId
  /** Tree paths that contributed text. Empty only for the generated `core` slice. */
  readonly paths: readonly string[]
  readonly text: string
  /**
   * Digest of the *inputs*, not only of the rendered text.
   *
   * Rendering normalises (a body without a trailing newline is terminated), so two different trees can
   * render identical bytes. Hashing the raw entries as well means a real change to a rule file always
   * moves this digest, which is what the compiler's gate claims.
   */
  readonly sha256: string
  readonly chars: number
}

/**
 * A block is labelled on both sides.
 *
 * Labels close the seam that unlabelled concatenation leaves open: two files that each end mid-list
 * must not be readable as one file. A body therefore may not contain a fence-shaped line — otherwise
 * one rule file could close its own block and impersonate the next, and the prompt would attribute
 * text to a path that never held it.
 */
function renderBlock(label: string, body: string): string {
  if (/^<<<.*$/m.test(body)) {
    throw new PromptError(
      "PROMPT_SLICE_INVALID",
      `${label} contains a line beginning with "<<<", which can close its own block and impersonate ` +
        "the next file in the prompt; rename or escape it in the harness tree",
    )
  }
  const terminated = body.endsWith("\n") ? body : `${body}\n`
  return `<<<${label}>>>\n${terminated}<<<end ${label}>>>\n`
}

function compare(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function sliceOf(id: SliceId, entries: readonly SliceEntry[], text: string): RenderedSlice {
  const ordered = [...entries].sort((left, right) => compare(left.path, right.path))
  return {
    id,
    paths: ordered.map((entry) => entry.path),
    text,
    chars: text.length,
    sha256: canonicalSha256({
      slice: id,
      text,
      entries: ordered.map((entry) => ({ path: entry.path, body: entry.body })),
    }),
  }
}

/** The one slice this compiler generates instead of reading. */
export function coreSliceText(allowedTools: readonly string[]): string {
  const tools = [...new Set(allowedTools)].sort(compare)
  const lines = [
    "### core",
    "You are the cline-harness2 software agent working in an operator's repository.",
    "The rules below are part of this session's contract; follow them literally.",
    tools.length === 0
      ? "Tool execution is denied by policy for this session. Answer in text."
      : `You may call only these tools: ${tools.join(", ")}. Any other call is refused by policy.`,
  ]
  return `${lines.join("\n")}\n`
}

function fileSlice(id: SliceId, entries: readonly SliceEntry[]): RenderedSlice | undefined {
  if (entries.length === 0) return undefined
  const ordered = [...entries].sort((left, right) => compare(left.path, right.path))
  const text = `### ${id}\n${ordered.map((entry) => renderBlock(entry.path, entry.body)).join("")}`
  return sliceOf(id, ordered, text)
}

export interface CollectSlicesInput {
  readonly tree: HarnessTree
  readonly allowedTools: readonly string[]
  /** Skills mounted for this session; they contribute identity and zero characters. */
  readonly skills?: readonly Skill[]
}

/**
 * Assemble the always-on prompt's slices.
 *
 * A slice with no matching files is omitted rather than emitted empty: a tree that lost `.clinerules`
 * and a tree that never had it produce the same prompt, so they must produce the same hash. Files that
 * match no slice (`tools/*.md`, `.cline/skills/**`) are not prompt text — the tool inventory and the
 * skills mount account for them under their own digests.
 */
export function collectSlices(input: CollectSlicesInput): readonly RenderedSlice[] {
  const rules: SliceEntry[] = Object.keys(input.tree)
    .filter((path) => path.startsWith(".clinerules/"))
    .map((path) => ({ path, body: input.tree[path] ?? "" }))
  const exact = (path: string): SliceEntry[] =>
    Object.hasOwn(input.tree, path) ? [{ path, body: input.tree[path] ?? "" }] : []

  const slices: (RenderedSlice | undefined)[] = [
    sliceOf("core", [], coreSliceText(input.allowedTools)),
    fileSlice("rules", rules),
    // Both memory files are hand-authored or library-rendered text about *this* harness: EXPERIENCE.md
    // is written by people, LongTermMEMORY.md by the lesson library. Same slice, because they answer the
    // same question at prompt time and splitting them would buy nothing but another digest.
    fileSlice("memory", [...exact("EXPERIENCE.md"), ...exact("LongTermMEMORY.md")]),
    fileSlice("instructions", exact("systemprompt.md")),
    // Zero characters, non-zero identity. The body is never inlined (B1): the built-in `skills` tool
    // loads it on demand, so a mounted skill costs a tool entry and no always-on bytes. It still has to
    // appear in `slices`, or two harnesses mounting different skills would compile alike.
    skillsSlice(input.skills ?? []),
  ]
  return slices.filter((slice): slice is RenderedSlice => slice !== undefined)
}

function skillsSlice(skills: readonly Skill[]): RenderedSlice | undefined {
  if (skills.length === 0) return undefined
  // The definition's body is what identifies the skill; companions are listed by path, and their bytes
  // are covered by `Skill.sha256` and by the pinned `treeSha`. Nothing here reaches the prompt.
  const entries = skills.flatMap((skill) => [
    { path: skill.path, body: skill.body },
    ...skill.files
      .filter((path) => path !== skill.path)
      .map((path) => ({ path, body: "" })),
  ])
  return sliceOf("skills", entries, "")
}
