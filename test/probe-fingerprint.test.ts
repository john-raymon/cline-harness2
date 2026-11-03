import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { baselineShaOf } from "../src/baseline/fingerprint.ts"
import { runConfigSchema, type HarnessTree, type RunConfig } from "../src/domain/schemas.ts"
import { FingerprintError } from "../src/fingerprint/errors.ts"
import {
  composeProbeFingerprint,
  DEFAULT_REASONING_EFFORT,
  EMPTY_LIBRARY_SHA256,
  probeFingerprintSha256,
  t4PolicyOf,
  verifyHarnessBaseline,
} from "../src/fingerprint/probe.ts"
import { buildToolInventory } from "../src/policy/inventory.ts"
import { compilePrompt } from "../src/prompt/compile.ts"
import { harnessBaseline } from "./support/baseline-fixture.ts"

const TREE: HarnessTree = {
  ".clinerules/rules.md": "rules\n",
  "systemprompt.md": "Be brief.\n",
  "tools/run_commands.md": "Run shell commands.\n",
}

const CONFIG: RunConfig = runConfigSchema.parse({
  k: 1,
  mode: "parallel",
  b1Tokens: 120_000,
  b2Tokens: 160_000,
  targetTokens: 105_000,
  tailTokens: 24_000,
  providerId: "openai-compatible",
  modelId: "spike-model",
  baseUrl: "https://example.invalid/v1",
  arbitration: "off",
  root: "/tmp/runs",
})

function compose(
  overrides: {
    tree?: HarnessTree
    task?: string
    toolPolicySet?: string[]
    config?: RunConfig
    dependencyLockHash?: string | null
    baseSha?: string
  } = {},
) {
  const tree = overrides.tree ?? TREE
  const baseline = harnessBaseline(tree, {
    ...(overrides.dependencyLockHash === undefined
      ? {}
      : { dependencyLockHash: overrides.dependencyLockHash }),
    ...(overrides.baseSha === undefined ? {} : { baseSha: overrides.baseSha }),
  })
  return composeProbeFingerprint({
    baseline: baseline.fingerprint,
    prompt: compilePrompt({ tree, task: overrides.task ?? "Say ok" }),
    toolPolicySet: overrides.toolPolicySet ?? ["default:deny"],
    toolInventoryHash: buildToolInventory(tree).hash,
    config: overrides.config ?? CONFIG,
  })
}

function codeOf(operation: () => unknown): string {
  try {
    operation()
  } catch (error) {
    assert.ok(error instanceof FingerprintError, `expected FingerprintError, got ${String(error)}`)
    return error.code
  }
  assert.fail("expected a rejection")
}

describe("probe fingerprint composition", () => {
  it("fills every field and records the slices that were in force", () => {
    const fingerprint = compose()
    assert.deepEqual(fingerprint.slices, ["core", "rules", "instructions"])
    assert.equal(
      fingerprint.compiledPromptHash,
      compilePrompt({ tree: TREE, task: "Say ok" }).compiledPromptHash,
    )
    assert.equal(fingerprint.toolInventoryHash, buildToolInventory(TREE).hash)
    assert.deepEqual(fingerprint.toolPolicySet, ["default:deny"])
    assert.equal(fingerprint.reasoningEffort, DEFAULT_REASONING_EFFORT)
    assert.equal(fingerprint.thinking, false)
    assert.equal(fingerprint.librarySnapshotHash, EMPTY_LIBRARY_SHA256)
    assert.equal(fingerprint.t4Policy, "t4/v1:tail=24000;target=105000;b1=120000;b2=160000")
  })

  it("is a property of the harness, not of the task", () => {
    assert.equal(
      probeFingerprintSha256(compose({ task: "one" })),
      probeFingerprintSha256(compose({ task: "two" })),
    )
  })

  it("moves when the prompt, the inventory, the policy or the T4 thresholds move", () => {
    const base = probeFingerprintSha256(compose())
    const others = [
      probeFingerprintSha256(compose({ tree: { ...TREE, ".clinerules/rules.md": "edited\n" } })),
      probeFingerprintSha256(
        compose({ tree: { ...TREE, "tools/run_commands.md": "Run shell commands, carefully.\n" } }),
      ),
      probeFingerprintSha256(compose({ toolPolicySet: ["allow:run_commands"] })),
      probeFingerprintSha256(compose({ config: runConfigSchema.parse({ ...CONFIG, tailTokens: 20_000 }) })),
    ]
    for (const other of others) assert.notEqual(other, base)
  })

  it("moves when a file no slice and no inventory reads changes", () => {
    // A skill body is in neither the prompt nor the tool inventory; only the pinned tree catches it.
    const withSkill = { ...TREE, ".cline/skills/pdf/SKILL.md": "# pdf\n" }
    const editedSkill = { ...withSkill, ".cline/skills/pdf/SKILL.md": "# pdf, edited\n" }
    assert.equal(
      probeFingerprintSha256(compose({ tree: withSkill })),
      probeFingerprintSha256(compose({ tree: withSkill })),
    )
    assert.notEqual(
      probeFingerprintSha256(compose({ tree: editedSkill })),
      probeFingerprintSha256(compose({ tree: withSkill })),
    )
  })

  it("records the tree it pinned", () => {
    const treeSha = compose().treeSha
    assert.equal(treeSha, harnessBaseline(TREE).fingerprint.treeSha)
  })

  it("accepts a SHA-256 object id, because capture does", () => {
    assert.equal(compose({ baseSha: "d".repeat(64) }).baseSha, "d".repeat(64))
  })

  it("refuses a baseline with no dependency lockfile instead of inventing a digest", () => {
    assert.equal(codeOf(() => compose({ dependencyLockHash: null })), "FINGERPRINT_INCOMPLETE")
  })
})

describe("baseline consistency", () => {
  it("accepts a tree and fingerprint that describe each other", () => {
    const baseline = harnessBaseline(TREE)
    verifyHarnessBaseline({
      tree: TREE,
      baselineSha: baseline.baselineSha,
      fingerprint: baseline.fingerprint,
    })
  })

  it("refuses a tree the fingerprint does not pin", () => {
    const baseline = harnessBaseline(TREE)
    assert.equal(
      codeOf(() =>
        verifyHarnessBaseline({
          tree: { ...TREE, ".clinerules/extra.md": "smuggled\n" },
          baselineSha: baseline.baselineSha,
          fingerprint: baseline.fingerprint,
        }),
      ),
      "FINGERPRINT_MISMATCH",
    )
  })

  it("refuses a baselineSha that is not the digest of the fingerprint", () => {
    const baseline = harnessBaseline(TREE)
    const other = baselineShaOf(harnessBaseline({ "systemprompt.md": "other\n" }).fingerprint)
    assert.equal(
      codeOf(() =>
        verifyHarnessBaseline({ tree: TREE, baselineSha: other, fingerprint: baseline.fingerprint }),
      ),
      "FINGERPRINT_MISMATCH",
    )
  })
})

describe("the T4 policy string", () => {
  it("is interpolated from the config, not hardcoded", () => {
    assert.equal(
      t4PolicyOf(runConfigSchema.parse({ ...CONFIG, b1Tokens: 130_000, b2Tokens: 170_000 })),
      "t4/v1:tail=24000;target=105000;b1=130000;b2=170000",
    )
  })
})
