import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { afterEach, describe, it } from "node:test"
import os from "node:os"
import path from "node:path"

import { sessionBootstrapRecordSchema, type SessionBootstrapRecord } from "../src/adapter/session.ts"
import { sha256Hex } from "../src/domain/canonical.ts"
import {
  ARTIFACTS_DIR_NAME,
  PROBE_ARTIFACT_NAME,
  probeArtifactPath,
  readProbeRecord,
  writeProbeRecord,
} from "../src/ledger/artifacts.ts"
import { LedgerError } from "../src/ledger/errors.ts"
import { SHA_A } from "./support/ledger-fixtures.ts"

/**
 * The probe artifact.
 *
 * The record is written once, and the digest the ledger stores has to keep identifying the bytes it
 * was taken from. That is what makes "written twice" an error rather than an update: a run that
 * rewrote its own evidence could not be compared with anything.
 */

const scratchRoots: string[] = []

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness2-artifact-"))
  scratchRoots.push(root)
  return root
}

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

function sampleRecord(overrides: Partial<SessionBootstrapRecord> = {}): SessionBootstrapRecord {
  return sessionBootstrapRecordSchema.parse({
    version: 4,
    runId: "run-1",
    runDir: "/tmp/run-1",
    harnessDir: "/tmp/run-1/harness",
    sessionId: "run-1",
    baselineSha: SHA_A,
    providerId: "openai-compatible",
    modelId: "hf:test/model",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKeySource: "SOLVER_API_KEY",
    promptSource: "compiled",
    promptSha256: SHA_A,
    compiledPromptHash: SHA_A,
    probeFingerprintSha256: SHA_A,
    declaredToolEntries: 1,
    contractPlugin: {
      name: "harness2-contract",
      tools: ["harness_contract"],
      rules: ["harness2.contract"],
      ruleSha256: SHA_A,
    },
    hookEvidence: {
      beforeRun: 1,
      afterRun: 1,
      beforeTool: 1,
      afterTool: 1,
      events: 3,
      afterToolOnSkipped: 0,
    },
    toolPolicySet: ["default:deny"],
    toolInventoryHash: SHA_A,
    toolDecisions: [],
    eventCount: 3,
    eventTypes: ["message"],
    turns: 1,
    finishReason: "stop",
    text: "ok",
    toolCallCount: 0,
    pluginIssues: [],
    manifestPath: null,
    messagesPath: null,
    durationMs: 12,
    ...overrides,
  })
}

async function errorOf(task: Promise<unknown>): Promise<LedgerError> {
  try {
    await task
  } catch (error) {
    assert.ok(error instanceof LedgerError, `expected a LedgerError, got ${String(error)}`)
    return error
  }
  assert.fail("expected this call to fail")
}

describe("probe artifact", () => {
  it("publishes the record beside the ledger and identifies its bytes", async () => {
    const runDir = await scratch()
    const record = sampleRecord()
    const written = await writeProbeRecord({ runDir, record })

    assert.equal(written.path, probeArtifactPath(runDir))
    assert.equal(path.dirname(written.path), path.join(runDir, ARTIFACTS_DIR_NAME))
    assert.equal(path.basename(written.path), PROBE_ARTIFACT_NAME)
    assert.equal(written.sha256, sha256Hex(await readFile(written.path)))

    const back = await readProbeRecord({ runDir })
    assert.deepEqual(back.record, record)
    assert.equal(back.sha256, written.sha256)
    assert.equal(back.path, written.path)
  })

  it("refuses to overwrite a published record, and leaves it untouched", async () => {
    const runDir = await scratch()
    const first = await writeProbeRecord({ runDir, record: sampleRecord() })
    const before = await readFile(first.path, "utf8")

    const again = await errorOf(
      writeProbeRecord({ runDir, record: sampleRecord({ text: "a different turn" }) }),
    )
    assert.equal(again.code, "ARTIFACT_EXISTS")
    assert.equal(await readFile(first.path, "utf8"), before)
  })

  it("cleans up its temporary file and claim, even when publication is refused", async () => {
    const runDir = await scratch()
    await writeProbeRecord({ runDir, record: sampleRecord() })
    await errorOf(writeProbeRecord({ runDir, record: sampleRecord() }))

    const entries = await readdir(path.join(runDir, ARTIFACTS_DIR_NAME))
    assert.deepEqual(entries, [PROBE_ARTIFACT_NAME], `leftover publishing files: ${entries.join(", ")}`)
  })

  it("refuses when another publisher already holds the claim", async () => {
    const runDir = await scratch()
    const dir = path.join(runDir, ARTIFACTS_DIR_NAME)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, ".probe.claim"), "{}\n")

    const error = await errorOf(writeProbeRecord({ runDir, record: sampleRecord() }))
    assert.equal(error.code, "ARTIFACT_EXISTS")
    assert.match(error.message, /claimed/)
    // The foreign claim is nobody's to remove, and nothing was published behind it.
    assert.deepEqual(await readdir(dir), [".probe.claim"])
  })

  it("refuses a record that is not a bootstrap record, before touching the disk", async () => {
    const runDir = await scratch()
    const error = await errorOf(
      writeProbeRecord({ runDir, record: { ...sampleRecord(), turns: -1 } as SessionBootstrapRecord }),
    )
    assert.equal(error.code, "ARTIFACT_INVALID")
    assert.deepEqual(await readdir(runDir), [], "a rejected record must not create anything")
  })

  it("reports a missing artifact instead of inventing an empty record", async () => {
    const runDir = await scratch()
    const error = await errorOf(readProbeRecord({ runDir }))
    assert.equal(error.code, "ARTIFACT_INVALID")
    assert.match(error.message, /never persisted/)
  })

  it("refuses a tampered artifact", async () => {
    const runDir = await scratch()
    const written = await writeProbeRecord({ runDir, record: sampleRecord() })
    await writeFile(written.path, '{"version":1}\n')

    const error = await errorOf(readProbeRecord({ runDir }))
    assert.equal(error.code, "ARTIFACT_INVALID")
    assert.match(error.message, /schema/)
  })

  it("refuses an artifact that is not JSON at all", async () => {
    const runDir = await scratch()
    const written = await writeProbeRecord({ runDir, record: sampleRecord() })
    await writeFile(written.path, "not json\n")

    const error = await errorOf(readProbeRecord({ runDir }))
    assert.equal(error.code, "ARTIFACT_INVALID")
    assert.match(error.message, /is not JSON/)
  })

  it("writes canonical bytes, so the same record always has the same digest", async () => {
    const first = await scratch()
    const second = await scratch()
    const a = await writeProbeRecord({ runDir: first, record: sampleRecord() })
    const b = await writeProbeRecord({ runDir: second, record: sampleRecord() })
    assert.equal(a.sha256, b.sha256)
    assert.equal(await readFile(a.path, "utf8"), await readFile(b.path, "utf8"))
  })
})
