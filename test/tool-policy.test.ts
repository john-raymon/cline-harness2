import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { HarnessTree } from "../src/domain/schemas.ts"
import { PolicyError } from "../src/policy/errors.ts"
import { policyHooks, toolNameOf } from "../src/policy/hooks.ts"
import { buildToolInventory } from "../src/policy/inventory.ts"
import {
  DEFAULT_DENY_MARKER,
  decide,
  parseToolPolicy,
  toolPolicySetOf,
  type ToolDecision,
} from "../src/policy/policy.ts"

/**
 * The policy layer: what the tree says it has, what the run says it may do, and what a call gets back.
 *
 * The interesting cases are the ones where a naive implementation is silently permissive: an unlisted
 * tool, a name in both lists, a policy naming a tool that does not exist, an unnamed hook context.
 */

const TREE: HarnessTree = {
  "tools/read_file.md": "Read a file.\n",
  "tools/run_commands.md": "Run a command.\n",
}
const INVENTORY = buildToolInventory(TREE)

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof PolicyError, `expected a PolicyError, got ${String(error)}`)
    return error.code
  }
  assert.fail("expected this call to fail")
}

describe("tool policy", () => {
  it("normalises a policy so one policy has one fingerprint", () => {
    const policy = parseToolPolicy({ allow: ["run_commands", "read_file", "run_commands"], deny: [] }, INVENTORY)
    assert.deepEqual(policy.allow, ["read_file", "run_commands"])
    assert.deepEqual(toolPolicySetOf(policy), ["allow:read_file", "allow:run_commands"])
  })

  it("defaults a missing list to empty rather than failing", () => {
    assert.deepEqual(parseToolPolicy({}, INVENTORY), { allow: [], deny: [] })
  })

  it("refuses a name in both lists instead of picking a precedence", () => {
    assert.equal(codeOf(() => parseToolPolicy({ allow: ["read_file"], deny: ["read_file"] }, INVENTORY)), "POLICY_CONFLICT")
  })

  it("refuses a policy that names a tool the tree does not define", () => {
    assert.equal(codeOf(() => parseToolPolicy({ allow: ["nope"] }, INVENTORY)), "POLICY_UNKNOWN_TOOL")
    assert.equal(codeOf(() => parseToolPolicy({ deny: ["nope"] }, INVENTORY)), "POLICY_UNKNOWN_TOOL")
  })

  it("refuses a malformed policy", () => {
    assert.equal(codeOf(() => parseToolPolicy({ allow: "read_file" }, INVENTORY)), "POLICY_INVALID")
    assert.equal(codeOf(() => parseToolPolicy({ allow: ["read_file"], extra: true }, INVENTORY)), "POLICY_INVALID")
  })

  it("records default-deny as one comparable marker", () => {
    assert.deepEqual(toolPolicySetOf(undefined), [DEFAULT_DENY_MARKER])
    // An empty policy permits nothing, so it must not fingerprint as "no policy recorded".
    assert.deepEqual(toolPolicySetOf({ allow: [], deny: [] }), [DEFAULT_DENY_MARKER])
    assert.deepEqual(toolPolicySetOf(parseToolPolicy({ deny: ["read_file"] }, INVENTORY)), ["deny:read_file"])
  })
})

describe("tool decisions", () => {
  const policy = parseToolPolicy({ allow: ["run_commands"], deny: ["read_file"] }, INVENTORY)

  it("allows only what is listed, and refuses the rest", () => {
    assert.deepEqual(decide(policy, "run_commands"), { allowed: true, reason: "allowed" })
    assert.deepEqual(decide(policy, "read_file"), { allowed: false, reason: "denied" })
    assert.deepEqual(decide(policy, "write_to_file"), { allowed: false, reason: "not-allowed" })
  })

  it("denies everything without a policy, and denies an unnamed call even with one", () => {
    assert.deepEqual(decide(undefined, "run_commands"), { allowed: false, reason: "default-deny" })
    assert.deepEqual(decide(policy, ""), { allowed: false, reason: "unnamed" })
    assert.deepEqual(decide(policy, "   "), { allowed: false, reason: "unnamed" })
  })

  it("calls an empty policy what it is: default-deny, not merely unlisted", () => {
    // The fingerprint collapses an empty policy to `default:deny`, so the reason a decision reports has
    // to agree with it or the record contradicts itself.
    assert.deepEqual(decide({ allow: [], deny: [] }, "run_commands"), {
      allowed: false,
      reason: "default-deny",
    })
  })

  it("refuses a padded name instead of trimming it into the allowlist", () => {
    // Trimming before comparison would let " run_commands" match an entry for "run_commands", i.e. permit
    // a name nobody wrote. An exact-match miss is a refusal, which is the safe direction.
    assert.deepEqual(decide(policy, " run_commands"), { allowed: false, reason: "not-allowed" })
  })
})

describe("policy hooks", () => {
  const policy = parseToolPolicy({ allow: ["run_commands"] }, INVENTORY)

  it("returns no objection for an allowed tool and a skip for a refused one", () => {
    const verdicts: ToolDecision[] = []
    const hooks = policyHooks({ policy, onDecision: (decision) => verdicts.push(decision) })

    assert.equal(hooks.beforeTool({ toolCall: { name: "run_commands" } }), undefined)
    const refused = hooks.beforeTool({ toolCall: { name: "read_file" } })
    assert.equal(refused?.skip, true)
    assert.match(refused?.appendContext ?? "", /read_file/)
    assert.match(refused?.appendContext ?? "", /not-allowed/)

    assert.deepEqual(
      verdicts.map((decision) => [decision.toolName, decision.verdict]),
      [
        ["run_commands", "allow"],
        ["read_file", "deny"],
      ],
    )
  })

  it("denies an unnamed call rather than trusting it", () => {
    const hooks = policyHooks({ policy })
    for (const context of [undefined, null, {}, { toolCall: {} }, { tool: {} }]) {
      const verdict = hooks.beforeTool(context)
      assert.equal(verdict?.skip, true, `context ${JSON.stringify(context)} was allowed`)
      assert.match(verdict?.appendContext ?? "", /unnamed/)
    }
  })

  it("reads the name from every context shape the SDK was observed to use", () => {
    assert.equal(toolNameOf({ toolCall: { name: "a" } }), "a")
    assert.equal(toolNameOf({ toolCall: { toolName: "b" } }), "b")
    assert.equal(toolNameOf({ tool: { name: "c" } }), "c")
    assert.equal(toolNameOf({ toolCall: { name: "" }, tool: { name: "d" } }), "d")
    assert.equal(toolNameOf("not a context"), "")
  })

  it("denies everything when there is no policy at all", () => {
    const hooks = policyHooks({ policy: undefined })
    const verdict = hooks.beforeTool({ toolCall: { name: "run_commands" } })
    assert.equal(verdict?.skip, true)
    assert.match(verdict?.appendContext ?? "", /default-deny/)
  })
})
