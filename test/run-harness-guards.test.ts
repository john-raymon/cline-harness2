import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, it } from "node:test"

import { readLedgerFile } from "../src/ledger/ledger.ts"
import { runHarness } from "../src/run/harness.ts"
import { FIXTURE_SDK_VERSION } from "./support/evidence-fixture.ts"
import { astraClient, geminiAnswer, geminiClient, scripted } from "./support/oracle-fixtures.ts"
import {
  configWith,
  fakeCapture,
  fakeSdk,
  oraclesWith,
  proposalBlock,
  runRoot,
  TREE,
} from "./support/harness-fixture.ts"

describe("runHarness integration guards", () => {
  it("rejects a proposal that adds a path the capture never described", async () => {
    const root = await runRoot()
    const result = await runHarness({
      config: configWith({ root }),
      repo: "/repo",
      task: "fix the failing test",
      runId: "run-foreign-path",
      deps: {
        capture: fakeCapture(TREE),
        loadSdk: fakeSdk(),
        installedSdkVersion: FIXTURE_SDK_VERSION,
        evidencePath: path.join(root, "spike-evidence.json"),
        oracles: oraclesWith([proposalBlock("rules/new.md", "be nicer\n")]),
      },
    })

    assert.equal(result.outcome, "halted")
    assert.equal(result.improvements, 1, "the operation happened, so the ledger counts it")
    assert.equal(result.acceptedImprovements, 0, "but nothing was adopted")

    const events = await readLedgerFile(result.ledgerPath)
    const improvement = events.find((event) => event.kind === "improvement.finished")
    assert.equal(improvement?.kind === "improvement.finished" ? improvement.outcome : undefined, "rejected")

    const treeDir = path.join(result.runDir, "tree")
    await assert.rejects(
      readFile(path.join(treeDir, "rules", "new.md"), "utf8"),
      /ENOENT/,
      "a rejected proposal must not appear in the harness on disk",
    )
  })

  it("closes the ledger on the failure path, leaving no lock behind", async () => {
    const root = await runRoot()
    const result = await runHarness({
      config: configWith({ root }),
      repo: "/repo",
      task: "fix the failing test",
      runId: "run-lock",
      deps: {
        capture: fakeCapture(TREE),
        loadSdk: fakeSdk({ startError: new Error("provider returned 502") }),
        installedSdkVersion: FIXTURE_SDK_VERSION,
        evidencePath: path.join(root, "spike-evidence.json"),
      },
    })

    assert.equal(result.outcome, "failed")
    await assert.rejects(
      readFile(path.join(result.runDir, "ledger.lock"), "utf8"),
      /ENOENT/,
      "a handle left behind would block the next writer on this run directory",
    )
    const events = await readLedgerFile(result.ledgerPath)
    assert.equal(events.at(-1)?.kind, "run.finished")
  })
})

describe("runHarness redaction", () => {
  it("keeps a credential the solver echoed out of the oracle evidence and the log", async () => {
    const root = await runRoot()
    const key = "sk-live-0123456789abcdef"
    const script = scripted([
      geminiAnswer("I cannot propose anything."),
    ])
    const lines: string[] = []
    const result = await runHarness({
      config: configWith({ root, apiKey: key }),
      repo: "/repo",
      task: "fix the failing test",
      runId: "run-redact",
      report: (line) => lines.push(line),
      deps: {
        capture: fakeCapture(TREE),
        // The turn echoes the credential, which is exactly how it would reach an oracle prompt.
        loadSdk: fakeSdk({ text: `I used the key ${key} to call the provider` }),
        installedSdkVersion: FIXTURE_SDK_VERSION,
        evidencePath: path.join(root, "spike-evidence.json"),
        oracles: { gemini: geminiClient(script), astra: astraClient(scripted([])) },
      },
    })

    assert.equal(result.outcome, "halted")
    const sent = script.requests[0]?.stdin ?? ""
    assert.ok(sent.length > 0, "the improver was actually asked")
    assert.ok(!sent.includes(key), "the credential must not reach the oracle prompt")
    assert.ok(sent.includes("***"), "it is redacted, not silently dropped")
    assert.ok(!lines.join("\n").includes(key))
  })
})
