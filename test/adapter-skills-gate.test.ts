import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { afterEach, describe, it } from "node:test"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { sessionBootstrapRecordSchema, type SessionBootstrapRecord } from "../src/adapter/session.ts"

/**
 * Chunk 9's gate: "costs a tool entry, not file bytes", observed on a real session.
 *
 * `test/skills.test.ts` proves the accounting is self-consistent. This proves the runtime agrees: the
 * skill's name reaches the provider, its body does not, and the built-in `skills` tool is present —
 * which is the entry the mount actually bought.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CHILD_SCRIPT = path.join(REPO_ROOT, "test", "support", "skills-gate-child.ts")
const CHILD_TIMEOUT_MS = 180_000

const scratchRoots: string[] = []

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness2-skills-"))
  scratchRoots.push(root)
  return root
}

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface Payload {
  readonly record: SessionBootstrapRecord
  readonly nameSeen: boolean
  readonly bodyMarkerSeen: boolean
  readonly skillsToolPresent: boolean
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

describe("the skills mount, live", () => {
  it("makes the skill nameable and costs a tool entry instead of prompt bytes", async () => {
    const home = await scratch()
    const run = await runChild(home)
    assert.equal(run.code, 0, `child failed: ${run.stderr}`)

    const payload = JSON.parse(run.stdout.trim()) as Payload
    const record = sessionBootstrapRecordSchema.parse(payload.record)

    // Visibility: the name reaches the provider, and the tool that loads the body is there with it.
    assert.equal(payload.nameSeen, true, "the skill name must reach the request")
    assert.equal(payload.skillsToolPresent, true, "the built-in skills tool is the entry the mount buys")
    // Not bytes: B1 says the body is loaded on demand, so a mounted skill must not be inlined.
    assert.equal(payload.bodyMarkerSeen, false, "the skill body must not be inlined into the request")

    // One entry for the built-in tool, and the policy that allows it is recorded verbatim.
    assert.equal(record.declaredToolEntries, 2)
    assert.deepEqual(record.toolPolicySet, ["allow:skills"])
    assert.equal(payload.providerRequests, 1)
  })
})
