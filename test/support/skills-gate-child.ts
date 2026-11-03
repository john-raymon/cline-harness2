import { mkdir, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Chunk 9's gate, live: "costs a tool entry, not file bytes".
 *
 * The skill's body carries a marker. If the SDK inlined skill bodies, that marker would appear in the
 * request; if it cost no tool entry, the `skills` tool would not be there at all. Both halves are
 * observed against a real `ClineCore` session and a scripted provider — the unit tests can only prove
 * that the accounting agrees with itself.
 */

const MARKER = "SKILL-BODY-MARKER-9f3c7d21"
const SKILL_NAME = "probe-skill"

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

const { bootstrapSession, sessionBootstrapRecordSchema } = await import(
  "../../src/adapter/session.ts"
)
const { runConfigSchema } = await import("../../src/domain/schemas.ts")
const { harnessBaseline } = await import("./baseline-fixture.ts")
const { SPIKE_MODEL_ID, startFakeProvider } = await import("./fake-provider.ts")

const TREE = {
  "systemprompt.md": "Answer briefly.\n",
  [`.cline/skills/${SKILL_NAME}/SKILL.md`]: `# probe skill\n\n${MARKER}\n`,
}

const provider = await startFakeProvider([{ content: "done" }])

try {
  await mkdir(path.join(home, "runs"), { recursive: true })

  const sdkVersion = installedSdkVersion()
  const evidencePath = path.join(home, "spike-evidence.json")
  await writeFile(
    evidencePath,
    JSON.stringify({
      sdkVersion,
      claims: [
        { id: "B1.skills", status: "verified" },
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
    task: "Say done.",
    apiKeySource: "SOLVER_API_KEY",
    evidencePath,
    installedSdkVersion: sdkVersion,
    rootDir: path.join(home, "runs"),
    timeoutMs: 90_000,
    // `skills` is a runtime built-in, not a tree file — Chunk 9 makes it nameable, or the tool the
    // skill needs would be refused by default-deny and the mount would buy nothing.
    toolPolicy: { allow: ["skills"], deny: [] },
  })

  const first = provider.requests[0]?.body ?? {}
  const systemText = JSON.stringify(first["system_message"] ?? first["messages"] ?? "")
  const tools = JSON.stringify(first["tools"] ?? [])
  const requestText = `${systemText}\n${JSON.stringify(first)}`

  const payload = `${JSON.stringify({
    record: sessionBootstrapRecordSchema.parse(record),
    nameSeen: requestText.includes(SKILL_NAME),
    bodyMarkerSeen: requestText.includes(MARKER),
    skillsToolPresent: tools.includes('"skills"'),
    providerRequests: provider.requests.length,
  })}\n`

  // `@cline/core` leaves a 30 s timer running after a successful start, so exit from the write callback
  // rather than waiting for the event loop to drain.
  process.stdout.write(payload, () => process.exit(0))
} catch (error) {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exit(1)
}
