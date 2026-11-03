import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, it } from "node:test"

import { readLedgerFile } from "../src/ledger/ledger.ts"
import { runHarness } from "../src/run/harness.ts"
import { FIXTURE_SDK_VERSION } from "./support/evidence-fixture.ts"
import {
  configWith,
  fakeCapture,
  failingOracles,
  fakeSdk,
  LESSON_TEXT,
  oraclesWith,
  proposalEditing,
  runRoot,
  TREE,
} from "./support/harness-fixture.ts"

describe("runHarness", () => {
  it("runs to the execution budget and completes", async () => {
    const root = await runRoot()
    const lines: string[] = []
    const result = await runHarness({
      config: configWith({ root }),
      repo: "/repo",
      task: "fix the failing test",
      runId: "run-budget",
      report: (line) => lines.push(line),
      deps: {
        capture: fakeCapture(TREE),
        loadSdk: fakeSdk({ text: "the test passes now" }),
        installedSdkVersion: FIXTURE_SDK_VERSION,
        evidencePath: path.join(root, "spike-evidence.json"),
        // Every cycle proposes a genuinely new file, so each improvement is accepted and the loop keeps
        // going until the 4-execution budget runs out.
        // Call order matters: the improver runs after each execution, and the Selector compares the
        // harness it produced against the one it replaced on the *next* execution.
        oracles: oraclesWith([
          proposalEditing("name the file a rule applies to"),
          "CHOICE: exec-2",
          proposalEditing("cite the evidence for a rule"),
          "CHOICE: exec-3",
          proposalEditing("prefer one edit at a time"),
          "CHOICE: exec-4",
        ]),
      },
    })

    assert.equal(result.outcome, "completed", "spending the budget is finishing, not giving up")
    assert.equal(result.reason, "executions-exhausted")
    assert.equal(result.executions, 4, "k=1 is exactly four executions")
    assert.equal(result.improvements, 3, "and three improvements: the last execution has no successor")
    assert.equal(result.acceptedImprovements, 3)
    assert.equal(result.selections.length, 3, "every accepted improvement was compared with its successor")
    assert.deepEqual(
      result.selections.map((selection) => [selection.chosen, selection.reverted]),
      [
        ["exec-2", false],
        ["exec-3", false],
        ["exec-4", false],
      ],
    )
    assert.ok(lines.some((line) => line.startsWith("execution exec-4")))

    const events = await readLedgerFile(result.ledgerPath)
    const kinds = events.map((event) => event.kind)
    assert.equal(kinds[0], "run.started")
    assert.equal(kinds.at(-1), "run.finished")
    assert.equal(kinds.filter((kind) => kind === "execution.started").length, 4)
    assert.equal(kinds.filter((kind) => kind === "execution.finished").length, 4)

    const written = await readFile(path.join(result.runDir, "tree", ".clinerules", "core.md"), "utf8")
    assert.match(written, /one edit at a time/, "the harness on disk is the one the run improved")
  })

  it("halts when a cycle produces nothing to carry forward", async () => {
    const root = await runRoot()
    const result = await runHarness({
      config: configWith({ root }),
      repo: "/repo",
      task: "fix the failing test",
      runId: "run-halt",
      deps: {
        capture: fakeCapture(TREE),
        loadSdk: fakeSdk(),
        installedSdkVersion: FIXTURE_SDK_VERSION,
        evidencePath: path.join(root, "spike-evidence.json"),
        oracles: oraclesWith(["I would rather not guess."]),
      },
    })

    assert.equal(result.outcome, "halted")
    assert.equal(result.reason, "no-improvement")
    assert.equal(result.executions, 1, "a barren cycle must not spend the rest of the budget")

    const events = await readLedgerFile(result.ledgerPath)
    const improvement = events.find((event) => event.kind === "improvement.finished")
    assert.equal(improvement?.kind === "improvement.finished" ? improvement.outcome : undefined, "rejected")
  })
})

describe("runHarness failure paths", () => {
  it("files a lesson from a failed execution and writes it into the harness", async () => {
    const root = await runRoot()
    const result = await runHarness({
      config: configWith({ root }),
      repo: "/repo",
      task: "fix the failing test",
      runId: "run-lesson",
      deps: {
        capture: fakeCapture(TREE),
        loadSdk: fakeSdk({ text: "gave up" }),
        installedSdkVersion: FIXTURE_SDK_VERSION,
        evidencePath: path.join(root, "spike-evidence.json"),
        grade: () => "fail",
        // Reflection first (the execution failed), then an improvement that does not happen.
        oracles: oraclesWith([LESSON_TEXT, "no proposal here"]),
      },
    })

    assert.equal(result.outcome, "halted")
    assert.equal(result.reason, "no-improvement")
    assert.equal(result.lessons, 1, "one failure, one lesson")

    const memory = await readFile(path.join(result.runDir, "tree", "LongTermMEMORY.md"), "utf8")
    assert.match(memory, /move the rule into rules\/<topic>\.md/)
  })

  it("fails and says why when the session cannot start", async () => {
    const root = await runRoot()
    const result = await runHarness({
      config: configWith({ root }),
      repo: "/repo",
      task: "fix the failing test",
      runId: "run-session-error",
      deps: {
        capture: fakeCapture(TREE),
        loadSdk: fakeSdk({ startError: new Error("provider returned 502") }),
        installedSdkVersion: FIXTURE_SDK_VERSION,
        evidencePath: path.join(root, "spike-evidence.json"),
      },
    })

    assert.equal(result.outcome, "failed")
    assert.equal(result.reason, "error")
    assert.match(result.detail, /502/)

    const events = await readLedgerFile(result.ledgerPath)
    const execution = events.find((event) => event.kind === "execution.finished")
    assert.equal(
      execution?.kind === "execution.finished" ? execution.outcome : undefined,
      "error",
      "a session that never started is recorded as an errored execution, not a silent one",
    )
  })

  it("fails rather than pretending when the oracle stage throws", async () => {
    const root = await runRoot()
    const result = await runHarness({
      config: configWith({ root }),
      repo: "/repo",
      task: "fix the failing test",
      runId: "run-oracle-error",
      deps: {
        capture: fakeCapture(TREE),
        loadSdk: fakeSdk(),
        installedSdkVersion: FIXTURE_SDK_VERSION,
        evidencePath: path.join(root, "spike-evidence.json"),
        oracles: failingOracles(),
      },
    })

    assert.equal(result.outcome, "failed")
    assert.equal(result.reason, "error")

    const events = await readLedgerFile(result.ledgerPath)
    const improvement = events.find((event) => event.kind === "improvement.finished")
    assert.equal(improvement?.kind === "improvement.finished" ? improvement.outcome : undefined, "error")
  })
})

describe("runHarness selection", () => {
  it("reads the installed SDK version without relying on an exported manifest", async () => {
    // The zero-config path has nothing else to go on: no injected version, no evidence file. `@cline/sdk`
    // does not export `./package.json`, so a `require` of the manifest throws — this pins the walk-around.
    const { readInstalledSdkVersion } = await import("../src/run/harness.ts")
    const version = readInstalledSdkVersion()
    assert.match(version, /^\d+\.\d+\.\d+/, "the claim gate compares this string against the evidence")
  })

  it("reverts an accepted improvement when the Selector prefers the incumbent", async () => {
    const root = await runRoot()
    const result = await runHarness({
      config: configWith({ root }),
      repo: "/repo",
      task: "fix the failing test",
      runId: "run-revert",
      deps: {
        capture: fakeCapture(TREE),
        loadSdk: fakeSdk(),
        installedSdkVersion: FIXTURE_SDK_VERSION,
        evidencePath: path.join(root, "spike-evidence.json"),
        // Improvement accepted on exec-1, then the Selector compares exec-2 against exec-1 and chooses the
        // incumbent. The second improvement cycle then refuses, which halts the run.
        oracles: oraclesWith([
          proposalEditing("name the file a rule applies to"),
          "CHOICE: exec-1",
          "no proposal here",
        ]),
      },
    })

    assert.equal(result.selections.length, 1)
    assert.equal(result.selections[0]?.chosen, "exec-1", JSON.stringify(result.selections))
    assert.equal(result.selections[0]?.reverted, true)

    const written = await readFile(path.join(result.runDir, "tree", ".clinerules", "core.md"), "utf8")
    assert.equal(
      written,
      TREE[".clinerules/core.md"],
      "a reverted improvement must restore the harness that was measured, not a partial edit",
    )
  })
})
