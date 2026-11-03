import { mkdir, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Chunk 10's gate, live: "hook fires and effect is observable".
 *
 * One real `ClineCore` session with the contract plugin injected through `extensions`. The provider is
 * scripted to call `run_commands`, which the policy denies, so this also observes the documented lie: the
 * `afterTool` hook fires for a call that was refused, and no file appears.
 */

const MARKER_TOKEN = "PLUGIN-GATE-MARKER"
const RULE_MARKER = "HARNESS2-CONTRACT"

const home = process.env["HARNESS2_LIVE_HOME"]
if (home === undefined || home.length === 0) {
  throw new Error("HARNESS2_LIVE_HOME is required")
}

process.env["HOME"] = home
process.env["XDG_CONFIG_HOME"] = path.join(home, ".config")
process.env["XDG_STATE_HOME"] = path.join(home, ".local", "state")
process.env["XDG_CACHE_HOME"] = path.join(home, ".cache")
process.env["USERPROFILE"] = home
process.env["APPDATA"] = path.join(home, "AppData", "Roaming")

function installedSdkVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../../node_modules/@cline/sdk/package.json", import.meta.url), "utf8"),
  ) as { version?: string }
  return manifest.version ?? "unknown"
}

const { bootstrapSession, sessionBootstrapRecordSchema } = await import("../../src/adapter/session.ts")
const { runConfigSchema } = await import("../../src/domain/schemas.ts")
const { harnessBaseline } = await import("./baseline-fixture.ts")
const { SPIKE_MODEL_ID, startFakeProvider } = await import("./fake-provider.ts")

const marker = path.join(home, "should-not-exist.txt")
const TREE = {
  "systemprompt.md": "Answer briefly.\n",
  "tools/run_commands.md": "Run shell commands.\n",
}

const provider = await startFakeProvider([
  { toolCalls: [{ id: "call-1", name: "run_commands", args: { commands: [`touch ${marker}`] } }] },
  { content: "done" },
])

try {
  await mkdir(path.join(home, "runs"), { recursive: true })

  const sdkVersion = installedSdkVersion()
  const evidencePath = path.join(home, "spike-evidence.json")
  await writeFile(
    evidencePath,
    JSON.stringify({
      sdkVersion,
      claims: [
        { id: "B2.plugin", status: "verified" },
        { id: "B5.hooks", status: "verified" },
      ],
    }),
    "utf8",
  )

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
      root: path.join(home, "runs"),
    }),
    baseline: harnessBaseline(TREE),
    task: "Try to create the marker, then answer done.",
    apiKeySource: "SOLVER_API_KEY",
    evidencePath,
    installedSdkVersion: sdkVersion,
    rootDir: path.join(home, "runs"),
    timeoutMs: 90_000,
    toolPolicy: { allow: [], deny: ["run_commands"] },
  })

  const first = provider.requests[0]?.body ?? {}
  const haystack = JSON.stringify(first)
  const tools = JSON.stringify(first["tools"] ?? [])

  let markerExists = true
  try {
    readFileSync(marker)
  } catch {
    markerExists = false
  }

  const payload = `${JSON.stringify({
    record: sessionBootstrapRecordSchema.parse(record),
    ruleSeen: haystack.includes(RULE_MARKER),
    contractToolPresent: tools.includes("harness_contract"),
    markerExists,
    providerRequests: provider.requests.length,
  })}\n`

  process.stdout.write(payload, () => process.exit(0))
} catch (error) {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exit(1)
}
