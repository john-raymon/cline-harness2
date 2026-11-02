import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  applyTreePatch,
  changedPaths,
  expectedExecutions,
  expectedImprovements,
  harnessTreeSchema,
  isUsableLesson,
  lessonSchema,
  probeFingerprintSchema,
  relPathSchema,
  runConfigSchema,
  treePatchSchema,
} from "../src/domain/schemas.ts"

describe("relPathSchema", () => {
  it("accepts the shapes a harness actually uses", () => {
    for (const path of [
      "systemprompt.md",
      "guardrails.md",
      "LongTermMEMORY.md",
      "tool_descriptions/tool_guidance.md",
      "skills/pdf-tables/SKILL.md",
      "skills/pdf-tables/scripts/pack.ts",
      "sub_agents/auditor/AGENT.md",
      "scripts/verify.ts",
      "plugin/guard.ts",
    ]) {
      assert.equal(relPathSchema.safeParse(path).success, true, path)
    }
  })

  it("rejects every lexical escape", () => {
    const rejected = [
      "",
      "/etc/passwd",
      "../outside.md",
      "a/../b.md",
      "a//b.md",
      "a/",
      "a\\b.md",
      " a.md",
      "a/b ",
      ".",
      "./a.md",
      "a/./b.md",
      "__proto__",
      "a/__proto__/b.md",
      "constructor",
      "a/prototype",
      "a\0b.md",
      "a\u0007b.md",
      "x".repeat(241),
    ]
    for (const path of rejected) {
      const result = relPathSchema.safeParse(path)
      assert.equal(result.success, false, `expected rejection: ${JSON.stringify(path)}`)
    }
  })

  it("accepts exactly the maximum length and rejects one past it", () => {
    assert.equal(relPathSchema.safeParse("x".repeat(240)).success, true)
    assert.equal(relPathSchema.safeParse("x".repeat(241)).success, false)
  })

  it("allows an internal space, which is a legal filename character", () => {
    assert.equal(relPathSchema.safeParse("notes/quarterly summary.md").success, true)
  })

  it("rejects names that only break on Windows or exceed the on-disk limit", () => {
    const rejected = [
      "C:/outside.md",
      "con.txt",
      "aux",
      "lpt1.log",
      "trailing.",
      "sub/dir./file.md",
      "cafe\u0301.md", // NFD: collides with "café.md" on macOS
      `${"é".repeat(130)}.md`, // 260 bytes, under the 240-character cap
    ]
    for (const path of rejected) {
      assert.equal(
        relPathSchema.safeParse(path).success,
        false,
        `expected rejection: ${JSON.stringify(path)}`,
      )
    }
  })

  it("accepts the NFC form and names that merely resemble reserved ones", () => {
    assert.equal(relPathSchema.safeParse("café.md").success, true)
    assert.equal(relPathSchema.safeParse("auxiliary.md").success, true)
    assert.equal(relPathSchema.safeParse("console/notes.md").success, true)
  })
})

describe("harness tree and patch contracts", () => {
  it("rejects an absolute key at the record level, not just the path level", () => {
    assert.equal(harnessTreeSchema.safeParse({ "/abs.md": "x" }).success, false)
    assert.equal(harnessTreeSchema.safeParse({ "rel.md": "" }).success, true)
  })

  it("treats an omitted path as inherited and an empty string as an overwrite", () => {
    const base = { "systemprompt.md": "keep me", "old.md": "still here" }
    const patch = treePatchSchema.parse({ "guardrails.md": "new", "systemprompt.md": "" })
    const next = applyTreePatch(base, patch)

    assert.equal(next["systemprompt.md"], "", "an empty body must overwrite, not delete")
    assert.equal(next["old.md"], "still here", "an omitted path must inherit")
    assert.equal(next["guardrails.md"], "new", "an added path must appear")
    assert.deepEqual(changedPaths(base, patch), ["guardrails.md", "systemprompt.md"])
  })

  it("reports no changes for a patch that restates current content", () => {
    const base = { "systemprompt.md": "same" }
    assert.deepEqual(changedPaths(base, { "systemprompt.md": "same" }), [])
  })
})

const validConfig = {
  k: 1,
  mode: "parallel",
  b1Tokens: 120_000,
  b2Tokens: 160_000,
  targetTokens: 105_000,
  tailTokens: 24_000,
  providerId: "openai-compatible",
  modelId: "test-model",
  root: "/tmp/harness2-run",
} as const

describe("runConfigSchema", () => {
  it("accepts the documented default budget", () => {
    const result = runConfigSchema.safeParse(validConfig)
    assert.equal(result.success, true, JSON.stringify(result.error?.issues))
  })

  it("rejects a non-increasing T4 chain", () => {
    const cases = [
      { ...validConfig, b2Tokens: 120_000 }, // b1 == b2
      { ...validConfig, b1Tokens: 105_000 }, // target == b1
      { ...validConfig, targetTokens: 24_000 }, // tail == target
      { ...validConfig, tailTokens: 200_000 },
    ]
    for (const candidate of cases) {
      assert.equal(runConfigSchema.safeParse(candidate).success, false, JSON.stringify(candidate))
    }
  })

  it("rejects k outside the supported range and unknown keys", () => {
    assert.equal(runConfigSchema.safeParse({ ...validConfig, k: 0 }).success, false)
    assert.equal(runConfigSchema.safeParse({ ...validConfig, k: 17 }).success, false)
    assert.equal(runConfigSchema.safeParse({ ...validConfig, extra: true }).success, false)
    assert.equal(runConfigSchema.safeParse({ ...validConfig, mode: "agg" }).success, false)
  })
})

describe("budget identity", () => {
  it("is 4k executions and 3k improvements", () => {
    for (const k of [1, 2, 3, 8]) {
      assert.equal(expectedExecutions(k), 4 * k)
      assert.equal(expectedImprovements(k), 3 * k)
    }
    assert.equal(expectedExecutions(2), 8)
    assert.equal(expectedImprovements(2), 6)
  })

  it("refuses a budget that cannot be counted", () => {
    for (const k of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => expectedExecutions(k), RangeError)
      assert.throws(() => expectedImprovements(k), RangeError)
    }
  })
})

describe("probe fingerprint", () => {
  const fingerprint = {
    version: 1,
    baseSha: "0".repeat(40),
    dependencyLockHash: "a".repeat(64),
    providerId: "openai-compatible",
    modelId: "test-model",
    reasoningEffort: "high",
    thinking: true,
    toolPolicySet: ["run_commands:allow"],
    toolInventoryHash: "b".repeat(64),
    compiledPromptHash: "c".repeat(64),
    t4Policy: "b1=120000,b2=160000",
    ssotRulesHash: "d".repeat(64),
    librarySnapshotHash: "e".repeat(64),
    slices: [],
  } as const

  it("accepts a complete freeze record", () => {
    assert.equal(probeFingerprintSchema.safeParse(fingerprint).success, true)
  })

  it("rejects a future version, a short sha and a missing freeze field", () => {
    assert.equal(probeFingerprintSchema.safeParse({ ...fingerprint, version: 2 }).success, false)
    assert.equal(probeFingerprintSchema.safeParse({ ...fingerprint, baseSha: "abc" }).success, false)
    const { t4Policy: _omitted, ...withoutT4 } = fingerprint
    assert.equal(probeFingerprintSchema.safeParse(withoutT4).success, false)
  })
})

describe("lesson contract", () => {
  it("accepts an upstream-shaped lesson", () => {
    const lesson = lessonSchema.parse({
      cue: "when a verification step deletes the artifact it just built",
      lesson: "c7: make the verification script assert before cleaning up",
      evidence: "agg2 failed in 2/2 probes; base passed",
      confidence: { level: "medium", why: "single isolated component, two probes" },
    })
    assert.equal(isUsableLesson(lesson), true)
  })

  it("refuses a lesson whose fields are only whitespace", () => {
    const empty = lessonSchema.parse({
      cue: " ",
      lesson: " ",
      evidence: " ",
      confidence: { level: "low", why: "none" },
    })
    assert.equal(isUsableLesson(empty), false, "usability must trim")
    assert.equal(isUsableLesson(null), false)
  })

  it("requires the confidence reason, not a bare word", () => {
    const bare = { cue: "a", lesson: "b", evidence: "c", confidence: "high" }
    assert.equal(lessonSchema.safeParse(bare).success, false)
  })
})

