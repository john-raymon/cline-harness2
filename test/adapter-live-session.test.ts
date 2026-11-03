import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { afterEach, describe, it } from "node:test"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { sessionBootstrapRecordSchema } from "../src/adapter/session.ts"

/**
 * The live half of Chunk 5's gate: "session starts and one turn completes".
 *
 * It is not mocked and not skipped, because a bootstrap that only ever ran against a fake SDK proves
 * nothing about the boundary this chunk exists to establish. The work happens in a child process —
 * see the header of `test/support/live-session-child.ts` for why `HOME` forces that.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CHILD_SCRIPT = path.join(REPO_ROOT, "test", "support", "live-session-child.ts")
const CHILD_TIMEOUT_MS = 180_000

const scratchRoots: string[] = []

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness2-live-"))
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

function runChild(home: string): Promise<ChildRun> {
  return new Promise<ChildRun>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CHILD_SCRIPT], {
      cwd: REPO_ROOT,
      // The child also sets these itself, but doing it here means even the module loader that runs
      // before the child's first statement sees the temporary home.
      env: {
        ...process.env,
        HARNESS2_LIVE_HOME: home,
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, "AppData", "Roaming"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_STATE_HOME: path.join(home, ".local", "state"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // SIGKILL: a live SDK that ignores the deadline must not leave an agent running.
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

describe("live session bootstrap", () => {
  it(
    "starts a real ClineCore session and completes one turn",
    { timeout: CHILD_TIMEOUT_MS + 30_000 },
    async () => {
      const root = await scratch()
      const home = path.join(root, "home")
      await mkdir(home, { recursive: true })

      const run = await runChild(home)
      assert.equal(run.timedOut, false, `child timed out after ${CHILD_TIMEOUT_MS}ms`)
      assert.equal(run.code, 0, `child exited ${String(run.code)}\n${run.stderr}`)

      const lines = run.stdout.split("\n").filter((line) => line.trim().length > 0)
      const jsonLines = lines.filter((line) => line.trim().startsWith("{"))
      assert.equal(jsonLines.length, 1, `expected one JSON line, got:\n${run.stdout}`)
      const payload = JSON.parse(jsonLines[0] as string) as {
        record: unknown
        harnessParity: boolean
        homeEntries: string[]
        providerRequests: number
      }

      const record = sessionBootstrapRecordSchema.parse(payload.record)
      assert.equal(payload.harnessParity, true, "the materialised tree did not survive the session")
      assert.ok(record.text.trim().length > 0, "the turn produced no text")
      assert.ok(record.eventCount > 0, "the session emitted no events")
      assert.ok(record.turns >= 1, `expected at least one iteration, got ${record.turns}`)
      assert.equal(record.apiKeySource, "SOLVER_API_KEY")
      assert.equal(record.promptSource, "compiled")
      assert.ok(payload.providerRequests > 0, "the provider was never called")

      // The run directory lives inside the temporary home, so nothing this test did can escape it.
      assert.ok(record.harnessDir.startsWith(home), `harness dir ${record.harnessDir} left ${home}`)
      assert.ok(
        payload.homeEntries.length > 0,
        "the SDK wrote nothing under the temporary home, so HOME isolation is unproven",
      )
      assert.equal(
        payload.homeEntries.every((entry) => !entry.startsWith("..")),
        true,
        `an entry escaped the temporary home: ${payload.homeEntries.join(", ")}`,
      )
    },
  )
})
