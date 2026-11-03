import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { afterEach, describe, it } from "node:test"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { sessionBootstrapRecordSchema, type SessionBootstrapRecord } from "../src/adapter/session.ts"

/**
 * Chunk 10's gate: "hook fires and effect is observable", observed on a real session.
 *
 * The unit tests prove the recorder agrees with itself. This proves the runtime agrees: the plugin's rule
 * reaches the system prompt, its tool reaches the request, every hook phase fires, and a refused tool call
 * leaves no trace even though `afterTool` still fires for it.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CHILD_SCRIPT = path.join(REPO_ROOT, "test", "support", "plugin-gate-child.ts")
const CHILD_TIMEOUT_MS = 180_000

const scratchRoots: string[] = []

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness2-plugin-"))
  scratchRoots.push(root)
  return root
}

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface Payload {
  readonly record: SessionBootstrapRecord
  readonly ruleSeen: boolean
  readonly contractToolPresent: boolean
  readonly markerExists: boolean
  readonly providerRequests: number
}

function runChild(home: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CHILD_SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...process.env, HARNESS2_LIVE_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS)
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

describe("the contract plugin, live", () => {
  it("installs its rule and tool, fires every hook phase, and refuses without a side effect", async () => {
    const home = await scratch()
    const run = await runChild(home)
    assert.equal(run.code, 0, `child failed: ${run.stderr}`)

    const payload = JSON.parse(run.stdout.trim()) as Payload
    const record = sessionBootstrapRecordSchema.parse(payload.record)

    // B2: an object in `extensions` registers its rule and its tool.
    assert.equal(payload.ruleSeen, true, "the contract rule must reach the system prompt")
    assert.equal(payload.contractToolPresent, true, "the contract tool must reach the request")
    assert.deepEqual(record.contractPlugin.tools, ["harness_contract"])
    assert.deepEqual(record.contractPlugin.rules, ["harness2.contract"])
    assert.equal(record.contractPlugin.name, "harness2-contract")

    // B5: all four phases fired, and onEvent was a usable trajectory source.
    assert.equal(record.hookEvidence.beforeRun >= 1, true)
    assert.equal(record.hookEvidence.afterRun >= 1, true)
    assert.equal(record.hookEvidence.beforeTool >= 1, true)
    assert.equal(record.hookEvidence.afterTool >= 1, true)
    assert.equal(record.hookEvidence.events > 0, true)

    // The gate held: the call was refused, no marker appeared, and afterTool still fired for it.
    assert.equal(payload.markerExists, false, "a refused call must have no side effect")
    assert.deepEqual(
      record.toolDecisions.map((decision) => [decision.toolName, decision.verdict]),
      [["run_commands", "deny"]],
    )
    assert.equal(record.hookEvidence.afterToolOnSkipped >= 1, true)
  })
})
