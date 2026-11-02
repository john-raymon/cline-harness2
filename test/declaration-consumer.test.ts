import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { ClineCore, createTool } from "@cline/sdk"
import type { AgentPlugin, AgentTool, CoreSessionConfig } from "@cline/sdk"

/**
 * Declaration sentinels.
 *
 * `skipLibCheck: true` is mandatory here: the `@cline/*` bundles use extensionless relative
 * imports that fail under `nodenext` (TS2834). That setting hides broken declarations, so it can
 * also hide a declaration collapsing to an unresolved / `any`-like type, which would silently
 * disable every type check on an SDK boundary. These assertions make that failure loud.
 *
 * Known SDK defect, verified by direct measurement and recorded as claim `B7` in
 * `docs/ADAPTER.md`: under `skipLibCheck`, both `CoreSessionConfig` and `AgentPlugin` accept
 * object literals that omit their own declared required fields. The two assignments below are the
 * tripwire — they compile today. If a future SDK tightens either type, `pnpm typecheck` fails
 * here, which is the signal to revisit `B7` rather than to discover the change at runtime.
 *
 * Consequence for this port: no SDK object we build may rely on the SDK's types for validity.
 * Everything crossing that boundary is validated by our own zod schemas.
 */
type IsAny<T> = 0 extends 1 & T ? true : false
type ExpectFalse<T extends false> = T

type _ClineCoreIsNotAny = ExpectFalse<IsAny<typeof ClineCore>>
type _SessionConfigIsNotAny = ExpectFalse<IsAny<CoreSessionConfig>>
type _AgentToolIsNotAny = ExpectFalse<IsAny<AgentTool>>

/** Tripwire: compiles only while `CoreSessionConfig` stays permissive (claim B7). */
export const partialSessionConfig: CoreSessionConfig = { providerId: "openai-compatible" }

/** Tripwire: compiles only while `AgentPlugin` stays permissive (claim B7). */
export const pluginWithoutManifest: AgentPlugin = { name: "no-manifest" }

/**
 * Locks the Chunk 1 decision that `skills` is a list of skill NAMES, not paths.
 *
 * If a future SDK changes this to a path-bearing shape, this line stops compiling — which is the
 * signal to revisit `docs/ADAPTER.md` claim B1 rather than to discover it at runtime.
 */
const skillsAreNames: NonNullable<CoreSessionConfig["skills"]> = ["pdf-tables"]

const minimalSessionConfig: CoreSessionConfig = {
  cwd: "/tmp/harness2-sandbox",
  providerId: "openai-compatible",
  modelId: "test-model",
  systemPrompt: "hello",
  enableTools: true,
  enableSpawnAgent: false,
  enableAgentTeams: false,
}

describe("@cline/sdk declarations", () => {
  it("resolves the runtime surface this port builds on", () => {
    assert.equal(typeof ClineCore.create, "function")
    assert.equal(typeof ClineCore.prototype.start, "function")
    assert.equal(typeof createTool, "function")
  })

  it("keeps the compile-time locks honest at runtime too", () => {
    assert.deepEqual(skillsAreNames, ["pdf-tables"])
    assert.equal(minimalSessionConfig.modelId, "test-model")
    assert.equal(partialSessionConfig.providerId, "openai-compatible")
    assert.equal(pluginWithoutManifest.name, "no-manifest")
  })
})
