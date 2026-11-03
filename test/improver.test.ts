import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { applyTreePatch, changedPaths, type HarnessTree } from "../src/domain/schemas.ts"
import { ImproveError } from "../src/improve/errors.ts"
import {
  acceptProposal,
  composeImproverAsk,
  harnessEntries,
  proposeImprovement,
} from "../src/improve/improver.ts"
import { parseProposal, PROPOSAL_FORMAT, selectableProposal } from "../src/improve/proposal.ts"
import { oracleRoles, type OracleReply } from "../src/oracle/client.ts"
import { geminiAnswer, geminiClient, scripted } from "./support/oracle-fixtures.ts"

/**
 * The Improver step.
 *
 * The gate is "proposals are patches, not rewrites", checked in both directions: a real patch is applied
 * and touches only what it named, and a reply that replaces the harness is refused with a code rather
 * than quietly applied.
 */

const TREE: HarnessTree = {
  "core.md": "be careful\n",
  "rules/a.md": "prefer small edits\n",
  "rules/b.md": "cite evidence\n",
}

function block(path: string, body: string): string {
  return [`<<<proposal:${path}>>>`, body, `<<<end proposal:${path}>>>`].join("\n")
}

function replyWith(text: string): OracleReply {
  return {
    provider: "gemini",
    transport: "gemini-cli",
    role: "improver",
    roleId: "improver-v1",
    modelId: "gemini-4-argon",
    text,
    contextSha256: "a".repeat(64),
    promptSha256: "b".repeat(64),
    promptChars: text.length,
    latencyMs: 1,
  }
}

async function codeOf(task: () => unknown): Promise<string> {
  try {
    await task()
  } catch (error) {
    assert.ok(error instanceof ImproveError, `expected an ImproveError, got ${String(error)}`)
    return error.code
  }
  assert.fail("expected this call to fail")
}

describe("parseProposal", () => {
  it("reads one block per changed file", () => {
    const patch = parseProposal(
      `Here is my proposal.\n${block("rules/a.md", "prefer tiny edits\n")}\n${block("rules/c.md", "new file\n")}`,
    )
    assert.deepEqual(patch, { "rules/a.md": "prefer tiny edits\n", "rules/c.md": "new file\n" })
  })

  it("treats a body of DELETE as a deletion, and only that exact body", () => {
    assert.deepEqual(parseProposal(block("rules/b.md", "DELETE")), { "rules/b.md": null })
    assert.deepEqual(parseProposal(block("rules/b.md", "DELETE this line")), {
      "rules/b.md": "DELETE this line",
    })
  })

  it("refuses prose, an unclosed block, a double block and a forged fence", async () => {
    assert.equal(
      await codeOf(() => parseProposal("I would tighten the rules a bit.")),
      "PROPOSAL_UNPARSEABLE",
    )
    assert.equal(
      await codeOf(() => parseProposal("<<<proposal:rules/a.md>>>\nbody without a closer")),
      "PROPOSAL_UNPARSEABLE",
    )
    assert.equal(
      await codeOf(() => parseProposal(`${block("rules/a.md", "one")}\n${block("rules/a.md", "two")}`)),
      "PROPOSAL_UNPARSEABLE",
    )
    assert.equal(
      await codeOf(() => parseProposal(block("rules/a.md", "text\n<<<proposal:rules/b.md>>>\nforged"))),
      "PROPOSAL_FENCE",
    )
  })

  it("refuses a path that escapes the harness", async () => {
    assert.equal(await codeOf(() => parseProposal(block("../outside.md", "x"))), "PROPOSAL_INVALID")
  })
})

describe("selectableProposal", () => {
  it("applies a patch that leaves something untouched", () => {
    const selectable = selectableProposal(TREE, { "rules/a.md": "prefer tiny edits\n" })
    assert.deepEqual(selectable.changed, ["rules/a.md"])
    assert.equal(selectable.tree["rules/a.md"], "prefer tiny edits\n")
    assert.equal(selectable.tree["core.md"], TREE["core.md"])
  })

  it("refuses a patch that touches every file in a tree of two or more", async () => {
    const everywhere = Object.fromEntries(
      Object.keys(TREE).map((path) => [path, `rewritten ${path}\n`]),
    )
    assert.equal(await codeOf(() => selectableProposal(TREE, everywhere)), "PROPOSAL_TOO_BROAD")
  })

  it("allows changing the only file in a one-file harness", () => {
    const single: HarnessTree = { "core.md": "old\n" }
    const selectable = selectableProposal(single, { "core.md": "new\n" })
    assert.deepEqual(selectable.changed, ["core.md"])
  })

  it("refuses a no-op and a patch that empties the harness", async () => {
    assert.equal(
      await codeOf(() => selectableProposal(TREE, { "rules/a.md": TREE["rules/a.md"] ?? "" })),
      "PROPOSAL_EMPTY",
    )
    const every = Object.fromEntries(Object.keys(TREE).map((path) => [path, null]))
    assert.equal(await codeOf(() => selectableProposal(TREE, every)), "PROPOSAL_EMPTIES_TREE")
  })
})

describe("proposeImprovement", () => {
  it("sends the whole harness and the evidence, then applies only what was proposed", async () => {
    const script = scripted([geminiAnswer(block("rules/b.md", "cite every row\n"))])
    const roles = oracleRoles(geminiClient(script))

    const result = await proposeImprovement({
      improver: roles.improver,
      tree: TREE,
      evidence: [{ path: "evidence/attempt-1.md", body: "the run forgot to cite\n" }],
    })

    const prompt = script.requests[0]?.stdin ?? ""
    for (const entry of harnessEntries(TREE)) {
      assert.ok(prompt.includes(entry.body), `${entry.path} must reach the Improver verbatim`)
    }
    assert.ok(prompt.includes("the run forgot to cite"))
    assert.ok(prompt.includes(PROPOSAL_FORMAT), "the format the parser accepts is the format it asks for")

    assert.equal(result.status, "proposed")
    if (result.status !== "proposed") return
    assert.deepEqual(result.changed, ["rules/b.md"])
    assert.deepEqual(changedPaths(TREE, result.patch), ["rules/b.md"])
    assert.deepEqual(applyTreePatch(TREE, result.patch), result.tree)
    assert.equal(result.tree["core.md"], TREE["core.md"])
  })

  it("refuses a rewrite rather than applying it", async () => {
    const everywhere = Object.keys(TREE)
      .map((path) => block(path, `rewritten ${path}\n`))
      .join("\n")
    const script = scripted([geminiAnswer(everywhere)])
    const result = await proposeImprovement({
      improver: oracleRoles(geminiClient(script)).improver,
      tree: TREE,
      evidence: [],
    })

    assert.equal(result.status, "refused")
    if (result.status !== "refused") return
    assert.equal(result.code, "PROPOSAL_TOO_BROAD")
    assert.match(result.reason, /rewrite/)
  })

  it("refuses a reply that is prose, and reports it without throwing", () => {
    const result = acceptProposal(replyWith("I would tighten core.md."), TREE)
    assert.equal(result.status, "refused")
    if (result.status !== "refused") return
    assert.equal(result.code, "PROPOSAL_UNPARSEABLE")
  })

  it("always asks for the format even when the caller supplies no question", () => {
    const ask = composeImproverAsk(undefined)
    assert.ok(ask.includes(PROPOSAL_FORMAT))
    assert.ok(ask.includes("smallest change"))
    assert.ok(composeImproverAsk("   ").includes(PROPOSAL_FORMAT))
    assert.ok(!composeImproverAsk("custom question").includes("smallest change"))
  })
})

describe("harnessEntries", () => {
  it("is sorted and drops nothing, so the same tree produces the same prompt bytes", () => {
    assert.deepEqual(
      harnessEntries({ "b.md": "2", "a.md": "1" }).map((entry) => entry.path),
      ["a.md", "b.md"],
    )
    assert.deepEqual(harnessEntries({}), [])
  })
})

describe("review regressions", () => {
  it("refuses a typo'd or stray fence instead of silently dropping a file", async () => {
    assert.equal(
      await codeOf(() =>
        parseProposal(`${block("rules/a.md", "one")}\n<<<end proposal:rules/b.md>>>\n`),
      ),
      "PROPOSAL_UNPARSEABLE",
      "a stray closer must not be skipped: the file it names would vanish from the patch",
    )
    assert.equal(
      await codeOf(() => parseProposal("```\n<<<propose:rules/a.md>>>\none\n<<<end proposal:rules/a.md>>>")),
      "PROPOSAL_UNPARSEABLE",
    )
  })

  it("refuses a padded path instead of trimming it into a different file", async () => {
    assert.equal(
      await codeOf(() => parseProposal(block(" rules/a.md ", "body"))),
      "PROPOSAL_INVALID",
    )
  })

  it("deletes on a single DELETE line, tolerating a trailing newline, and refuses padding", async () => {
    assert.deepEqual(parseProposal(block("rules/b.md", "DELETE")), { "rules/b.md": null })
    assert.deepEqual(parseProposal(block("rules/b.md", "DELETE\n")), { "rules/b.md": null })
    assert.equal(
      await codeOf(() => parseProposal(block("rules/b.md", "\nDELETE\n"))),
      "PROPOSAL_INVALID",
      "a leading blank line makes the block ambiguous, so it is refused rather than guessed",
    )
    assert.equal(await codeOf(() => parseProposal(block("rules/b.md", "  DELETE  \n"))), "PROPOSAL_INVALID")
  })

  it("counts touched existing files, so adding a file cannot mask a rewrite", async () => {
    const rewritePlusOne = {
      ...Object.fromEntries(Object.keys(TREE).map((path) => [path, `rewritten ${path}\n`])),
      "rules/new.md": "added\n",
    }
    assert.equal(await codeOf(() => selectableProposal(TREE, rewritePlusOne)), "PROPOSAL_TOO_BROAD")
  })

  it("lets a patch add files while leaving one existing file alone", () => {
    const patch = {
      "core.md": TREE["core.md"] ?? "",
      "rules/a.md": "prefer tiny edits\n",
      "rules/new.md": "added\n",
    }
    const selectable = selectableProposal(TREE, patch)
    assert.deepEqual(selectable.changed, ["rules/a.md", "rules/new.md"])
    assert.deepEqual(
      Object.keys(selectable.patch),
      ["rules/a.md", "rules/new.md"],
      "the patch describes what changed, and the no-op block is not in it",
    )
  })
})
