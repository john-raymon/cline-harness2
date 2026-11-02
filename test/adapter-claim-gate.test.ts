import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { afterEach, describe, it } from "node:test"
import os from "node:os"
import path from "node:path"

import {
  HOOKS_CLAIM_ID,
  SKILLS_CLAIM_ID,
  assertClaimsSatisfied,
  requiredClaimsFor,
} from "../src/adapter/claim-gate.ts"
import { AdapterError } from "../src/adapter/errors.ts"

const scratchRoots: string[] = []

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness2-gate-"))
  scratchRoots.push(root)
  return root
}

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function evidenceFile(value: unknown): Promise<string> {
  const root = await scratch()
  const file = path.join(root, "spike-evidence.json")
  await writeFile(file, JSON.stringify(value), "utf8")
  return file
}

async function codeOf(operation: Promise<unknown>): Promise<string> {
  try {
    await operation
  } catch (error) {
    assert.ok(error instanceof AdapterError, `expected AdapterError, got ${String(error)}`)
    return error.code
  }
  assert.fail("expected a rejection")
}

async function messageOf(operation: Promise<unknown>): Promise<string> {
  try {
    await operation
  } catch (error) {
    assert.ok(error instanceof AdapterError, `expected AdapterError, got ${String(error)}`)
    return error.message
  }
  assert.fail("expected a rejection")
}

describe("claim gate — the cheap paths", () => {
  it("never touches the filesystem when nothing is required", async () => {
    const report = await assertClaimsSatisfied({
      evidencePath: path.join(os.tmpdir(), "harness2-absent-never-created", "evidence.json"),
      installedSdkVersion: "0.2.0",
      requiredClaims: [],
    })
    assert.deepEqual(report, {
      requiredClaims: [],
      verifiedClaims: [],
      evidenceSdkVersion: null,
    })
  })

  it("passes when every required claim is verified at the installed version", async () => {
    const evidencePath = await evidenceFile({
      sdkVersion: "0.2.0",
      claims: [
        { id: "B1.skills", status: "verified" },
        { id: "B4.compaction", status: "unverified" },
      ],
    })
    const report = await assertClaimsSatisfied({
      evidencePath,
      installedSdkVersion: "0.2.0",
      requiredClaims: ["B1.skills"],
    })
    assert.deepEqual(report.verifiedClaims, ["B1.skills"])
    assert.equal(report.evidenceSdkVersion, "0.2.0")
  })
})

describe("required claims derived from the tree", () => {
  it("always requires the hook claim, because every session installs a gate", () => {
    assert.deepEqual(
      requiredClaimsFor({
        "EXPERIENCE.md": "# lessons\n",
        ".clinerules/project-rules.md": "rules\n",
      }),
      [HOOKS_CLAIM_ID],
    )
  })

  it("requires B1.skills as soon as the tree ships a skill", () => {
    assert.deepEqual(requiredClaimsFor({ ".cline/skills/pdf/SKILL.md": "# pdf\n" }), [
      HOOKS_CLAIM_ID,
      SKILLS_CLAIM_ID,
    ])
  })

  it("does not treat a lookalike prefix as a skill", () => {
    assert.deepEqual(requiredClaimsFor({ ".cline/skills-notes.md": "not a skill\n" }), [HOOKS_CLAIM_ID])
  })
})

describe("claim gate — refusals", () => {
  it("ignores an unverified claim it was not asked about", async () => {
    // B4.compaction is unverified today. Refusing every report that contains an unverified claim
    // would block chunks that do not depend on it, so the gate asks only what the caller asked.
    const evidencePath = await evidenceFile({
      sdkVersion: "0.2.0",
      claims: [{ id: "B4.compaction", status: "unverified" }],
    })
    const report = await assertClaimsSatisfied({
      evidencePath,
      installedSdkVersion: "0.2.0",
      requiredClaims: [],
    })
    assert.equal(report.evidenceSdkVersion, null)
  })

  it("names the remedy when the evidence file is missing", async () => {
    const root = await scratch()
    const evidencePath = path.join(root, "not-there.json")
    const message = await messageOf(
      assertClaimsSatisfied({
        evidencePath,
        installedSdkVersion: "0.2.0",
        requiredClaims: ["B1.skills"],
      }),
    )
    assert.match(message, /pnpm spike:sdk/)
  })

  it("reports the missing-evidence code, not a generic read failure", async () => {
    const root = await scratch()
    assert.equal(
      await codeOf(
        assertClaimsSatisfied({
          evidencePath: path.join(root, "not-there.json"),
          installedSdkVersion: "0.2.0",
          requiredClaims: ["B1.skills"],
        }),
      ),
      "SPIKE_EVIDENCE_MISSING",
    )
  })

  it("rejects malformed JSON", async () => {
    const root = await scratch()
    const evidencePath = path.join(root, "broken.json")
    await writeFile(evidencePath, "{not json", "utf8")
    assert.equal(
      await codeOf(
        assertClaimsSatisfied({
          evidencePath,
          installedSdkVersion: "0.2.0",
          requiredClaims: ["B1.skills"],
        }),
      ),
      "SPIKE_EVIDENCE_INVALID",
    )
  })

  it("rejects a report whose shape is wrong", async () => {
    const evidencePath = await evidenceFile({ sdkVersion: "0.2.0", claims: "B1.skills" })
    assert.equal(
      await codeOf(
        assertClaimsSatisfied({
          evidencePath,
          installedSdkVersion: "0.2.0",
          requiredClaims: ["B1.skills"],
        }),
      ),
      "SPIKE_EVIDENCE_INVALID",
    )
  })

  it("rejects a duplicated claim id, because its status would be ambiguous", async () => {
    const evidencePath = await evidenceFile({
      sdkVersion: "0.2.0",
      claims: [
        { id: "B1.skills", status: "verified" },
        { id: "B1.skills", status: "unverified" },
      ],
    })
    assert.match(
      await messageOf(
        assertClaimsSatisfied({
          evidencePath,
          installedSdkVersion: "0.2.0",
          requiredClaims: ["B1.skills"],
        }),
      ),
      /more than once/,
    )
  })

  it("rejects an SDK version that does not match the installed one", async () => {
    const evidencePath = await evidenceFile({
      sdkVersion: "0.1.0",
      claims: [{ id: "B1.skills", status: "verified" }],
    })
    const message = await messageOf(
      assertClaimsSatisfied({
        evidencePath,
        installedSdkVersion: "0.2.0",
        requiredClaims: ["B1.skills"],
      }),
    )
    assert.match(message, /0\.1\.0/)
    assert.match(message, /0\.2\.0/)
  })

  it("rejects a required claim that is absent", async () => {
    const evidencePath = await evidenceFile({ sdkVersion: "0.2.0", claims: [] })
    const message = await messageOf(
      assertClaimsSatisfied({
        evidencePath,
        installedSdkVersion: "0.2.0",
        requiredClaims: ["B1.skills"],
      }),
    )
    assert.match(message, /B1\.skills/)
    assert.match(message, /absent/)
  })

  it("rejects a required claim that is present but unverified, quoting its status", async () => {
    const evidencePath = await evidenceFile({
      sdkVersion: "0.2.0",
      claims: [{ id: "B4.compaction", status: "unverified" }],
    })
    const message = await messageOf(
      assertClaimsSatisfied({
        evidencePath,
        installedSdkVersion: "0.2.0",
        requiredClaims: ["B4.compaction"],
      }),
    )
    assert.match(message, /unverified/)
    assert.match(message, /B4\.compaction/)
  })
})
