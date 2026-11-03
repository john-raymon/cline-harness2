import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"

import { runConfigSchema, type RunConfig } from "../src/domain/schemas.ts"
import { LEDGER_FILE_NAME, RunLedger, readLedgerFile } from "../src/ledger/ledger.ts"
import type { ToolPolicy } from "../src/policy/policy.ts"
import {
  SUBAGENT_DIR,
  SUBAGENT_TOOL_NAME,
  spawnSubagent,
  spawnToolDefinition,
} from "../src/subagent/spawn.ts"
import { SubagentError, type SubagentParent } from "../src/subagent/types.ts"
import { FIXTURE_SDK_VERSION, writeEvidence } from "./support/evidence-fixture.ts"
import { asInput, runStartedBody } from "./support/ledger-fixtures.ts"

/**
 * The subagent path, exercised through the tool object the SDK is actually handed.
 *
 * `spawnToolDefinition(...)` is the production tool: it is what `extraTools` carries into a live session, so
 * calling `execute` on it runs the same code a model's tool call would. What is faked is only the SDK below
 * it — no provider round-trip, so this is not a live gate (see `docs/ADAPTER.md` for what remains unproven).
 */

const sandboxes: string[] = []

afterEach(async () => {
  for (const dir of sandboxes.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness2-subagent-"))
  sandboxes.push(dir)
  return dir
}

function configWith(overrides: Partial<RunConfig> = {}): RunConfig {
  return runConfigSchema.parse({
    k: 1,
    mode: "parallel",
    tailTokens: 24_000,
    targetTokens: 105_000,
    b1Tokens: 120_000,
    b2Tokens: 160_000,
    providerId: "openai-compatible",
    modelId: "spike-model",
    baseUrl: "https://example.invalid/v1",
    arbitration: "off",
    apiKey: "test-key-never-real",
    root: os.tmpdir(),
    ...overrides,
  })
}

interface FakeSdk {
  readonly sdk: Record<string, unknown>
  readonly starts: Record<string, unknown>[]
  readonly disposed: string[]
  /** The options handed to `ClineCore.create`, so the backend choice is asserted rather than assumed. */
  readonly created: Record<string, unknown>[]
}

function fakeSdk(behaviour: { fail?: boolean } = {}): FakeSdk {
  const starts: Record<string, unknown>[] = []
  const disposed: string[] = []
  const created: Record<string, unknown>[] = []
  const core = {
    start: async (payload: Record<string, unknown>) => {
      starts.push(payload)
      if (behaviour.fail === true) throw new Error("the provider exploded")
      return { result: { text: `child answered: ${String(payload.prompt)}` } }
    },
    dispose: async () => {
      disposed.push("disposed")
    },
  }
  return {
    starts,
    disposed,
    created,
    sdk: {
      createTool: (definition: unknown) => definition,
      ClineCore: {
        create: async (options: Record<string, unknown>) => {
          created.push(options)
          return core
        },
      },
    },
  }
}

/** A parent whose run directory already holds a ledger with one `run.started`. */
async function parentFixture(options: {
  readonly policy?: ToolPolicy | undefined
  readonly claims?: readonly string[] | undefined
  readonly signal?: AbortSignal | undefined
} = {}): Promise<{ parent: SubagentParent; parentLedger: string; before: string }> {
  const dir = await sandbox()
  const harnessDir = path.join(dir, "harness")
  const runDir = path.join(dir, "run")
  await mkdir(harnessDir, { recursive: true })
  await mkdir(runDir, { recursive: true })

  const ledger = await RunLedger.open({ runDir, k: 1 })
  await ledger.append(asInput(runStartedBody({ k: 1 })))
  await ledger.close()
  const parentLedger = path.join(runDir, LEDGER_FILE_NAME)
  const before = await readFile(parentLedger, "utf8")

  const evidencePath = await writeEvidence(
    path.join(dir, "evidence.json"),
    FIXTURE_SDK_VERSION,
    options.claims ?? ["B5.hooks", "B2.plugin", "B6.subagent"],
  )

  return {
    parentLedger,
    before,
    parent: {
      harnessDir,
      runDir,
      config: configWith(),
      toolPolicy: options.policy,
      baselineSha: "a".repeat(64),
      promptSha256: "b".repeat(64),
      toolPolicySet: ["default:deny"],
      toolInventoryHash: "c".repeat(64),
      apiKey: "test-key-never-real",
      apiKeySource: "--api-key",
      evidencePath,
      installedSdkVersion: FIXTURE_SDK_VERSION,
      remainingMs: 5_000,
      signal: options.signal,
    },
  }
}

async function childLedgerOf(parent: SubagentParent, childRunId: string): Promise<string> {
  return path.join(parent.runDir, SUBAGENT_DIR, childRunId, LEDGER_FILE_NAME)
}

const ALLOW_READ: ToolPolicy = { allow: ["read_files", SUBAGENT_TOOL_NAME], deny: [] }

/** A child run's lifecycle: one attempt, opened and closed, then the terminal run event. */
const CHILD_KINDS = [
  "run.started",
  "execution.started",
  "attempt.recorded",
  "execution.finished",
  "run.finished",
]

function lastOf(events: readonly { kind: string }[]): { kind: string; outcome?: string } {
  const last = events[events.length - 1]
  assert.ok(last !== undefined)
  return last as { kind: string; outcome?: string }
}

describe("spawn_subagent", () => {
  it("runs a child through the real tool object and leaves the parent ledger byte-identical", async () => {
    const { parent, parentLedger, before } = await parentFixture({ policy: ALLOW_READ })
    const fake = fakeSdk()
    const tool = spawnToolDefinition(async ({ task }) =>
      spawnSubagent({ parent, task, deps: { loadSdk: async () => fake.sdk } }),
    )

    const result = (await tool.execute({ task: "summarise the tree" })) as {
      ok: boolean
      childRunId: string
      outcome: string
      text: string
    }

    assert.equal(result.ok, true)
    assert.equal(result.outcome, "completed")
    assert.match(result.text, /summarise the tree/)

    // The parent's file is untouched, bytes and all: the spawn owns only its child writer.
    assert.equal(await readFile(parentLedger, "utf8"), before)

    const childEvents = await readLedgerFile(await childLedgerOf(parent, result.childRunId))
    assert.deepEqual(
      childEvents.map((event) => event.kind),
      CHILD_KINDS,
    )
    const finished = childEvents[childEvents.length - 1]
    assert.equal(finished?.kind === "run.finished" ? finished.outcome : null, "completed")
    assert.equal(fake.disposed.length, 1)
  })

  it("hands the child the same cwd, a rebuilt gate and no way to recurse", async () => {
    const { parent } = await parentFixture({ policy: ALLOW_READ })
    const fake = fakeSdk()
    const tool = spawnToolDefinition(async ({ task }) =>
      spawnSubagent({ parent, task, deps: { loadSdk: async () => fake.sdk } }),
    )

    await tool.execute({ task: "inspect" })
    const payload = fake.starts[0] as { prompt: string; config: Record<string, unknown> }
    assert.equal(payload.config.cwd, parent.harnessDir)
    assert.equal(payload.config.workspaceRoot, parent.harnessDir)
    assert.deepEqual(payload.config.extraTools, [])
    assert.equal(payload.config.enableSpawnAgent, false)
    // `B6.subagent` recorded the spawn against the local backend; `auto` discovery could drop the plugin.
    assert.equal(fake.created[0]?.backendMode, "local")
    assert.equal(Array.isArray(payload.config.extensions), true)

    const childEvents = await readLedgerFile(
      await childLedgerOf(parent, (payload.config.sessionId as string) ?? ""),
    )
    const started = childEvents[0]
    assert.deepEqual(
      started?.kind === "run.started" ? started.toolPolicySet : null,
      ["allow:read_files", "deny:spawn_subagent"],
      "the child records the policy it ran under, not the parent's",
    )

    // The gate is rebuilt on the child, not inherited: it refuses the spawn tool even though the parent allows it.
    const hooks = payload.config.hooks as { beforeTool: (context: unknown) => unknown }
    const refusal = hooks.beforeTool({ toolCall: { name: SUBAGENT_TOOL_NAME } })
    assert.deepEqual(refusal, {
      skip: true,
      appendContext: "harness2 tool policy: spawn_subagent refused (denied)",
    })
    assert.equal(hooks.beforeTool({ toolCall: { name: "read_files" } }), undefined)
  })

  it("closes the child ledger even when the child fails", async () => {
    const { parent } = await parentFixture({ policy: ALLOW_READ })
    const fake = fakeSdk({ fail: true })
    const tool = spawnToolDefinition(async ({ task }) =>
      spawnSubagent({ parent, task, deps: { loadSdk: async () => fake.sdk } }),
    )

    const result = (await tool.execute({ task: "doomed" })) as {
      ok: boolean
      error: string
    }
    // A failed helper is reported to the model, not thrown into the parent run.
    assert.equal(result.ok, false)
    assert.match(result.error, /the provider exploded/)

    const dir = path.join(parent.runDir, SUBAGENT_DIR)
    const childRunId = (await readdir(dir))[0]
    assert.ok(childRunId !== undefined)
    const events = await readLedgerFile(await childLedgerOf(parent, childRunId as string))
    assert.deepEqual(
      events.map((event) => event.kind),
      CHILD_KINDS,
    )
    assert.equal(lastOf(events).outcome, "failed")
    assert.equal(fake.disposed.length, 1)
  })

  it("records a halt when the parent signal aborts mid-flight", async () => {
    const controller = new AbortController()
    const { parent } = await parentFixture({ policy: ALLOW_READ, signal: controller.signal })
    const sdk = {
      createTool: (definition: unknown) => definition,
      ClineCore: {
        create: async () => ({
          start: async () => {
            controller.abort()
            await new Promise((resolve) => setTimeout(resolve, 5))
            throw new Error("aborted by the caller")
          },
          dispose: async () => undefined,
        }),
      },
    }

    await assert.rejects(
      spawnSubagent({ parent, task: "long job", deps: { loadSdk: async () => sdk } }),
      (error: unknown) => error instanceof SubagentError && error.code === "SUBAGENT_START_FAILED",
    )

    const dir = path.join(parent.runDir, SUBAGENT_DIR)
    const entries = await readdir(dir)
    const events = await readLedgerFile(await childLedgerOf(parent, entries[0] as string))
    assert.equal(lastOf(events).outcome, "halted")
  })

  it("refuses to spawn when the runtime has not verified B6.subagent", async () => {
    const { parent } = await parentFixture({ policy: ALLOW_READ, claims: ["B5.hooks", "B2.plugin"] })
    const fake = fakeSdk()

    await assert.rejects(
      spawnSubagent({ parent, task: "anything", deps: { loadSdk: async () => fake.sdk } }),
      /B6\.subagent/,
    )
    // Refused before anything was created: no child directory, no child ledger, no SDK load.
    await assert.rejects(readFile(path.join(parent.runDir, SUBAGENT_DIR), "utf8"))
    assert.equal(fake.starts.length, 0)
  })

  it("keeps a child's cost out of the parent ledger's replay", async () => {
    const { parent, parentLedger } = await parentFixture({ policy: ALLOW_READ })
    const fake = fakeSdk()
    const tool: ReturnType<typeof spawnToolDefinition> = spawnToolDefinition(async ({ task }) =>
      spawnSubagent({ parent, task, deps: { loadSdk: async () => fake.sdk } }),
    )

    await tool.execute({ task: "one" })
    await tool.execute({ task: "two" })

    const parentEvents = await readLedgerFile(parentLedger)
    assert.deepEqual(
      parentEvents.map((event) => event.kind),
      ["run.started"],
    )
    const childDirs = await readdir(path.join(parent.runDir, SUBAGENT_DIR))
    // Two children, two ledgers, two terminal events, and the parent still has one event.
    assert.equal(childDirs.length, 2)
    for (const childRunId of childDirs) {
      const events = await readLedgerFile(await childLedgerOf(parent, childRunId))
      assert.deepEqual(
        events.map((event) => event.kind),
        CHILD_KINDS,
      )
    }
  })

  it("refuses before creating anything when the parent has no time left", async () => {
    const { parent } = await parentFixture({ policy: ALLOW_READ })
    const starved: SubagentParent = { ...parent, remainingMs: 0 }
    const fake = fakeSdk()

    await assert.rejects(
      spawnSubagent({ parent: starved, task: "no room", deps: { loadSdk: async () => fake.sdk } }),
      (error: unknown) =>
        error instanceof SubagentError && error.code === "SUBAGENT_BUDGET_EXHAUSTED",
    )
    await assert.rejects(readFile(path.join(parent.runDir, SUBAGENT_DIR), "utf8"))
    assert.equal(fake.created.length, 0)
  })

  it("never lets an explicit timeout extend a child past the parent's remaining time", async () => {
    const { parent } = await parentFixture({ policy: ALLOW_READ })
    // A generous explicit timeout against 1ms of parent budget: the smaller of the two has to win.
    const nearlyExpired: SubagentParent = { ...parent, remainingMs: 1 }
    const sdk = {
      createTool: (definition: unknown) => definition,
      ClineCore: {
        create: async () => ({
          start: () => new Promise<never>(() => undefined),
          dispose: async () => undefined,
        }),
      },
    }

    await assert.rejects(
      spawnSubagent({
        parent: nearlyExpired,
        task: "too slow",
        timeoutMs: 60_000,
        deps: { loadSdk: async () => sdk },
      }),
      (error: unknown) =>
        error instanceof SubagentError && error.code === "SUBAGENT_START_FAILED",
    )
  })

  it("does not credit the child with an attempt when the SDK never loaded", async () => {
    const { parent } = await parentFixture({ policy: ALLOW_READ })

    await assert.rejects(
      spawnSubagent({
        parent,
        task: "unloadable",
        deps: {
          loadSdk: async () => {
            throw new Error("no sdk here")
          },
        },
      }),
      (error: unknown) =>
        error instanceof SubagentError && error.code === "SUBAGENT_START_FAILED",
    )

    const childRunId = (await readdir(path.join(parent.runDir, SUBAGENT_DIR)))[0] as string
    const events = await readLedgerFile(await childLedgerOf(parent, childRunId))
    // run.started and a terminal event, with no execution and no attempt: nothing ran, so nothing is counted.
    assert.deepEqual(
      events.map((event) => event.kind),
      ["run.started", "run.finished"],
    )
    const finished = events[1]
    assert.equal(finished?.kind === "run.finished" ? finished.outcome : null, "failed")
    assert.equal(finished?.kind === "run.finished" ? finished.physicalAttempts : null, 0)
  })
})
