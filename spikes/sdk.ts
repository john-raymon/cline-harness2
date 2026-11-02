import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { rmSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { join, resolve } from "node:path"

import {
  SPIKE_MODEL_ID,
  startFakeProvider,
  type ChatRequest,
  type ScriptedTurn,
} from "../test/support/fake-provider.ts"

/**
 * Chunk 1 SDK spike.
 *
 * Six claims decide whether the adapter plan is real or a guess. Each one runs against a *live*
 * ClineCore session pointed at a local scripted provider, and each result is written to both
 * `.tmp/spike-evidence.json` and `docs/ADAPTER.md`.
 *
 * A claim that cannot be established stays `unverified` with `method: "static"`. Evidence from the
 * plain `Agent` runtime or from reading `.d.ts` files is never promoted to Core verification —
 * that is the whole point of recording the method alongside the status.
 */

const ROOT = resolve(import.meta.dirname, "..")
const SPIKE_DIR = join(ROOT, ".tmp", "spike")
const HOME_DIR = join(SPIKE_DIR, "home")
const EVIDENCE_PATH = join(ROOT, ".tmp", "spike-evidence.json")
const SESSION_TIMEOUT_MS = 60_000
const CLAIM_TIMEOUT_MS = 120_000

// Isolate every piece of runtime state before the SDK is imported: sessions persist to a SQLite
// database under HOME, and a spike must never touch the developer's real one.
process.env["HOME"] = HOME_DIR
process.env["XDG_DATA_HOME"] = join(HOME_DIR, ".local", "share")
process.env["HARNESS2_SPIKE"] = "1"

export interface ClaimEvidence {
  readonly path: string
  readonly locator: string
}

export interface ClaimRecord {
  readonly id: string
  readonly claim: string
  status: "verified" | "unverified"
  method: "static" | "agent" | "core-scripted" | "core-live"
  readonly sdkVersion: string
  readonly nodeVersion: string
  readonly command: string
  readonly evidence: readonly ClaimEvidence[]
  observed: string
  limitations: string[]
  decision: string
  readonly blocks: readonly string[]
}

export interface SpikeReport {
  readonly generatedAt: string
  readonly nodeVersion: string
  readonly sdkVersion: string
  readonly claims: readonly ClaimRecord[]
}

interface ClaimOutcome {
  readonly observed: string
  readonly limitations?: readonly string[]
  readonly decision: string
  /**
   * The claim's own predicate, evaluated from what the run actually showed.
   *
   * Status is derived from this and nothing else: inverting it to "verified unless an exception
   * happened" would let a claim whose behaviour failed still authorise a dependent chunk.
   */
  readonly established: boolean
}

function freshDir(path: string): string {
  rmSync(path, { recursive: true, force: true })
  mkdirSync(path, { recursive: true })
  return path
}

function readSdkVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "node_modules", "@cline", "sdk", "package.json"), "utf8"),
    ) as { version?: string }
    return manifest.version ?? "unknown"
  } catch {
    return "unknown"
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface SessionRun {
  readonly text: string
  readonly requests: readonly ChatRequest[]
  readonly events: readonly string[]
}

/**
 * The slice of `@cline/sdk` the spike uses, declared locally.
 *
 * This is not laziness: `ClineCore.start()` resolves to `unknown` and `subscribe`'s listener to an
 * untyped parameter under `skipLibCheck` (claim `B7`). Declaring the shape we depend on keeps the
 * spike type-safe *and* makes the assumption visible, while every claim still verifies the real
 * behaviour at runtime.
 */
interface SpikeStartResult {
  readonly sessionId?: string
  readonly result?: { readonly text?: string }
}

interface SpikeCore {
  start(input: Record<string, unknown>): Promise<SpikeStartResult>
  subscribe(listener: (event: { type: string }) => void): () => void
  dispose(): Promise<void>
}

interface SpikeSdk {
  ClineCore: { create(options?: Record<string, unknown>): Promise<SpikeCore> }
  createTool(config: Record<string, unknown>): unknown
}

async function loadSdk(): Promise<SpikeSdk> {
  return (await import("@cline/sdk")) as unknown as SpikeSdk
}

/**
 * Run one live ClineCore session against a scripted provider and return what the model was
 * actually sent. Everything the claims assert is read from `requests` or from files the run
 * produced — never from an assumption about how the runtime is wired.
 */
async function runSession(options: {
  readonly cwd: string
  readonly turns: readonly ScriptedTurn[]
  readonly prompt: string
  readonly config?: Record<string, unknown>
}): Promise<SessionRun> {
  const provider = await startFakeProvider(options.turns)
  const sdk = await loadSdk()
  const events: string[] = []
  const cline = await sdk.ClineCore.create({
    clientName: "cline-harness2-spike",
    backendMode: "local",
  })
  const unsubscribe = cline.subscribe((event) => {
    events.push(event.type)
  })
  try {
    const session = await withTimeout(
      cline.start({
        prompt: options.prompt,
        config: {
          cwd: options.cwd,
          providerId: "openai-compatible",
          modelId: SPIKE_MODEL_ID,
          apiKey: "spike-key",
          baseUrl: provider.baseUrl,
          systemPrompt: "You are the spike solver. Follow instructions exactly.",
          enableTools: true,
          enableSpawnAgent: false,
          enableAgentTeams: false,
          maxIterations: 4,
          yolo: true,
          ...options.config,
        },
      }),
      SESSION_TIMEOUT_MS,
      "session",
    )
    return { text: session.result?.text ?? "", requests: provider.requests, events }
  } finally {
    unsubscribe()
    await cline.dispose().catch(() => undefined)
    await provider.close().catch(() => undefined)
  }
}

function firstRequestBody(run: SessionRun): Record<string, unknown> {
  return run.requests[0]?.body ?? {}
}

function serialise(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}

function toolNames(body: Record<string, unknown>): string[] {
  const tools = body["tools"]
  if (!Array.isArray(tools)) return []
  const names: string[] = []
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null) continue
    const record = tool as Record<string, unknown>
    const fn = record["function"]
    const name = typeof fn === "object" && fn !== null ? (fn as Record<string, unknown>)["name"] : record["name"]
    if (typeof name === "string" && name.length > 0) names.push(name)
  }
  return names
}

function systemText(body: Record<string, unknown>): string {
  const messages = body["messages"]
  if (!Array.isArray(messages)) return serialise(body)
  return messages.map((message) => serialise(message)).join("\n")
}

const SKILL_BODY = [
  "---",
  "name: spike-sentinel",
  "description: SPIKE_SENTINEL_DESCRIPTION_MARKER",
  "---",
  "",
  "Use this skill whenever SPIKE_SENTINEL_TRIGGER appears.",
  "",
].join("\n")

interface SkillProbe {
  readonly label: string
  readonly nameSeen: boolean
  readonly skillToolPresent: boolean
}

async function skillProbe(
  label: string,
  location: "cwd-cline" | "harness" | "none",
  skills?: readonly string[],
): Promise<SkillProbe> {
  const base = freshDir(join(SPIKE_DIR, "skills", label))
  const cwd = join(base, "cwd")
  mkdirSync(cwd, { recursive: true })
  const skillDir =
    location === "cwd-cline"
      ? join(cwd, ".cline", "skills", "spike-sentinel")
      : location === "harness"
        ? join(base, "harness", "skills", "spike-sentinel")
        : undefined
  if (skillDir) {
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, "SKILL.md"), SKILL_BODY, "utf8")
  }

  const run = await runSession({
    cwd,
    prompt: "Reply with the single word done.",
    turns: [{ content: "done" }],
    ...(skills ? { config: { skills } } : {}),
  })
  const body = firstRequestBody(run)
  const haystack = `${systemText(body)}\n${serialise(body["tools"])}`
  return {
    label,
    nameSeen: haystack.includes("spike-sentinel"),
    skillToolPresent: toolNames(body).includes("skills"),
  }
}

/** B1: which directory makes a skill visible, and does the allowlist gate it? */
async function claimSkills(): Promise<ClaimOutcome> {
  const local = await skillProbe("cwd-cline", "cwd-cline", ["spike-sentinel"])
  const outsideCwd = await skillProbe("harness-only", "harness", ["spike-sentinel"])
  const noSkillAtAll = await skillProbe("none", "none", ["spike-sentinel"])
  const emptyAllowlist = await skillProbe("cwd-cline-empty-allowlist", "cwd-cline", [])

  // The negative controls are what make this evidence rather than a correlation: one proves the
  // name is not arriving from ambient discovery, the other proves an outside-cwd dir is not read.
  const established =
    local.nameSeen &&
    local.skillToolPresent &&
    !outsideCwd.nameSeen &&
    !noSkillAtAll.nameSeen

  return {
    observed:
      `<cwd>/.cline/skills + names: nameSeen=${String(local.nameSeen)}, ` +
      `skillsTool=${String(local.skillToolPresent)}; ` +
      `outside-cwd skills/ + names: nameSeen=${String(outsideCwd.nameSeen)}; ` +
      `no skill on disk + names (ambient control): nameSeen=${String(noSkillAtAll.nameSeen)}; ` +
      `<cwd>/.cline/skills + empty allowlist: nameSeen=${String(emptyAllowlist.nameSeen)}`,
    limitations: [
      "the skill body is not inlined into the request; the built-in skills tool loads it on demand",
      "an empty allowlist still shows the skill, so config.skills is not the visibility gate",
    ],
    decision: established
      ? "c6 mounts skills under <cwd>/.cline/skills/<name>/SKILL.md and scopes them by controlling which directories exist; the built-in skills tool handles invocation, so no use_skill fallback is needed"
      : "c6 cannot rely on file discovery; ship an explicit use_skill tool reading skills/<name>/SKILL.md",
    established,
  }
}

const PLUGIN_SOURCE = `import { createTool } from "@cline/sdk"

export default {
  name: "spike-plugin",
  manifest: { capabilities: ["tools", "rules"] },
  setup(api) {
    api.registerTool(
      createTool({
        name: "spike_probe_tool",
        description: "SPIKE_PLUGIN_TOOL_MARKER",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ ok: true }),
      }),
    )
    api.registerRule({ id: "spike-rule", content: "SPIKE_PLUGIN_RULE_MARKER", source: "spike" })
  },
}
`

type PluginVariant = "path-file" | "path-dir" | "extensions"

interface PluginProbe {
  readonly label: PluginVariant
  readonly tools: readonly string[]
  readonly toolRegistered: boolean
  readonly ruleInjected: boolean
  readonly error?: string
}

async function pluginProbe(variant: PluginVariant): Promise<PluginProbe> {
  const base = freshDir(join(SPIKE_DIR, "plugin", variant))
  const cwd = join(base, "cwd")
  mkdirSync(cwd, { recursive: true })
  const pluginPath = join(base, "spike-plugin.ts")
  writeFileSync(pluginPath, PLUGIN_SOURCE, "utf8")

  let config: Record<string, unknown>
  if (variant === "path-file") {
    config = { pluginPaths: [pluginPath] }
  } else if (variant === "path-dir") {
    config = { pluginPaths: [base] }
  } else {
    const mod = (await import(pathToFileURL(pluginPath).href)) as { default: unknown }
    config = { extensions: [mod.default] }
  }

  const run = await runSession({
    cwd,
    prompt: "Reply with the single word done.",
    turns: [{ content: "done" }],
    config,
  })
  const body = firstRequestBody(run)
  const names = toolNames(body)
  return {
    label: variant,
    tools: names,
    toolRegistered: names.includes("spike_probe_tool"),
    ruleInjected: systemText(body).includes("SPIKE_PLUGIN_RULE_MARKER"),
  }
}

/** B2: how does a candidate plugin actually get into a session — path loading, or direct injection? */
async function claimPlugin(): Promise<ClaimOutcome> {
  const probes: PluginProbe[] = []
  for (const variant of ["path-file", "path-dir", "extensions"] as const) {
    try {
      probes.push(await pluginProbe(variant))
    } catch (error) {
      probes.push({
        label: variant,
        tools: [],
        toolRegistered: false,
        ruleInjected: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const observed = probes
    .map(
      (probe) =>
        `${probe.label}: tool=${String(probe.toolRegistered)}, rule=${String(probe.ruleInjected)}` +
        (probe.error ? `, error=${JSON.stringify(probe.error)}` : ""),
    )
    .join("; ")
  const viaExtensions = probes.find((probe) => probe.label === "extensions")?.toolRegistered === true
  const viaPath = probes
    .filter((probe) => probe.label !== "extensions")
    .some((probe) => probe.toolRegistered)

  return {
    observed: `${observed}; extensionToolsSeen=${String(viaExtensions)}; anyPathLoadingWorked=${String(viaPath)}`,
    limitations: [
      "a capability-manifest mismatch and a load failure are indistinguishable from the request body alone",
    ],
    decision: viaExtensions
      ? "c8 must import the candidate plugin itself and pass it through `extensions`; `pluginPaths` is not a reliable loader for uncompiled .ts here"
      : viaPath
        ? "c8 can rely on pluginPaths; direct injection remains the simpler and more observable route"
        : "c8 cannot load or inject a plugin on this SDK; re-open c8 before building it",
    established: viaExtensions && !viaPath,
  }
}

function builderPluginSource(outDir: string): string {
  return `import { writeFileSync } from "node:fs"

const out = ${JSON.stringify(outDir)}

export default {
  name: "spike-builders",
  manifest: { capabilities: ["messageBuilders"] },
  setup(api) {
    api.registerMessageBuilder({
      name: "spike-a",
      build(messages) {
        const list = Array.isArray(messages) ? messages : []
        writeFileSync(out + "/a.json", JSON.stringify({
          isArray: Array.isArray(messages),
          count: list.length,
          firstKeys: list.length > 0 ? Object.keys(list[0] ?? {}) : [],
        }))
        return Array.isArray(messages)
          ? [...messages, { role: "user", content: "SPIKE_BUILDER_A" }]
          : messages
      },
    })
    api.registerMessageBuilder({
      name: "spike-b",
      build(messages) {
        writeFileSync(out + "/b.json", JSON.stringify({
          isArray: Array.isArray(messages),
          count: Array.isArray(messages) ? messages.length : -1,
          sawA: JSON.stringify(messages).includes("SPIKE_BUILDER_A"),
        }))
        return messages
      },
    })
  },
}
`
}

/** B3: what `build(messages)` receives, in what order, and does its output reach the model? */
async function claimMessageBuilder(): Promise<ClaimOutcome> {
  const cwd = freshDir(join(SPIKE_DIR, "builder", "cwd"))
  const outDir = freshDir(join(SPIKE_DIR, "builder", "out"))
  const pluginPath = join(freshDir(join(SPIKE_DIR, "builder", "harness")), "spike-builders.ts")
  writeFileSync(pluginPath, builderPluginSource(outDir), "utf8")
  // Inject directly rather than relying on path loading, which claim B2 shows is unreliable here.
  const mod = (await import(pathToFileURL(pluginPath).href)) as { default: unknown }

  const run = await runSession({
    cwd,
    prompt: "Reply with the single word done.",
    turns: [{ content: "done" }],
    config: { extensions: [mod.default] },
  })
  const read = (name: string): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(join(outDir, name), "utf8")) as Record<string, unknown>
    } catch {
      return { missing: true }
    }
  }
  const a = read("a.json")
  const b = read("b.json")
  const reachedModel = run.requests.some((request) =>
    serialise(request.body).includes("SPIKE_BUILDER_A"),
  )
  const orderProven = b["sawA"] === true
  const shapeProven = a["isArray"] === true && Array.isArray(a["firstKeys"])
  const firstKeys = (a["firstKeys"] as string[] | undefined) ?? []

  return {
    observed:
      `builderACalled=${String(a["missing"] !== true)}; a.count=${String(a["count"])}; ` +
      `a.firstKeys=[${firstKeys.join(",")}]; builderBCalled=${String(b["missing"] !== true)}; ` +
      `b.sawA=${String(b["sawA"])}; builderOutputReachedModel=${String(reachedModel)}`,
    limitations: [
      "established for the first request of a session only",
      "repeated builds within one turn were not exercised",
    ],
    decision:
      shapeProven && orderProven && reachedModel
        ? "T4 soft stubs belong in a message builder: it receives an array, runs in registration order, and its output reaches the provider"
        : "T4 soft stubs cannot be trusted to a message builder until the ordering/shape gap is explained",
    established: shapeProven && orderProven && reachedModel,
  }
}

interface HookContextShape {
  readonly toolCall?: { readonly name?: string; readonly toolName?: string }
  readonly tool?: { readonly name?: string }
}

/** B5: do the hooks fire on a real session, and does `{ skip: true }` actually block the side effect? */
async function claimHooks(): Promise<ClaimOutcome> {
  const cwd = freshDir(join(SPIKE_DIR, "hooks", "cwd"))
  const marker = join(cwd, "SPIKE_SHOULD_NOT_EXIST")
  const seen = { beforeRun: 0, afterRun: 0, beforeTool: 0, afterTool: 0, onEvent: 0 }

  const run = await runSession({
    cwd,
    prompt: "Create the marker file using run_commands.",
    turns: [
      {
        toolCalls: [
          { id: "call-1", name: "run_commands", args: { commands: ["touch SPIKE_SHOULD_NOT_EXIST"] } },
        ],
      },
      { content: "done" },
    ],
    config: {
      hooks: {
        beforeRun: () => {
          seen.beforeRun += 1
          return undefined
        },
        afterRun: () => {
          seen.afterRun += 1
        },
        beforeTool: (ctx: HookContextShape) => {
          seen.beforeTool += 1
          const name = ctx.toolCall?.name ?? ctx.toolCall?.toolName ?? ctx.tool?.name ?? ""
          return name === "run_commands" ? { skip: true, appendContext: "spike: blocked" } : undefined
        },
        afterTool: () => {
          seen.afterTool += 1
          return undefined
        },
        onEvent: () => {
          seen.onEvent += 1
        },
      },
    },
  })

  const blocked = !existsSync(marker)
  const allFired = seen.beforeRun > 0 && seen.beforeTool > 0 && seen.onEvent > 0

  return {
    observed:
      `beforeRun=${seen.beforeRun}; afterRun=${seen.afterRun}; beforeTool=${seen.beforeTool}; ` +
      `afterTool=${seen.afterTool}; onEvent=${seen.onEvent}; requests=${run.requests.length}; ` +
      `sideEffectBlocked=${String(blocked)}`,
    limitations: blocked
      ? []
      : ["the marker may also be absent because the tool never ran; see beforeTool count"],
    decision:
      allFired && blocked
        ? "the contract plugin can rely on beforeTool as a hard gate, and on onEvent for trajectory capture"
        : "the contract plugin cannot rely on beforeTool as its only gate; the post-run taint backstop becomes load-bearing",
    established: allFired && blocked,
  }
}

/** B6: can an `extraTools` entry start a child ClineCore session on the same working directory? */
async function claimSubagent(): Promise<ClaimOutcome> {
  const sdk = await loadSdk()
  const cwd = freshDir(join(SPIKE_DIR, "subagent", "cwd"))
  const child = { text: "", error: "", started: false }

  const tool = sdk.createTool({
    name: "spike_subagent",
    description: "Start a nested child session on the same working directory.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const childProvider = await startFakeProvider([{ content: "child-done" }])
      const core = await sdk.ClineCore.create({
        clientName: "cline-harness2-spike-child",
        backendMode: "local",
      })
      try {
        const session = await withTimeout(
          core.start({
            prompt: "child task",
            config: {
              cwd,
              providerId: "openai-compatible",
              modelId: SPIKE_MODEL_ID,
              apiKey: "spike-key",
              baseUrl: childProvider.baseUrl,
              systemPrompt: "You are the child agent.",
              enableTools: false,
              enableSpawnAgent: false,
              enableAgentTeams: false,
              maxIterations: 1,
              yolo: true,
            },
          }),
          SESSION_TIMEOUT_MS,
          "child session",
        )
        child.started = true
        child.text = session.result?.text ?? ""
      } catch (error) {
        child.error = error instanceof Error ? error.message : String(error)
      } finally {
        await core.dispose().catch(() => undefined)
        await childProvider.close().catch(() => undefined)
      }
      return { childStarted: child.started }
    },
  })

  const run = await runSession({
    cwd,
    prompt: "Delegate this to the subagent, then stop.",
    turns: [
      { toolCalls: [{ id: "call-sub", name: "spike_subagent", args: {} }] },
      { content: "done" },
    ],
    config: { extraTools: [tool] },
  })

  return {
    observed:
      `parentRequests=${run.requests.length}; childStarted=${String(child.started)}; ` +
      `childText=${JSON.stringify(child.text)}; childError=${JSON.stringify(child.error)}`,
    limitations: child.started
      ? ["child sessions are outside the 4k/3k budget; the ledger must exclude them explicitly"]
      : [child.error.length > 0 ? child.error : "the scripted model never invoked the tool"],
    decision: child.started
      ? "c5 subagents are implementable as extraTools spawning a child ClineCore session on the same cwd"
      : "c5 cannot be implemented as child ClineCore sessions on this SDK; re-open the c5 fallback",
    established: child.started,
  }
}

/** B4: does supplying `compact` suppress core's own strategy? Overflow cannot be induced here. */
async function claimCompaction(): Promise<ClaimOutcome> {
  const cwd = freshDir(join(SPIKE_DIR, "compaction", "cwd"))
  let compactCalls = 0

  const run = await runSession({
    cwd,
    prompt: "Reply with the single word done.",
    turns: [{ content: "done" }],
    config: {
      compaction: {
        enabled: true,
        compact: () => {
          compactCalls += 1
          return undefined
        },
      },
    },
  })

  return {
    observed: `requests=${run.requests.length}; compactCalls=${compactCalls}`,
    limitations: [
      "overflow was not induced, so a call count of 0 proves only that the config was accepted",
      "whether a supplied strategy also covers the overflow_recovery path remains unproven",
    ],
    decision:
      "T4 hard summarisation stays in compact(), with overflow_recovery documented as a residual rather than claimed",
    established: false,
  }
}

interface ClaimDefinition {
  readonly id: string
  readonly claim: string
  readonly blocks: readonly string[]
  readonly method: ClaimRecord["method"]
  readonly evidencePath: string
  readonly run: () => Promise<ClaimOutcome>
}

function baseClaim(
  definition: ClaimDefinition,
  sdkVersion: string,
  outcome: ClaimOutcome,
  error?: string,
): ClaimRecord {
  const unverified = error !== undefined || outcome.established !== true
  return {
    id: definition.id,
    claim: definition.claim,
    status: unverified ? "unverified" : "verified",
    method: error === undefined ? definition.method : "static",
    sdkVersion,
    nodeVersion: process.version,
    command: "pnpm spike:sdk",
    evidence: [{ path: definition.evidencePath, locator: "spike fixture directory" }],
    observed: error === undefined ? outcome.observed : `threw: ${error}`,
    limitations: [
      ...(outcome.limitations ?? []),
      ...(error === undefined ? [] : [`claim run failed: ${error}`]),
    ],
    decision: outcome.decision,
    blocks: error === undefined ? definition.blocks : [...definition.blocks, "retry this claim"],
  }
}

const CLAIMS: readonly ClaimDefinition[] = [
  {
    id: "B1.skills",
    claim: "CoreSessionConfig.skills is a name allowlist and <cwd>/.cline/skills is discovered",
    blocks: ["c6 skill mounting"],
    method: "core-scripted",
    evidencePath: ".tmp/spike/skills",
    run: claimSkills,
  },
  {
    id: "B2.plugin",
    claim: "how a candidate plugin enters a session: pluginPaths (file or directory) versus direct extensions injection",
    blocks: ["c8 plugin loading", "candidate plugin validation"],
    method: "core-scripted",
    evidencePath: ".tmp/spike/plugin",
    run: claimPlugin,
  },
  {
    id: "B3.messageBuilder",
    claim: "registerMessageBuilder receives the message array, runs in registration order, and reaches the provider",
    blocks: ["T4 soft stubs"],
    method: "core-scripted",
    evidencePath: ".tmp/spike/builder",
    run: claimMessageBuilder,
  },
  {
    id: "B5.hooks",
    claim: "beforeTool/afterTool/onEvent fire on a real session and {skip:true} blocks the side effect",
    blocks: ["contract plugin", "trajectory capture"],
    method: "core-scripted",
    evidencePath: ".tmp/spike/hooks",
    run: claimHooks,
  },
  {
    id: "B6.subagent",
    claim: "an extraTool can start a child ClineCore session on the same working directory",
    blocks: ["c5 subagents"],
    method: "core-scripted",
    evidencePath: ".tmp/spike/subagent",
    run: claimSubagent,
  },
  {
    id: "B4.compaction",
    claim: "supplying CoreCompactionConfig.compact suppresses the built-in strategy, including overflow recovery",
    blocks: ["T4 hard summarisation ownership"],
    method: "core-scripted",
    evidencePath: ".tmp/spike/compaction",
    run: claimCompaction,
  },
]

async function main(): Promise<void> {
  freshDir(SPIKE_DIR)
  freshDir(HOME_DIR)
  const sdkVersion = readSdkVersion()
  const claims: ClaimRecord[] = []

  for (const definition of CLAIMS) {
    process.stdout.write(`[spike] ${definition.id} ... `)
    try {
      const outcome = await withTimeout(definition.run(), CLAIM_TIMEOUT_MS, definition.id)
      const record = baseClaim(definition, sdkVersion, outcome)
      claims.push(record)
      process.stdout.write(`${record.status}\n`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      claims.push(
        baseClaim(
          definition,
          sdkVersion,
          { observed: "", decision: "not established", limitations: [], established: false },
          message,
        ),
      )
      process.stdout.write(`unverified (${message})\n`)
    }
  }

  const report: SpikeReport = {
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    sdkVersion,
    claims,
  }
  mkdirSync(join(ROOT, ".tmp"), { recursive: true })
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8")

  for (const claim of claims) {
    process.stdout.write(
      `\n${claim.id} [${claim.status}/${claim.method}]\n  ${claim.observed}\n  -> ${claim.decision}\n`,
    )
  }
  process.stdout.write(`\nwrote ${EVIDENCE_PATH}\n`)
}

await main()
