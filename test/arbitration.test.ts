import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"

import { artifactsDirOf } from "../src/ledger/artifacts.ts"
import { RunLedger, readLedgerFile } from "../src/ledger/ledger.ts"
import { replayLedger } from "../src/ledger/replay.ts"
import {
  arbitrate,
  compareAnswers,
  recordArbitration,
  type ArbitrationOutcome,
} from "../src/oracle/arbitrate.ts"
import {
  arbitrationArtifactName,
  readArbitrationArtifact,
  writeArbitrationArtifact,
} from "../src/oracle/artifacts.ts"
import { OracleError } from "../src/oracle/errors.ts"
import {
  astraAnswer,
  astraClient,
  CONTEXT,
  geminiAnswer,
  geminiClient,
  scripted,
} from "./support/oracle-fixtures.ts"
import { asInput, eventAt, runStartedBody } from "./support/ledger-fixtures.ts"

/**
 * Dual-oracle arbitration.
 *
 * The gate is one sentence: a disagreement is surfaced, not averaged. So every assertion below is about
 * the *record* rather than the answer — the primary text is untouched, both texts are frozen, the
 * ledger carries only a pointer, and replay counts no work for any of it.
 */

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness2-arbitration-"))
  roots.push(root)
  return root
}

async function codeOf(task: Promise<unknown>): Promise<string> {
  try {
    await task
  } catch (error) {
    assert.ok(error instanceof OracleError, `expected an OracleError, got ${String(error)}`)
    return error.code
  }
  assert.fail("expected this call to fail")
}

const ASK = "choose one candidate"

describe("compareAnswers", () => {
  it("treats line endings and trailing spaces as noise", () => {
    const compared = compareAnswers("CHOICE: a\r\nWHY: cheaper  \n\n", "CHOICE: a\nWHY: cheaper")
    assert.equal(compared.agreed, true)
    assert.equal(compared.divergence, undefined)
  })

  it("points at the first line that differs, and keeps interior blank lines", () => {
    const compared = compareAnswers("CHOICE: a\n\nWHY: one", "CHOICE: a\n\nWHY: two")
    assert.equal(compared.agreed, false)
    assert.equal(compared.divergence?.line, 3)
    assert.equal(compared.divergence?.primary, "WHY: one")
    assert.equal(compared.divergence?.secondary, "WHY: two")
  })

  it("reports a length difference rather than calling the shorter one equal", () => {
    const compared = compareAnswers("CHOICE: a\nWHY: one", "CHOICE: a")
    assert.equal(compared.agreed, false)
    assert.equal(compared.divergence?.line, 2)
    assert.equal(compared.divergence?.secondary, "")
  })
})

describe("arbitrate", () => {
  it("makes no second call when arbitration is off", async () => {
    // One scripted reply: a second call would throw "unscripted", which is the assertion.
    const script = scripted([geminiAnswer("CHOICE: a")])
    const outcome = await arbitrate({
      mode: "off",
      primary: geminiClient(script),
      secondary: astraClient(script),
      request: { role: "selector", ask: ASK, context: CONTEXT },
    })
    assert.equal(outcome.status, "skipped")
    assert.equal(script.requests.length, 1)
    assert.match(outcome.reason ?? "", /opted into with --arbitration probe/)
  })

  it("stays skipped in probe mode when only one provider exists", async () => {
    const script = scripted([geminiAnswer("CHOICE: a")])
    const outcome = await arbitrate({
      mode: "probe",
      primary: geminiClient(script),
      request: { role: "selector", ask: ASK, context: CONTEXT },
    })
    assert.equal(outcome.status, "skipped")
    assert.equal(script.requests.length, 1)
    assert.match(outcome.reason ?? "", /needs a second provider/)
  })

  it("reports agreement without merging anything", async () => {
    const script = scripted([
      geminiAnswer("CHOICE: a\nWHY: cheaper"),
      astraAnswer("CHOICE: a\nWHY: cheaper\n"),
    ])
    const outcome = await arbitrate({
      mode: "probe",
      primary: geminiClient(script),
      secondary: astraClient(script),
      request: { role: "selector", ask: ASK, context: CONTEXT },
    })
    assert.equal(outcome.status, "agreed")
    assert.equal(outcome.primary.text, "CHOICE: a\nWHY: cheaper")
    assert.equal(outcome.secondary?.text, "CHOICE: a\nWHY: cheaper")
    assert.equal(outcome.divergence, undefined)
  })

  it("surfaces a disagreement instead of averaging the two answers", async () => {
    const script = scripted([
      geminiAnswer("CHOICE: a\nWHY: cheaper"),
      astraAnswer("CHOICE: b\nWHY: faster"),
    ])
    const outcome = await arbitrate({
      mode: "probe",
      primary: geminiClient(script),
      secondary: astraClient(script),
      request: { role: "selector", ask: ASK, context: CONTEXT },
    })
    assert.equal(outcome.status, "disagreed")
    assert.equal(outcome.primary.text, "CHOICE: a\nWHY: cheaper", "the primary answer is not edited")
    assert.equal(outcome.secondary?.text, "CHOICE: b\nWHY: faster")
    assert.equal(outcome.divergence?.line, 1)
    assert.equal(outcome.divergence?.primary, "CHOICE: a")
    assert.equal(outcome.divergence?.secondary, "CHOICE: b")
  })

  it("keeps the answer when the second oracle fails", async () => {
    const script = scripted([geminiAnswer("CHOICE: a"), { code: 1, stderr: "rate limited" }])
    const outcome = await arbitrate({
      mode: "probe",
      primary: geminiClient(script),
      secondary: astraClient(script),
      request: { role: "selector", ask: ASK, context: CONTEXT },
    })
    assert.equal(outcome.status, "partial")
    assert.equal(outcome.primary.text, "CHOICE: a")
    assert.equal(outcome.secondary, undefined)
    assert.match(outcome.reason ?? "", /TRANSPORT_FAILED/)
  })
})

describe("arbitration artifacts", () => {
  function artifact(overrides: Record<string, unknown> = {}) {
    return {
      version: 1 as const,
      status: "disagreed" as const,
      role: "selector" as const,
      ask: ASK,
      contextSha256: "c".repeat(64),
      answers: [
        {
          provider: "gemini",
          modelId: "gemini-4-argon",
          transport: "gemini-cli",
          roleId: "selector-v1",
          promptSha256: "f".repeat(64),
          chars: 10,
          latencyMs: 5,
          text: "CHOICE: a",
        },
        {
          provider: "astra",
          modelId: "gpt-6-astra",
          transport: "codex-cli",
          roleId: "selector-v1",
          promptSha256: "f".repeat(64),
          chars: 10,
          latencyMs: 6,
          text: "CHOICE: b",
        },
      ],
      failure: null,
      divergence: { line: 1, primary: "CHOICE: a", secondary: "CHOICE: b" },
      ...overrides,
    }
  }

  it("names the file after its own digest, and writing the same pair twice is idempotent", async () => {
    const runDir = await scratch()
    const first = await writeArbitrationArtifact({ runDir, artifact: artifact() })
    const second = await writeArbitrationArtifact({ runDir, artifact: artifact() })

    assert.equal(first.sha256, second.sha256)
    assert.equal(path.basename(first.path), arbitrationArtifactName(first.sha256))
    assert.equal(path.dirname(first.path), artifactsDirOf(runDir))
    assert.ok((await readFile(first.path, "utf8")).endsWith("\n"))
  })

  it("verifies the bytes against the digest on read", async () => {
    const runDir = await scratch()
    const stored = await writeArbitrationArtifact({ runDir, artifact: artifact() })

    const back = await readArbitrationArtifact({ runDir, sha256: stored.sha256 })
    assert.equal(back.ask, ASK)
    assert.equal(back.answers.length, 2)

    await writeFile(stored.path, `${await readFile(stored.path, "utf8")} `, "utf8")
    assert.equal(
      await codeOf(readArbitrationArtifact({ runDir, sha256: stored.sha256 })),
      "ARBITRATION_ARTIFACT_CORRUPT",
      "an artifact edited after it was frozen must not be quoted",
    )
  })

  it("reports a pointer whose evidence is gone", async () => {
    const runDir = await scratch()
    assert.equal(
      await codeOf(readArbitrationArtifact({ runDir, sha256: "d".repeat(64) })),
      "ARBITRATION_ARTIFACT_MISSING",
    )
  })
})

describe("recordArbitration", () => {
  async function openLedger(): Promise<{ runDir: string; ledger: RunLedger }> {
    const runDir = await scratch()
    const ledger = await RunLedger.open({ runDir, k: 1 })
    await ledger.append(asInput(runStartedBody()))
    return { runDir, ledger }
  }

  async function probe(script: ReturnType<typeof scripted>): Promise<ArbitrationOutcome> {
    return await arbitrate({
      mode: "probe",
      primary: geminiClient(script),
      secondary: astraClient(script),
      request: { role: "selector", ask: ASK, context: CONTEXT },
    })
  }

  it("freezes both answers and leaves only a pointer in the ledger", async () => {
    const { runDir, ledger } = await openLedger()
    const stored = await recordArbitration({
      ledger,
      runDir,
      arbitrationId: "arb-1",
      ask: ASK,
      outcome: await probe(scripted([geminiAnswer("CHOICE: a"), astraAnswer("CHOICE: b")])),
    })

    const events = await readLedgerFile(ledger.filePath)
    const event = events.find((entry) => entry.kind === "arbitration.recorded")
    assert.ok(event !== undefined && event.kind === "arbitration.recorded")
    assert.equal(event.status, "disagreed")
    assert.equal(event.role, "selector")
    assert.equal(event.artifactSha256, stored.artifactSha256)
    assert.equal(event.primaryProvider, "gemini")
    assert.equal(event.secondaryProvider, "astra")
    assert.ok(
      !JSON.stringify(event).includes("CHOICE"),
      "the ledger records a pointer, not the answers",
    )

    const frozen = await readArbitrationArtifact({ runDir, sha256: event.artifactSha256 })
    assert.deepEqual(
      frozen.answers.map((entry) => entry.text),
      ["CHOICE: a", "CHOICE: b"],
    )
    assert.equal(frozen.divergence?.line, 1)
    await ledger.close()
  })

  it("counts nothing towards the budget, and still closes a completed run", async () => {
    const { runDir, ledger } = await openLedger()
    await recordArbitration({
      ledger,
      runDir,
      arbitrationId: "arb-1",
      ask: ASK,
      outcome: await probe(scripted([geminiAnswer("CHOICE: a"), astraAnswer("CHOICE: b")])),
    })

    const counts = await ledger.counts()
    assert.equal(counts.executions, 0)
    assert.equal(counts.improvements, 0)
    assert.equal(counts.physicalAttempts, 0, "a probe outside the ledger is not a retry")

    await ledger.finishRun("completed")
    assert.equal(replayLedger(await ledger.read()).finished, true)
    await ledger.close()
  })

  it("refuses a skipped probe, and two answers to different questions", async () => {
    const { runDir, ledger } = await openLedger()
    const off = await arbitrate({
      mode: "off",
      primary: geminiClient(scripted([geminiAnswer("CHOICE: a")])),
      request: { role: "selector", ask: ASK, context: CONTEXT },
    })
    assert.equal(
      await codeOf(recordArbitration({ ledger, runDir, arbitrationId: "arb-1", ask: ASK, outcome: off })),
      "ARBITRATION_REFUSED",
    )

    const outcome = await probe(scripted([geminiAnswer("CHOICE: a"), astraAnswer("CHOICE: b")]))
    const secondary = outcome.secondary
    assert.ok(secondary !== undefined)
    const confounded: ArbitrationOutcome = {
      ...outcome,
      secondary: { ...secondary, contextSha256: "e".repeat(64) },
    }
    assert.equal(
      await codeOf(
        recordArbitration({ ledger, runDir, arbitrationId: "arb-2", ask: ASK, outcome: confounded }),
      ),
      "ARBITRATION_REFUSED",
    )
    await ledger.close()
  })

  it("rejects a second record under the same id", async () => {
    const { runDir, ledger } = await openLedger()
    await recordArbitration({
      ledger,
      runDir,
      arbitrationId: "arb-1",
      ask: ASK,
      outcome: await probe(scripted([geminiAnswer("CHOICE: a"), astraAnswer("CHOICE: b")])),
    })

    await assert.rejects(
      recordArbitration({
        ledger,
        runDir,
        arbitrationId: "arb-1",
        ask: ASK,
        outcome: await probe(scripted([geminiAnswer("CHOICE: a"), astraAnswer("CHOICE: b")])),
      }),
      (error: unknown) => error instanceof Error && /arb-1/.test(error.message),
    )
    await ledger.close()
  })
})

describe("review regressions", () => {
  it("reports a divergence line that matches the verbatim text stored beside it", () => {
    const primary = "CHOICE: a\nWHY: one"
    const secondary = "\nCHOICE: a\nWHY: one"
    const compared = compareAnswers(primary, secondary)
    assert.equal(compared.agreed, false)
    assert.equal(compared.divergence?.line, 1)
    assert.equal(compared.divergence?.primary, primary.split("\n")[0])
    assert.equal(compared.divergence?.secondary, "")
  })

  it("refuses a digest that is not a digest instead of using it as a path", async () => {
    const runDir = await scratch()
    assert.equal(
      await codeOf(readArbitrationArtifact({ runDir, sha256: "../../etc/passwd" })),
      "ARBITRATION_ARTIFACT_INVALID",
    )
  })

  it("refuses an artifact whose status contradicts its own body", async () => {
    const runDir = await scratch()
    const oneAnswer = {
      version: 1 as const,
      status: "agreed" as const,
      role: "selector" as const,
      ask: ASK,
      contextSha256: "c".repeat(64),
      answers: [
        {
          provider: "gemini",
          modelId: "gemini-4-argon",
          transport: "gemini-cli",
          roleId: "selector-v1",
          promptSha256: "f".repeat(64),
          chars: 10,
          latencyMs: 5,
          text: "CHOICE: a",
        },
      ],
      failure: null,
      divergence: null,
    }
    assert.equal(
      await codeOf(writeArbitrationArtifact({ runDir, artifact: oneAnswer })),
      "ARBITRATION_ARTIFACT_INVALID",
      "agreement needs two answers; one answer is a partial probe",
    )
  })

  it("refuses a ledger line that claims agreement and a missing second provider", () => {
    const events = [
      eventAt(1, runStartedBody()),
      eventAt(2, {
        kind: "arbitration.recorded",
        arbitrationId: "arb-1",
        role: "selector",
        status: "agreed",
        artifactSha256: "a".repeat(64),
        contextSha256: "b".repeat(64),
        primaryProvider: "gemini",
        secondaryProvider: null,
      }),
      eventAt(3, { kind: "run.finished", outcome: "completed", executions: 0, improvements: 0, physicalAttempts: 0 }),
    ]
    assert.throws(
      () => replayLedger(events),
      (error: unknown) => error instanceof Error && /must name the second provider/.test(error.message),
    )
  })
})
