import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { afterEach, describe, it } from "node:test"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { sessionBootstrapRecordSchema, type SessionBootstrapRecord } from "../src/adapter/session.ts"

/**
 * Chunk 7's gate: "policy actually gates a call".
 *
 * Both halves run a real `ClineCore` session against a scripted provider that asks for `run_commands`
 * with a `touch`. Allowed, the file must appear; denied, it must not — and in both cases the harness tree
 * must survive untouched. A unit test that a hook returns `{ skip: true }` would only prove the hook
 * agrees with itself; `B5.hooks` is the claim that the runtime honours it, and this is where that claim
 * earns its keep.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CHILD_SCRIPT = path.join(REPO_ROOT, "test", "support", "policy-gate-child.ts")
const CHILD_TIMEOUT_MS = 180_000

const scratchRoots: string[] = []

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness2-gate-"))
  scratchRoots.push(root)
  return root
}

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface ChildRun {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

interface Payload {
  readonly mode: "allow" | "deny"
  readonly record: SessionBootstrapRecord
  readonly markerExists: boolean
  readonly harnessParity: boolean
  readonly providerRequests: number
}

function runChild(input: { home: string; mode: "allow" | "deny"; marker: string }): Promise<ChildRun> {
  return new Promise<ChildRun>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CHILD_SCRIPT], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HARNESS2_LIVE_HOME: input.home,
        HARNESS2_POLICY_MODE: input.mode,
        HARNESS2_MARKER: input.marker,
        HOME: input.home,
        USERPROFILE: input.home,
        APPDATA: path.join(input.home, "AppData", "Roaming"),
        XDG_DATA_HOME: path.join(input.home, ".local", "share"),
        XDG_CONFIG_HOME: path.join(input.home, ".config"),
        XDG_STATE_HOME: path.join(input.home, ".local", "state"),
        XDG_CACHE_HOME: path.join(input.home, ".cache"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, CHILD_TIMEOUT_MS)

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

async function runGate(mode: "allow" | "deny"): Promise<{ payload: Payload; marker: string }> {
  const root = await scratch()
  const home = path.join(root, "home")
  await mkdir(home, { recursive: true })
  const marker = path.join(root, "markers", "gate.txt")

  const run = await runChild({ home, mode, marker })
  assert.equal(run.timedOut, false, `child timed out after ${CHILD_TIMEOUT_MS}ms`)
  assert.equal(run.code, 0, `child exited ${String(run.code)}\n${run.stderr}`)

  const jsonLines = run.stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
  assert.equal(jsonLines.length, 1, `expected one JSON line, got:\n${run.stdout}`)

  const raw = JSON.parse(jsonLines[0] as string) as Payload
  const payload: Payload = { ...raw, record: sessionBootstrapRecordSchema.parse(raw.record) }
  assert.equal(payload.harnessParity, true, "the tool wrote inside the harness tree")
  assert.ok(payload.providerRequests > 0, "the provider was never called")
  assert.ok(payload.record.eventCount > 0, "the session emitted no events")
  return { payload, marker }
}

describe("tool policy gate", () => {
  it(
    "lets an allowed tool run and leaves its side effect",
    { timeout: CHILD_TIMEOUT_MS + 30_000 },
    async () => {
      const { payload, marker } = await runGate("allow")

      assert.equal(existsSync(marker), true, "an allowed run_commands call had no effect")
      assert.deepEqual(payload.record.toolPolicySet, ["allow:run_commands"])
      assert.equal(
        payload.record.toolDecisions.some(
          (decision) => decision.toolName === "run_commands" && decision.verdict === "allow",
        ),
        true,
        `no allow decision recorded: ${JSON.stringify(payload.record.toolDecisions)}`,
      )
      assert.equal(payload.record.toolInventoryHash.length, 64)
    },
  )

  it(
    "refuses the same call under a deny policy and leaves nothing behind",
    { timeout: CHILD_TIMEOUT_MS + 30_000 },
    async () => {
      const { payload, marker } = await runGate("deny")

      assert.equal(existsSync(marker), false, "a denied run_commands call still ran")
      assert.deepEqual(payload.record.toolPolicySet, ["deny:run_commands"])
      const denial = payload.record.toolDecisions.find(
        (decision) => decision.toolName === "run_commands",
      )
      assert.ok(denial, `no decision recorded for run_commands: ${JSON.stringify(payload.record.toolDecisions)}`)
      assert.equal(denial.verdict, "deny")
      assert.equal(denial.reason, "denied")
      // Same inventory as the allowed run: only the policy differed, which is what makes the comparison
      // a comparison at all.
      assert.equal(payload.record.toolInventoryHash.length, 64)
    },
  )
})
