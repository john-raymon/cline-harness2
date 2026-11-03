import {
  applyTreePatch,
  changedPaths,
  fileBodySchema,
  relPathSchema,
  type HarnessTree,
  type TreePatch,
} from "../domain/schemas.ts"
import { ImproveError } from "./errors.ts"

/**
 * How a proposal is written down.
 *
 * A model answer is prose; a patch is data. Rather than reading meaning out of a paragraph, the improver
 * asks for one fenced block per changed file and refuses anything else. The fence is the same delimiter
 * the prompt compiler and the raw context use, so a body that could forge a block boundary is refused
 * here for the same reason it is refused there.
 *
 * Exported because it is part of the prompt: the format a caller tells the oracle about and the format
 * this parser accepts cannot be allowed to drift apart. It is written with the delimiters *inline*
 * rather than on their own lines on purpose — the oracle client refuses a question containing a line
 * that begins with `<<<`, so that no caller-supplied text can spoof a context block, and this spec has
 * to describe the same fences without tripping that guard.
 */
export const PROPOSAL_FORMAT = [
  "Answer with one block per file you change, and nothing else that claims a change.",
  "Each block is three parts: an opening line reading `<<<proposal:PATH>>>`, then the complete new",
  "contents of that file, then a closing line reading `<<<end proposal:PATH>>>` with the same PATH.",
  "To delete a file, make its body exactly the single line DELETE.",
  "Do not restate unchanged files.",
].join("\n")

const OPEN = /^<<<proposal:(.+)>>>$/
const CLOSE = (path: string): RegExp =>
  new RegExp(`^<<<end proposal:${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>>>$`)
const FENCE_LINE = /^<<<.*$/

const DELETE_SENTINEL = "DELETE"

/**
 * Parse the fenced proposal blocks out of a reply.
 *
 * Deliberately strict: a block that is not closed, a closer that disagrees with its opener, or a second
 * block for the same path is a refusal. Guessing what a malformed block meant is how a patch becomes a
 * surprise, and this is the one place where a surprise reaches the harness.
 */
export function parseProposal(text: string): TreePatch {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const patch: Record<string, string | null> = {}
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ""
    const opened = OPEN.exec(line)
    if (opened === null) {
      // A fence this parser does not recognise *outside* a block is not noise: a typo'd opener or a
      // stray closer would otherwise drop a whole file from the proposal silently, turning a
      // multi-file patch into a partial one that looks complete.
      if (FENCE_LINE.test(line)) {
        throw new ImproveError(
          "PROPOSAL_UNPARSEABLE",
          `unexpected fence line outside any proposal block: ${JSON.stringify(line)}`,
        )
      }
      index += 1
      continue
    }

    const path = opened[1] ?? ""
    // No trimming: `<<<proposal: a.md >>>` and its closer would then disagree, and the resulting error
    // would blame the file's contents. A path with padding is not a path.
    if (path !== path.trim()) {
      throw new ImproveError(
        "PROPOSAL_INVALID",
        `a proposal block names ${JSON.stringify(path)}; a path may not be padded with whitespace`,
      )
    }
    if (!relPathSchema.safeParse(path).success) {
      throw new ImproveError(
        "PROPOSAL_INVALID",
        `a proposal block names ${JSON.stringify(path)}, which is not a safe relative path`,
      )
    }
    if (Object.hasOwn(patch, path)) {
      throw new ImproveError(
        "PROPOSAL_UNPARSEABLE",
        `the proposal changes ${JSON.stringify(path)} twice; two bodies for one file make the result ` +
          "depend on block order",
      )
    }

    const closer = CLOSE(path)
    const body: string[] = []
    index += 1
    let closed = false
    while (index < lines.length) {
      const candidate = lines[index] ?? ""
      if (closer.test(candidate)) {
        closed = true
        index += 1
        break
      }
      if (FENCE_LINE.test(candidate)) {
        throw new ImproveError(
          "PROPOSAL_FENCE",
          `the proposal for ${JSON.stringify(path)} contains a line beginning with "<<<", which can ` +
            "close its own block; escape it in the file contents",
        )
      }
      body.push(candidate)
      index += 1
    }
    if (!closed) {
      throw new ImproveError(
        "PROPOSAL_UNPARSEABLE",
        `the proposal for ${JSON.stringify(path)} is never closed with <<<end proposal:${path}>>>`,
      )
    }

    const joined = body.join("\n")
    // A deletion body is one line reading DELETE. A trailing newline is formatting, so trailing blank
    // lines are tolerated; padding beside the word or leading blank lines are not, because then the
    // block is ambiguous between "delete this file" and "this file's content is the word DELETE".
    const significant = [...body]
    while (significant.length > 0 && significant[significant.length - 1] === "") significant.pop()
    if (significant.length === 1 && significant[0] === DELETE_SENTINEL) {
      patch[path] = null
      continue
    }
    if (joined.trim() === DELETE_SENTINEL) {
      throw new ImproveError(
        "PROPOSAL_INVALID",
        `the proposal for ${JSON.stringify(path)} means to delete the file but pads the body; a ` +
          "deletion body must be the single line DELETE with no leading blank lines or surrounding spaces",
      )
    }
    if (!fileBodySchema.safeParse(joined).success) {
      throw new ImproveError(
        "PROPOSAL_INVALID",
        `the proposed contents of ${JSON.stringify(path)} are not a legal file body`,
      )
    }
    patch[path] = joined
  }

  if (Object.keys(patch).length === 0) {
    throw new ImproveError(
      "PROPOSAL_UNPARSEABLE",
      "the reply contains no proposal block; expected at least one " +
        `<<<proposal:<path>>> … <<<end proposal:<path>>> pair. Got: ${JSON.stringify(
          text.trim().slice(0, 200),
        )}`,
    )
  }
  return patch
}

export interface SelectableProposal {
  readonly patch: TreePatch
  readonly changed: readonly string[]
  readonly tree: HarnessTree
}

/**
 * Decide whether a proposal is a patch or a rewrite.
 *
 * The gate for this chunk is one sentence — proposals are patches, not rewrites — so it needs a rule that
 * can be checked rather than argued about. A patch that touches *every* file in a tree of two or more
 * leaves nothing a reviewer could reject selectively, which is what makes it a replacement harness
 * wearing a patch's clothes. A one-file harness cannot be too broad by definition: changing the only
 * file is the only change available, and refusing it would make small harnesses unimprovable.
 *
 * Deleting everything is refused separately: an empty harness is not an improvement, and a `null` patch
 * would otherwise satisfy "something changed".
 */
export function selectableProposal(base: HarnessTree, patch: TreePatch): SelectableProposal {
  const changed = changedPaths(base, patch)
  if (changed.length === 0) {
    throw new ImproveError(
      "PROPOSAL_EMPTY",
      "the proposal changes nothing: every body it supplies already matches the harness",
    )
  }

  const next = applyTreePatch(base, patch)
  if (Object.keys(next).length === 0) {
    throw new ImproveError(
      "PROPOSAL_EMPTIES_TREE",
      "the proposal removes every file; an empty harness is not an improvement",
    )
  }

  // Count what was touched *of the existing files*, not the size of the patch: a proposal that rewrites
  // every file and adds one more is still a rewrite, and adding files must not mask that.
  const size = Object.keys(base).length
  const touched = changed.filter((path) => Object.hasOwn(base, path))
  if (size >= 2 && touched.length === size) {
    throw new ImproveError(
      "PROPOSAL_TOO_BROAD",
      `the proposal touches all ${size} existing files in the harness (${touched.join(", ")}); a ` +
        "proposal has to be applicable selectively, so a change to every file is a rewrite",
    )
  }

  // `patch` describes what changed: a no-op block or a deletion of a path that was never there is a
  // key that would make `changed` and `patch` disagree about the same proposal.
  const effective: TreePatch = Object.fromEntries(changed.map((path) => [path, patch[path] ?? null]))
  return { patch: effective, changed, tree: next }
}
