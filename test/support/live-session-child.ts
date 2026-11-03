/**
 * One real `ClineCore` session, in its own process.
 *
 * Two things force the child-process shape. `@cline/sdk` initialises its SQLite stores against `HOME`
 * at import time, so `HOME` must be redirected before the SDK is evaluated; and `node --test` runs
 * every test file in one process, so doing that inside a test would redirect the machine id and
 * session database for the whole suite.
 *
 * Everything is imported dynamically *after* the assignments below, because a static import is
 * evaluated before any statement in this file runs.
 */

import { readdirSync, readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { isDeepStrictEqual } from "node:util"

import { writeEvidence } from "./evidence-fixture.ts"

const home = process.env["HARNESS2_LIVE_HOME"]
if (home === undefined || home.length === 0) {
  console.error("HARNESS2_LIVE_HOME is not set; the parent test owns the temporary home directory")
  process.exit(2)
}

process.env["HOME"] = home
process.env["XDG_DATA_HOME"] = join(home, ".local", "share")
process.env["XDG_CONFIG_HOME"] = join(home, ".config")
process.env["XDG_STATE_HOME"] = join(home, ".local", "state")
process.env["XDG_CACHE_HOME"] = join(home, ".cache")
process.env["USERPROFILE"] = home
process.env["APPDATA"] = join(home, "AppData", "Roaming")

/** Depth-limited walk, so a runaway SDK cache cannot turn this into an expensive assertion. */
function listHome(limit: number): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (found.length >= limit || depth > 4) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= limit) return
      const full = join(dir, entry)
      found.push(relative(home as string, full))
      walk(full, depth + 1)
    }
  }
  walk(home as string, 0)
  return found
}

function installedSdkVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../../node_modules/@cline/sdk/package.json", import.meta.url), "utf8"),
  ) as { version?: string }
  return manifest.version ?? "unknown"
}

const { bootstrapSession, sessionBootstrapRecordSchema } = await import(
  "../../src/adapter/session.ts"
)
const { runConfigSchema } = await import("../../src/domain/schemas.ts")
const { harnessBaseline } = await import("./baseline-fixture.ts")
const { readTree } = await import("../../src/harness/tree-store.ts")
const { SPIKE_MODEL_ID, startFakeProvider } = await import("./fake-provider.ts")

const TREE = {
  "README.md": "# harness bootstrap\n",
  "systemprompt.md": "Answer the operator briefly.\n",
}

const provider = await startFakeProvider([{ content: "ok from the live bootstrap" }])

try {
  await mkdir(join(home, "runs"), { recursive: true })

  // The adapter refuses to start a session without the hook claim in the evidence file, so the child
  // writes a report for the SDK it actually loaded. A fresh clone has no `.tmp/spike-evidence.json`.
  const sdkVersion = installedSdkVersion()
  const evidencePath = await writeEvidence(join(home, "spike-evidence.json"), sdkVersion)

  const record = await bootstrapSession({
    config: runConfigSchema.parse({
      k: 1,
      mode: "parallel",
      tailTokens: 24_000,
      targetTokens: 105_000,
      b1Tokens: 120_000,
      b2Tokens: 160_000,
      providerId: "openai-compatible",
      modelId: SPIKE_MODEL_ID,
      baseUrl: provider.baseUrl,
      arbitration: "off",
      apiKey: "live-test-key",
      root: join(home, "runs"),
    }),
    baseline: harnessBaseline(TREE),
    task: "Reply with the single word: ok",
    apiKeySource: "SOLVER_API_KEY",
    // The tree ships no skills, but every session installs a `beforeTool` gate, so the hook claim is
    // required regardless of what the tree contains.
    evidencePath,
    installedSdkVersion: sdkVersion,
    rootDir: join(home, "runs"),
    timeoutMs: 90_000,
  })

  const back = await readTree({ dir: record.harnessDir })
  // Deep equality, not string equality: `readTree` returns keys in sorted order and the literal above
  // is hand-written, so a JSON comparison would break the moment the fixture's keys are reordered.
  const harnessParity = isDeepStrictEqual(back, TREE)

  process.stdout.write(
    `${JSON.stringify({
      record: sessionBootstrapRecordSchema.parse(record),
      harnessParity,
      homeEntries: listHome(20),
      providerRequests: provider.requests.length,
    })}\n`,
  )
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
} finally {
  await provider.close().catch(() => undefined)
}
