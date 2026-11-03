import type { HarnessTree, TreePatch } from "../domain/schemas.ts"
import type { Improver, OracleReply } from "../oracle/client.ts"
import type { RawContextSource } from "../oracle/context.ts"
import { ImproveError, type ImproveErrorCode } from "./errors.ts"
import { parseProposal, PROPOSAL_FORMAT, selectableProposal } from "./proposal.ts"

/**
 * One improvement step: ask the Improver, then accept only what can be applied selectively.
 *
 * The loop's shape is deliberate. The oracle is *asked* with the whole current harness and the evidence
 * as raw files, and its answer is treated as untrusted input: parsed strictly, validated against the
 * tree, and refused as a typed result when it is a rewrite, a no-op, or prose. A refusal is a normal
 * outcome a run records — not an exception that takes the process down mid-iteration.
 */

export const DEFAULT_IMPROVER_ASK =
  "Propose the smallest change to this harness that the evidence supports. " +
  "Change only the files the change requires."

export interface ProposeImprovementInput {
  readonly improver: Improver
  readonly tree: HarnessTree
  /** Execution rows, attempt records, or any other evidence, as raw files. May be empty on `e_0`. */
  readonly evidence: readonly RawContextSource[]
  readonly ask?: string
  readonly timeoutMs?: number
}

export type ImprovementProposal =
  | {
      readonly status: "proposed"
      readonly reply: OracleReply
      readonly patch: TreePatch
      readonly changed: readonly string[]
      /** `e_{k+1}`: the harness with the proposal applied. */
      readonly tree: HarnessTree
    }
  | {
      readonly status: "refused"
      readonly reply: OracleReply
      readonly code: ImproveErrorCode
      readonly reason: string
    }

/** The harness as raw files, sorted so the same tree always produces the same prompt bytes. */
export function harnessEntries(tree: HarnessTree): RawContextSource[] {
  return Object.keys(tree)
    .sort()
    .map((path) => ({ path, body: tree[path] ?? "" }))
}

export function composeImproverAsk(ask: string | undefined): string {
  const question = ask === undefined || ask.trim().length === 0 ? DEFAULT_IMPROVER_ASK : ask.trim()
  return [question, "", "Write your proposal in exactly this format:", PROPOSAL_FORMAT].join("\n")
}

/** Parse and validate a reply without asking anything. Exposed so the loop can be tested on its own. */
export function acceptProposal(
  reply: OracleReply,
  tree: HarnessTree,
): ImprovementProposal {
  try {
    const patch = parseProposal(reply.text)
    const selectable = selectableProposal(tree, patch)
    return {
      status: "proposed",
      reply,
      patch,
      changed: selectable.changed,
      tree: selectable.tree,
    }
  } catch (error) {
    if (error instanceof ImproveError) {
      return { status: "refused", reply, code: error.code, reason: error.message }
    }
    throw error
  }
}

export async function proposeImprovement(
  input: ProposeImprovementInput,
): Promise<ImprovementProposal> {
  const reply = await input.improver.propose({
    ask: composeImproverAsk(input.ask),
    // The whole harness, verbatim, plus whatever evidence the run has. An Improver shown a summary of
    // `e_k` can only propose edits to the summary.
    context: [...harnessEntries(input.tree), ...input.evidence],
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  })
  return acceptProposal(reply, input.tree)
}
