import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { afterEach, describe, it } from "node:test"
import os from "node:os"
import path from "node:path"

import { runConfigSchema, type HarnessTree, type RunConfig } from "../src/domain/schemas.ts"
import { AdapterError } from "../src/adapter/errors.ts"
import { buildBootstrapPrompt } from "../src/adapter/prompt.ts"
import {
  API_KEY_SOURCES,
  DEFAULT_MAX_ITERATIONS,
  MAX_EVENT_TYPES,
  bootstrapSession,
  sessionBootstrapRecordSchema,
  type SessionBootstrapInput,
  type SdkSlice,
} from "../src/adapter/session.ts"
import { readTree } from "../src/harness/tree-store.ts"
import { PolicyError } from "../src/policy/errors.ts"
import { writeEvidence } from "./support/evidence-fixture.ts"

const scratchRoots: string[] = []

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness2-session-"))
  scratchRoots.push(root)
  return root
}

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

const TREE: HarnessTree = { "EXPERIENCE.md": "# lessons\n", ".clinerules/rules.md": "rules\n" }
const BASELINE_SHA = "a".repeat(64)
const RUN_ID = "20261102T080000Z-abcdef"

interface FakeScript {
  readonly start?: () => Promise<unknown>
  readonly events?: readonly unknown[]
  readonly disposeError?: Error
  readonly disposeHangs?: boolean
  readonly disposeSyncThrow?: Error
  readonly abortSyncThrow?: Error
  readonly subscribeError?: Error
  readonly unsubscribeError?: Error
  readonly createValue?: unknown
  /** Tool names the fake "model" tries to call during the turn, so the gate is exercised in-session. */
  readonly toolCalls?: readonly string[]
}

interface FakeState {
  loaded: boolean
  created: boolean
  started: boolean
  startInput: Record<string, unknown> | null
  aborted: string[]
  disposed: boolean
  unsubscribed: boolean
}

interface FakeSdk {
  readonly loadSdk: () => Promise<SdkSlice>
  readonly state: FakeState
}

const DEFAULT_RESULT = {
  sessionId: RUN_ID,
  manifestPath: "/tmp/manifest.json",
  messagesPath: "/tmp/messages.json",
  result: {
    text: "ok",
    iterations: 2,
    finishReason: "stop",
    toolCalls: [{ name: "run_commands" }],
  },
  pluginIssues: [{ name: "guard", pluginPath: "/p/guard.ts", state: "failed", reason: "error" }],
}

function fakeSdk(script: FakeScript = {}): FakeSdk {
  const state: FakeState = {
    loaded: false,
    created: false,
    started: false,
    startInput: null,
    aborted: [],
    disposed: false,
    unsubscribed: false,
  }
  let listener: ((event: unknown) => void) | undefined

  const core = {
    async start(input: Record<string, unknown>): Promise<unknown> {
      state.started = true
      state.startInput = input
      // Mirror the SDK: the gate is consulted while the turn runs, not before it starts. Decisions made
      // here are the ones a probe record should carry.
      const config = input["config"] as
        | { hooks?: { beforeTool?: (context: unknown) => unknown } }
        | undefined
      for (const name of script.toolCalls ?? []) {
        config?.hooks?.beforeTool?.({ toolCall: { name } })
      }
      for (const event of script.events ?? []) listener?.(event)
      return script.start === undefined ? DEFAULT_RESULT : await script.start()
    },
    subscribe(next: (event: unknown) => void): () => void {
      if (script.subscribeError !== undefined) throw script.subscribeError
      listener = next
      return () => {
        state.unsubscribed = true
        if (script.unsubscribeError !== undefined) throw script.unsubscribeError
      }
    },
    abort: (sessionId: string): Promise<void> => {
      if (script.abortSyncThrow !== undefined) throw script.abortSyncThrow
      state.aborted.push(sessionId)
      return Promise.resolve()
    },
    dispose: (): Promise<void> => {
      if (script.disposeSyncThrow !== undefined) throw script.disposeSyncThrow
      state.disposed = true
      if (script.disposeHangs === true) return new Promise<never>(() => undefined)
      if (script.disposeError !== undefined) return Promise.reject(script.disposeError)
      return Promise.resolve()
    },
  }

  const sdk: SdkSlice = {
    ClineCore: {
      async create(): Promise<unknown> {
        state.created = true
        return script.createValue === undefined ? core : script.createValue
      },
    },
  }

  return {
    loadSdk: async () => {
      state.loaded = true
      return sdk
    },
    state,
  }
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

function clock(): () => Date {
  let tick = 0
  return () => new Date(Date.UTC(2026, 10, 2, 8, 0, tick++))
}

async function inputWith(
  overrides: Partial<SessionBootstrapInput> & { rootDir: string },
): Promise<SessionBootstrapInput> {
  // Every session installs a `beforeTool` gate, so the claim gate now requires B5.hooks; without a
  // report every one of these tests would fail on evidence rather than on what it is testing.
  await mkdir(overrides.rootDir, { recursive: true })
  const evidencePath = await writeEvidence(path.join(overrides.rootDir, "spike-evidence.json"))
  return {
    config: configWith(),
    baseline: { tree: TREE, baselineSha: BASELINE_SHA },
    prompt: buildBootstrapPrompt("Say ok"),
    apiKeySource: "SOLVER_API_KEY",
    evidencePath,
    installedSdkVersion: "0.2.0",
    runId: RUN_ID,
    ...overrides,
  }
}

/** Everything in a run root except the evidence report every input has to write there. */
async function runEntries(root: string): Promise<string[]> {
  return (await readdir(root)).filter((entry) => entry !== "spike-evidence.json").sort()
}

async function codeOf(operation: Promise<unknown>): Promise<string> {
  try {
    await operation
  } catch (error) {
    assert.ok(error instanceof AdapterError, `expected AdapterError, got ${String(error)}`)
    return error.code
  }
  assert.fail("expected a rejection")
}

async function errorOf(operation: Promise<unknown>): Promise<AdapterError> {
  try {
    await operation
  } catch (error) {
    assert.ok(error instanceof AdapterError, `expected AdapterError, got ${String(error)}`)
    return error
  }
  assert.fail("expected a rejection")
}

describe("pre-flight", () => {
  it("refuses to start without an API key, before loading the SDK", async () => {
    const root = await scratch()
    const fake = fakeSdk()
    const { apiKey: _dropped, ...withoutKey } = configWith()

    assert.equal(
      await codeOf(
        bootstrapSession({
          ...(await inputWith({ rootDir: root })),
          config: runConfigSchema.parse(withoutKey),
          deps: { loadSdk: fake.loadSdk },
        }),
      ),
      "API_KEY_MISSING",
    )
    assert.equal(fake.state.loaded, false)
    assert.equal(fake.state.created, false)
  })

  it("checks the claims it depends on before it creates anything", async () => {
    const root = await scratch()
    const fake = fakeSdk()
    const tree: HarnessTree = { ".cline/skills/pdf/SKILL.md": "# pdf\n" }

    assert.equal(
      await codeOf(
        bootstrapSession({
          ...(await inputWith({ rootDir: root })),
          baseline: { tree, baselineSha: BASELINE_SHA },
          // A session with a hook gate and a skill has two claims to check, and no report to check them
          // against: that is a reason not to start at all.
          evidencePath: path.join(root, "absent-evidence.json"),
          deps: { loadSdk: fake.loadSdk },
        }),
      ),
      "SPIKE_EVIDENCE_MISSING",
    )
    // No run directory, no SDK load: an unverifiable dependency is a reason not to start at all.
    assert.deepEqual(await runEntries(root), [])
    assert.equal(fake.state.loaded, false)
  })

  it("requires the skills claim when the tree ships a skill, and proceeds once it is verified", async () => {
    const root = await scratch()
    const fake = fakeSdk()
    const tree: HarnessTree = { ".cline/skills/pdf/SKILL.md": "# pdf\n" }
    const evidencePath = path.join(root, "evidence.json")
    await writeFile(
      evidencePath,
      JSON.stringify({
        sdkVersion: "0.2.0",
        claims: [
          { id: "B1.skills", status: "verified" },
          { id: "B5.hooks", status: "verified" },
        ],
      }),
      "utf8",
    )

    const record = await bootstrapSession({
      ...(await inputWith({ rootDir: path.join(root, "runs") })),
      baseline: { tree, baselineSha: BASELINE_SHA },
      evidencePath,
      deps: { loadSdk: fake.loadSdk },
    })
    assert.deepEqual(await readTree({ dir: record.harnessDir }), tree)
  })
})

describe("creating the runtime", () => {
  it("reports an SDK that fails to load", async () => {
    const root = await scratch()
    const error = await errorOf(
      bootstrapSession({
        ...(await inputWith({ rootDir: root })),
        deps: {
          loadSdk: async () => {
            throw new Error("cannot resolve @cline/sdk")
          },
        },
      }),
    )
    assert.equal(error.code, "SESSION_CREATE_FAILED")
    assert.match(error.message, /cannot resolve @cline\/sdk/)
  })

  it("reports a handle that is missing the calls the adapter makes", async () => {
    const root = await scratch()
    const fake = fakeSdk({ createValue: { start: () => undefined } })
    const error = await errorOf(
      bootstrapSession({
        ...(await inputWith({ rootDir: root })),
        deps: { loadSdk: fake.loadSdk },
      }),
    )
    assert.equal(error.code, "SESSION_CREATE_FAILED")
    assert.match(error.message, /subscribe/)
  })

  it("reports a subscribe failure as a create failure and still disposes", async () => {
    const root = await scratch()
    const fake = fakeSdk({ subscribeError: new Error("event bus unavailable") })
    const error = await errorOf(
      bootstrapSession({
        ...(await inputWith({ rootDir: root })),
        deps: { loadSdk: fake.loadSdk },
      }),
    )
    assert.equal(error.code, "SESSION_CREATE_FAILED")
    assert.match(error.message, /event bus unavailable/)
    assert.equal(fake.state.disposed, true)
  })
})

describe("the first turn", () => {
  it("maps a rejected start to SESSION_START_FAILED and still tears down", async () => {
    const root = await scratch()
    const fake = fakeSdk({ start: async () => Promise.reject(new Error("provider said 500")) })
    const error = await errorOf(
      bootstrapSession({
        ...(await inputWith({ rootDir: root })),
        deps: { loadSdk: fake.loadSdk },
      }),
    )
    assert.equal(error.code, "SESSION_START_FAILED")
    assert.match(error.message, /provider said 500/)
    assert.equal(fake.state.disposed, true)
    assert.equal(fake.state.unsubscribed, true)
  })

  it("rejects a session that resolved without a turn", async () => {
    const root = await scratch()
    const fake = fakeSdk({ start: async () => ({ sessionId: RUN_ID }) })
    const error = await errorOf(
      bootstrapSession({
        ...(await inputWith({ rootDir: root })),
        deps: { loadSdk: fake.loadSdk },
      }),
    )
    assert.equal(error.code, "SESSION_INVALID_RESULT")
    assert.match(error.message, /no turn completed/)
  })

  it("rejects an empty turn and says why the loop stopped", async () => {
    const root = await scratch()
    const fake = fakeSdk({
      start: async () => ({
        sessionId: RUN_ID,
        result: { text: "   ", iterations: 2, finishReason: "max_iterations" },
      }),
    })
    const error = await errorOf(
      bootstrapSession({
        ...(await inputWith({ rootDir: root })),
        deps: { loadSdk: fake.loadSdk },
      }),
    )
    assert.equal(error.code, "SESSION_INVALID_RESULT")
    assert.match(error.message, /max_iterations/)
    assert.match(error.message, /iterations=2/)
  })
})

describe("deadlines and cancellation", () => {
  it("times out, aborts by the id it supplied, and still disposes", async () => {
    const root = await scratch()
    const fake = fakeSdk({ start: () => new Promise<never>(() => undefined) })
    const error = await errorOf(
      bootstrapSession({
        ...(await inputWith({ rootDir: root })),
        timeoutMs: 20,
        deps: { loadSdk: fake.loadSdk },
      }),
    )
    assert.equal(error.code, "SESSION_TIMEOUT")
    // The result carries the session id only after resolving, so the abort must use the id we passed.
    assert.deepEqual(fake.state.aborted, [RUN_ID])
    assert.equal(fake.state.disposed, true)
  })

  it("honours an already-aborted signal without starting or aborting", async () => {
    const root = await scratch()
    const fake = fakeSdk()
    const controller = new AbortController()
    controller.abort()
    const error = await errorOf(
      bootstrapSession({
        ...(await inputWith({ rootDir: root })),
        signal: controller.signal,
        deps: { loadSdk: fake.loadSdk },
      }),
    )
    assert.equal(error.code, "SESSION_ABORTED")
    assert.equal(fake.state.started, false)
    assert.deepEqual(fake.state.aborted, [])
    assert.equal(fake.state.disposed, true)
  })
})

describe("the record", () => {
  it("carries the whole bootstrap and never the API key", async () => {
    const root = await scratch()
    const fake = fakeSdk({
      events: [{ type: "turn_start" }, { type: "text_delta" }, { type: "turn_start" }],
    })
    const record = await bootstrapSession({
      ...(await inputWith({ rootDir: root })),
      deps: { loadSdk: fake.loadSdk, now: clock() },
    })

    assert.equal(sessionBootstrapRecordSchema.safeParse(record).success, true)
    assert.equal(record.runId, RUN_ID)
    assert.equal(record.sessionId, RUN_ID)
    assert.equal(record.baselineSha, BASELINE_SHA)
    assert.equal(record.promptSource, "bootstrap-constant")
    assert.equal(record.apiKeySource, "SOLVER_API_KEY")
    assert.equal(record.text, "ok")
    assert.equal(record.turns, 2)
    assert.equal(record.finishReason, "stop")
    assert.equal(record.toolCallCount, 1)
    assert.deepEqual(record.pluginIssues, ["guard at /p/guard.ts: failed (error)"])
    assert.equal(record.manifestPath, "/tmp/manifest.json")
    assert.equal(record.messagesPath, "/tmp/messages.json")
    assert.equal(record.eventCount, 3)
    assert.deepEqual(record.eventTypes, ["turn_start", "text_delta"])
    assert.deepEqual(await readTree({ dir: record.harnessDir }), TREE)
    assert.equal(JSON.stringify(record).includes("test-key-never-real"), false)
  })

  it("counts every event while capping the distinct type list", async () => {
    const root = await scratch()
    const events: { type: string }[] = []
    for (let index = 0; index < 200; index += 1) events.push({ type: `evt-${String(index)}` })
    events.push({ type: "evt-0" }, { type: "evt-0" })

    const fake = fakeSdk({ events })
    const record = await bootstrapSession({
      ...(await inputWith({ rootDir: root })),
      deps: { loadSdk: fake.loadSdk },
    })

    assert.equal(record.eventCount, 202)
    assert.equal(record.eventTypes.length, MAX_EVENT_TYPES)
    assert.equal(record.eventTypes[0], "evt-0")
  })
})

describe("the start payload", () => {
  it("points the session at the materialised copy and denies every tool", async () => {
    const root = await scratch()
    const fake = fakeSdk()
    const record = await bootstrapSession({
      ...(await inputWith({ rootDir: root })),
      deps: { loadSdk: fake.loadSdk },
    })

    const payload = fake.state.startInput
    assert.equal(payload?.["prompt"], "Say ok")
    const config = payload?.["config"] as Record<string, unknown>
    assert.equal(config["cwd"], record.harnessDir)
    assert.equal(config["workspaceRoot"], record.harnessDir)
    assert.equal(config["sessionId"], RUN_ID)
    assert.equal(config["providerId"], "openai-compatible")
    assert.equal(config["modelId"], "spike-model")
    assert.equal(config["enableTools"], true)
    assert.equal(config["enableSpawnAgent"], false)
    assert.equal(config["enableAgentTeams"], false)
    assert.equal(config["maxIterations"], DEFAULT_MAX_ITERATIONS)
    // Pinned explicitly so an SDK default flip cannot start taking git stash refs in the operator repo.
    assert.deepEqual(config["checkpoint"], { enabled: false })

    const hooks = config["hooks"] as {
      beforeTool: (context: unknown) => { skip: boolean; appendContext: string }
    }
    const verdict = hooks.beforeTool({ toolCall: { name: "run_commands" } })
    assert.equal(verdict.skip, true)
    // The default-deny reason is recorded verbatim, so "no policy" is distinguishable from "denied".
    assert.match(verdict.appendContext, /default-deny/)
  })

  it("records the policy it ran under and lets an allowed tool through", async () => {
    const root = await scratch()
    const fake = fakeSdk({ toolCalls: ["run_commands", "write_to_file"] })
    const tree: HarnessTree = { ...TREE, "tools/run_commands.md": "Run shell commands.\n" }
    const record = await bootstrapSession({
      ...(await inputWith({ rootDir: root })),
      baseline: { tree, baselineSha: BASELINE_SHA },
      toolPolicy: { allow: ["run_commands"], deny: [] },
      maxIterations: 4,
      deps: { loadSdk: fake.loadSdk },
    })

    const config = fake.state.startInput?.["config"] as Record<string, unknown>
    assert.equal(config["maxIterations"], 4)
    assert.deepEqual(record.toolPolicySet, ["allow:run_commands"])
    assert.equal(record.toolInventoryHash.length, 64)
    // Decisions come from the turn itself, so the record says what the gate actually did.
    assert.deepEqual(
      record.toolDecisions.map((decision) => [decision.toolName, decision.verdict, decision.reason]),
      [
        ["run_commands", "allow", "allowed"],
        ["write_to_file", "deny", "not-allowed"],
      ],
    )

    const hooks = config["hooks"] as { beforeTool: (context: unknown) => unknown }
    assert.equal(hooks.beforeTool({ toolCall: { name: "run_commands" } }), undefined)
    const refused = hooks.beforeTool({ toolCall: { name: "write_to_file" } }) as { skip: boolean }
    assert.equal(refused.skip, true)
  })

  it("refuses a policy that names a tool the tree does not define", async () => {
    const root = await scratch()
    // Dead configuration is an error: a policy naming `nope` would run as an allowlist that permits
    // nothing while the operator believes it permits `nope`.
    await assert.rejects(
      bootstrapSession({
        ...(await inputWith({ rootDir: root })),
        toolPolicy: { allow: ["nope"], deny: [] },
        deps: { loadSdk: fakeSdk().loadSdk },
      }),
      (error: unknown) => error instanceof PolicyError && error.code === "POLICY_UNKNOWN_TOOL",
    )
    assert.deepEqual(await runEntries(root), [], "a rejected policy must not create a run directory")
  })

  it("refuses a malformed tools directory before creating anything", async () => {
    const root = await scratch()
    const tree: HarnessTree = { ...TREE, "tools/nested/skill.md": "not a tool\n" }
    await assert.rejects(
      bootstrapSession({
        ...(await inputWith({ rootDir: root })),
        baseline: { tree, baselineSha: BASELINE_SHA },
        deps: { loadSdk: fakeSdk().loadSdk },
      }),
      (error: unknown) => error instanceof PolicyError && error.code === "TOOL_INVENTORY_INVALID",
    )
    assert.deepEqual(await runEntries(root), [])
  })

  it("accepts every API key source the config can report", () => {
    for (const source of API_KEY_SOURCES) {
      assert.equal(
        sessionBootstrapRecordSchema.shape.apiKeySource.safeParse(source).success,
        true,
        `api key source ${source} should be valid`,
      )
    }
    assert.equal(
      sessionBootstrapRecordSchema.shape.apiKeySource.safeParse("SOMETHING_ELSE").success,
      false,
    )
  })
})

describe("teardown", () => {
  it("does not let a dispose failure mask the failure that caused it", async () => {
    const root = await scratch()
    const fake = fakeSdk({
      start: async () => Promise.reject(new Error("provider exploded")),
      disposeError: new Error("dispose exploded"),
    })
    const error = await errorOf(
      bootstrapSession({
        ...(await inputWith({ rootDir: root })),
        deps: { loadSdk: fake.loadSdk },
      }),
    )
    assert.equal(error.code, "SESSION_START_FAILED")
    assert.match(error.message, /provider exploded/)
  })

  it("reports a dispose failure that would otherwise leak a running session", async () => {
    const root = await scratch()
    const fake = fakeSdk({ disposeError: new Error("runtime still running") })
    const error = await errorOf(
      bootstrapSession({
        ...(await inputWith({ rootDir: root })),
        deps: { loadSdk: fake.loadSdk },
      }),
    )
    assert.equal(error.code, "SESSION_DISPOSE_FAILED")
    assert.match(error.message, /runtime still running/)
  })

  it("survives an unsubscribe that throws", async () => {
    const root = await scratch()
    const fake = fakeSdk({ unsubscribeError: new Error("listener already gone") })
    const record = await bootstrapSession({
      ...(await inputWith({ rootDir: root })),
      deps: { loadSdk: fake.loadSdk },
    })
    assert.equal(record.text, "ok")
    assert.equal(fake.state.disposed, true)
  })
})

describe("timeouts and teardown bounds", () => {
  it("rejects an unusable timeout before it creates anything", async () => {
    const root = await scratch()
    const fake = fakeSdk()
    for (const timeoutMs of [0, -5, Number.NaN, 2_147_483_648]) {
      assert.equal(
        await codeOf(
          bootstrapSession({
            ...(await inputWith({ rootDir: root })),
            timeoutMs,
            deps: { loadSdk: fake.loadSdk },
          }),
        ),
        "TIMEOUT_INVALID",
        `timeout ${String(timeoutMs)} should be refused`,
      )
    }
    // Node would have turned every one of those into a ~1ms timer, aborting the session instantly.
    assert.deepEqual(await runEntries(root), [])
    assert.equal(fake.state.loaded, false)
  })

  it("does not surface a late rejection from a start it already abandoned", async () => {
    const root = await scratch()
    // The start rejects long after the deadline won the race. `Promise.race` subscribes to every
    // entrant, so the loser's rejection is already handled; if that were false this test would fail
    // the whole run with an unhandled rejection instead of passing.
    const fake = fakeSdk({
      start: () =>
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("late failure after the deadline")), 40)
        }),
    })
    const error = await errorOf(
      bootstrapSession({
        ...(await inputWith({ rootDir: root })),
        timeoutMs: 10,
        deps: { loadSdk: fake.loadSdk },
      }),
    )
    assert.equal(error.code, "SESSION_TIMEOUT")
    await new Promise<void>((resolve) => setTimeout(resolve, 80))
  })

  it("stops waiting for a dispose that never settles", async () => {
    const root = await scratch()
    const fake = fakeSdk({ disposeHangs: true })
    const error = await errorOf(
      bootstrapSession({
        ...(await inputWith({ rootDir: root })),
        deps: { loadSdk: fake.loadSdk, teardownTimeoutMs: 10 },
      }),
    )
    assert.equal(error.code, "SESSION_DISPOSE_FAILED")
    assert.match(error.message, /did not dispose within 10ms/)
  })

  it("does not let a synchronous dispose throw mask the start failure", async () => {
    const root = await scratch()
    // The fake throws before returning a promise, which a `.catch()` on the call site would miss.
    const fake = fakeSdk({
      start: async () => Promise.reject(new Error("provider exploded")),
      disposeSyncThrow: new Error("dispose threw synchronously"),
    })
    const error = await errorOf(
      bootstrapSession({
        ...(await inputWith({ rootDir: root })),
        deps: { loadSdk: fake.loadSdk },
      }),
    )
    assert.equal(error.code, "SESSION_START_FAILED")
    assert.match(error.message, /provider exploded/)
  })

  it("does not let a synchronous abort throw replace the timeout", async () => {
    const root = await scratch()
    const fake = fakeSdk({
      start: () => new Promise<never>(() => undefined),
      abortSyncThrow: new Error("abort threw synchronously"),
    })
    const error = await errorOf(
      bootstrapSession({
        ...(await inputWith({ rootDir: root })),
        timeoutMs: 10,
        deps: { loadSdk: fake.loadSdk },
      }),
    )
    assert.equal(error.code, "SESSION_TIMEOUT")
    assert.match(error.message, /did not complete a turn/)
  })

  it("reports a synchronous dispose throw on the success path", async () => {
    const root = await scratch()
    const fake = fakeSdk({ disposeSyncThrow: new Error("dispose threw synchronously") })
    const error = await errorOf(
      bootstrapSession({
        ...(await inputWith({ rootDir: root })),
        deps: { loadSdk: fake.loadSdk },
      }),
    )
    assert.equal(error.code, "SESSION_DISPOSE_FAILED")
    assert.match(error.message, /dispose threw synchronously/)
  })
})
