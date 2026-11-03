import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { BaselineCapture } from "../../src/baseline/capture.ts"
import type { SdkSlice } from "../../src/adapter/session.ts"
import type { OracleClients } from "../../src/oracle/client.ts"
import { runConfigSchema, type HarnessTree, type RunConfig } from "../../src/domain/schemas.ts"
import { harnessBaseline } from "./baseline-fixture.ts"
import { DEFAULT_FIXTURE_CLAIMS, FIXTURE_SDK_VERSION, writeEvidence } from "./evidence-fixture.ts"
import { astraClient, geminiAnswer, geminiClient, scripted } from "./oracle-fixtures.ts"

/**
 * Ports for an end-to-end run that never leaves the process.
 *
 * The loop in `src/run/harness.ts` takes capture, the SDK, both oracle clients and the grader as
 * dependencies, so a test can assert on the *loop* — its budget, its stop reasons, what it writes — instead
 * of on a provider. Shared here because two suites drive the same run for different reasons: one for the
 * happy path and its stop conditions, one for the guards the final audit added.
 */

export const TREE: HarnessTree = {
  ".clinerules/core.md": "prefer small, cited edits\n",
  "systemprompt.md": "you are working in a repository\n",
}

export function configWith(overrides: Partial<RunConfig> = {}): RunConfig {
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
    root: tmpdir(),
    ...overrides,
  })
}

/** Capture as a port: the fixture builds a baseline whose fingerprint actually pins this tree. */
export function fakeCapture(
  tree: HarnessTree,
): (input: { repoDir: string; ssotRoot: string }) => Promise<BaselineCapture> {
  const baseline = harnessBaseline(tree)
  return async () =>
    ({
      version: 1,
      tree,
      files: [],
      components: [],
      excluded: [],
      git: {
        baseSha: "a".repeat(40),
        dirty: [],
        dependencyLockHash: "c".repeat(64),
        toplevelMatches: true,
      },
      fingerprint: baseline.fingerprint,
      baselineSha: baseline.baselineSha,
    }) as BaselineCapture
}

export interface SdkScript {
  readonly text?: string
  readonly startError?: Error
}

export function fakeSdk(script: SdkScript = {}): () => Promise<SdkSlice> {
  return async () => ({
    ClineCore: {
      async create(): Promise<unknown> {
        return {
          async start(): Promise<unknown> {
            if (script.startError !== undefined) throw script.startError
            return {
              sessionId: "session-1",
              result: {
                text: script.text ?? "done",
                iterations: 1,
                finishReason: "stop",
                toolCalls: [{ name: "run_commands" }],
              },
            }
          },
          subscribe(): () => void {
            return () => undefined
          },
          async abort(): Promise<void> {},
          async dispose(): Promise<void> {},
        }
      },
    },
  })
}

/**
 * A proposal that edits a captured file.
 *
 * Editing rather than adding is deliberate: a run improves the harness it captured, and adding a path would
 * change what the baseline manifest describes. `.clinerules/` rather than an arbitrary path because that is
 * what the compiler renders into the prompt, so an accepted improvement here really moves
 * `compiledPromptHash` — an edit the solver never sees would prove nothing.
 */
export function proposalEditing(rule: string): string {
  return proposalBlock(".clinerules/core.md", `prefer small, cited edits\n${rule}\n`)
}

export function proposalBlock(file: string, body: string): string {
  return [`<<<proposal:${file}>>>`, body, `<<<end proposal:${file}>>>`].join("\n")
}

export function oraclesWith(replies: readonly string[]): OracleClients {
  const script = scripted(replies.map((text) => geminiAnswer(text)))
  return { gemini: geminiClient(script), astra: astraClient(script) }
}

export const LESSON_TEXT = [
  "CUE: a harness that states a rule without naming the file it applies to",
  "LESSON: move the rule into rules/<topic>.md so it can be cited",
  "EVIDENCE: the execution finished without citing any rule file",
  "CONFIDENCE: medium - one failed execution under this fingerprint",
].join("\n")

/** A run root with claim evidence in it, so `bootstrapSession` gets past the gate. */
export async function runRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "harness2-e2e-"))
  await writeEvidence(
    path.join(root, "spike-evidence.json"),
    FIXTURE_SDK_VERSION,
    DEFAULT_FIXTURE_CLAIMS,
  )
  return root
}

/** An oracle whose transport reports a failure instead of an answer. */
export function failingOracles(): OracleClients {
  const failed = scripted([{ code: 1, stdout: "", stderr: "gemini-api: quota exceeded" }])
  return { gemini: geminiClient(failed), astra: astraClient(scripted([])) }
}
