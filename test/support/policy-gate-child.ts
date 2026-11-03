/**
 * One real `ClineCore` session under a tool policy, in its own process.
 *
 * The same two constraints as `live-session-child.ts`: `@cline/sdk` latches `HOME` when it initialises
 * its SQLite stores, so `HOME` must be redirected before the module is evaluated, and `node --test` runs
 * every test file in one process, so doing that inside a test would redirect the whole suite.
 *
 * One script serves both halves of the gate. `HARNESS2_POLICY_MODE=allow` must let a real tool run and
 * leave its side effect; `deny` must refuse the same call and leave nothing behind. Anything less than a
 * live session would prove the hook agrees with itself, not that the policy gates the runtime.
 */

import { existsSync, readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"

import { writeEvidence } from "./evidence-fixture.ts"

const home = process.env["HARNESS2_LIVE_HOME"]
if (home === undefined || home.length === 0) {
  console.error("HARNESS2_LIVE_HOME is not set; the parent test owns the temporary home directory")
  process.exit(2)
}

const mode = process.env["HARNESS2_POLICY_MODE"]
if (mode !== "allow" && mode !== "deny") {
  console.error(`HARNESS2_POLICY_MODE must be "allow" or "deny", got ${JSON.stringify(mode)}`)
  process.exit(2)
}

const marker = process.env["HARNESS2_MARKER"]
if (marker === undefined || marker.length === 0) {
  console.error("HARNESS2_MARKER is not set; the parent test owns the marker path")
  process.exit(2)
}

process.env["HOME"] = home
process.env["XDG_DATA_HOME"] = join(home, ".local", "share")
process.env["XDG_CONFIG_HOME"] = join(home, ".config")
process.env["XDG_STATE_HOME"] = join(home, ".local", "state")
process.env["XDG_CACHE_HOME"] = join(home, ".cache")
process.env["USERPROFILE"] = home
process.env["APPDATA"] = join(home, "AppData", "Roaming")

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
  "README.md": "# tool policy gate\n",
  "tools/run_commands.md": "Run shell commands in the workspace.\n",
}

const provider = await startFakeProvider([
  { toolCalls: [{ id: "call-1", name: "run_commands", args: { commands: [`touch ${marker}`] } }] },
  { content: "done" },
])

try {
  await mkdir(join(home, "runs"), { recursive: true })
  await mkdir(dirname(marker), { recursive: true })

  const sdkVersion = installedSdkVersion()
  const evidencePath = await writeEvidence(join(home, "spike-evidence.json"), sdkVersion)
  const toolPolicy = mode === "allow" ? { allow: ["run_commands"], deny: [] } : { allow: [], deny: ["run_commands"] }

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
    task: "Create the marker file with run_commands, then answer done.",
    apiKeySource: "SOLVER_API_KEY",
    evidencePath,
    installedSdkVersion: sdkVersion,
    rootDir: join(home, "runs"),
    timeoutMs: 90_000,
    toolPolicy,
  })

  const harnessTree = await readTree({ dir: record.harnessDir })
  const payload = `${JSON.stringify({
    mode,
    record: sessionBootstrapRecordSchema.parse(record),
    markerExists: existsSync(marker),
    harnessParity: isDeepStrictEqual(harnessTree, TREE),
    providerRequests: provider.requests.length,
  })}\n`

  // Exit once the result is flushed rather than letting the event loop drain. `@cline/core`'s command
  // wrapper races execution against a 30 s `setTimeout` and does not clear the losing timer, so a
  // *successful* tool call keeps the process alive for the full timeout. Everything this child exists to
  // produce is already printed, so waiting for an SDK timer to expire would only slow the suite down.
  process.stdout.write(payload, () => {
    process.exit(0)
  })
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
} finally {
  await provider.close().catch(() => undefined)
}
