import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"

import { ContextError } from "../src/context/errors.ts"
import { compactContext, recordOverflowRecovery, SUMMARY_PREFIX } from "../src/context/compact.ts"
import { extractiveSummariser, type Summariser } from "../src/context/summarise.ts"
import { createEstimator } from "../src/context/tokens.ts"
import { attemptReasonSchema } from "../src/ledger/events.ts"
import { RunLedger, readLedgerFile } from "../src/ledger/ledger.ts"
import { asInput, runStartedBody } from "./support/ledger-fixtures.ts"

/**
 * The executing half of T4: rewrite the prefix, keep the tail, and prove the result is smaller.
 *
 * "Prove" is measured with the same estimator the detector used, so every assertion below is about the
 * estimate. No test here claims the provider's token count.
 */

const estimator = createEstimator({ bytesPerToken: 1 })
const THRESHOLDS = { tailTokens: 50, targetTokens: 400, b1Tokens: 500, b2Tokens: 600 }

const sandboxes: string[] = []
afterEach(async () => {
  for (const dir of sandboxes.splice(0)) await rm(dir, { recursive: true, force: true })
})

function message(role: string, content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { role, content, ...extra }
}

function conversation(): Record<string, unknown>[] {
  return [
    message("user", "task line"),
    message("user", "a".repeat(300)),
    message("assistant", "b".repeat(300)),
    message("user", "the newest question"),
  ]
}

describe("compactContext", () => {
  it("rewrites the prefix, keeps the tail verbatim, and meets the target", async () => {
    const messages = conversation()
    const result = await compactContext({ messages, thresholds: THRESHOLDS, estimator })
    assert.equal(result.kind, "applied")
    if (result.kind !== "applied") return

    assert.ok(result.postAssessment.measurement.total <= THRESHOLDS.targetTokens)
    assert.ok(result.postAssessment.measurement.total < result.assessment.measurement.total)
    // The task leads the conversation and the newest turn is the same object, not a copy of it.
    assert.equal(result.messages[0], messages[0])
    assert.equal(result.messages[result.messages.length - 1], messages[3])
    assert.equal(result.messages.length, 3, "two eligible turns became one summary")
    assert.ok(String((result.messages[1] as { content: string }).content).includes(SUMMARY_PREFIX))
    assert.equal(result.residual, 0)
  })

  it("is deterministic: the same conversation compacts to the same bytes", async () => {
    const first = await compactContext({ messages: conversation(), thresholds: THRESHOLDS, estimator })
    const second = await compactContext({ messages: conversation(), thresholds: THRESHOLDS, estimator })
    assert.equal(first.kind, "applied")
    if (first.kind !== "applied" || second.kind !== "applied") return
    assert.deepEqual(first.messages, second.messages)
    assert.equal(first.summariserId, second.summariserId)
  })

  it("does nothing when the context is already under b1", async () => {
    const result = await compactContext({
      messages: [message("user", "small")],
      thresholds: { tailTokens: 10, targetTokens: 20, b1Tokens: 100, b2Tokens: 200 },
      estimator,
    })
    assert.equal(result.kind, "skipped")
  })

  it("refuses when the tail already holds everything", async () => {
    const result = await compactContext({
      messages: [message("user", "one"), message("user", "two")],
      thresholds: { tailTokens: 1_000, targetTokens: 2_000, b1Tokens: 3_000, b2Tokens: 4_000 },
      estimator,
    })
    // Under b1 as well, so the more specific answer is "nothing to do".
    assert.equal(result.kind, "skipped")
  })

  it("refuses a target the retained parts already exceed, and reports the residual", async () => {
    const result = await compactContext({
      messages: [
        message("user", "t".repeat(600)),
        message("user", "m".repeat(80)),
        message("user", "newest"),
      ],
      thresholds: { tailTokens: 10, targetTokens: 100, b1Tokens: 200, b2Tokens: 300 },
      estimator,
    })
    assert.equal(result.kind, "refused")
    if (result.kind !== "refused") return
    assert.equal(result.reason, "TARGET_UNREACHABLE")
    assert.ok(result.residual > 0)
  })

  it("refuses a summary that does not actually make the context smaller", async () => {
    const liar: Summariser = { id: "liar", summarise: () => "x".repeat(5_000) }
    const result = await compactContext({
      messages: conversation(),
      thresholds: THRESHOLDS,
      estimator,
      summariser: liar,
    })
    assert.equal(result.kind, "refused")
    if (result.kind !== "refused") return
    assert.equal(result.reason, "TARGET_NOT_MET")
    assert.ok(result.residual > 0)
  })

  it("refuses a summary that would delete the earlier turns outright", async () => {
    const empty: Summariser = { id: "empty", summarise: () => "   " }
    const result = await compactContext({
      messages: conversation(),
      thresholds: THRESHOLDS,
      estimator,
      summariser: empty,
    })
    assert.equal(result.kind, "refused")
    if (result.kind !== "refused") return
    assert.equal(result.reason, "SUMMARY_EMPTY")
  })

  it("hands the summariser only the eligible turns and the budget it may spend", async () => {
    let seen: readonly unknown[] = []
    let budget = -1
    const spy: Summariser = {
      id: "spy",
      summarise: (input) => {
        seen = input.messages
        budget = input.budgetTokens
        return "spy summary"
      },
    }
    const result = await compactContext({
      messages: conversation(),
      thresholds: THRESHOLDS,
      estimator,
      summariser: spy,
    })
    assert.equal(result.kind, "applied")
    if (result.kind !== "applied") return
    assert.equal(result.summariserId, "spy")
    assert.deepEqual(
      (seen as readonly { index: number }[]).map((entry) => entry.index),
      [1, 2],
      "the task and the tail are never offered to the summariser",
    )
    assert.equal(budget, result.assessment.feasibility.kind === "fits" ? result.assessment.feasibility.summaryBudget : -1)
  })
})

describe("overflow recovery ledger entry", () => {
  it("folds the residual into the existing attempt reason instead of a new event kind", () => {
    assert.equal(attemptReasonSchema.parse("overflow-recovery"), "overflow-recovery")
  })

  it("appends an attempt against the open execution and replays cleanly", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "harness2-overflow-"))
    sandboxes.push(dir)
    const ledger = await RunLedger.open({ runDir: dir, k: 1 })
    await ledger.append(asInput(runStartedBody({ k: 1 })))
    await ledger.append({ kind: "execution.started", executionId: "e1", taskId: "t1" })

    await recordOverflowRecovery({ ledger, executionId: "e1", attemptId: "a1", residual: 42 })
    await ledger.append({ kind: "execution.finished", executionId: "e1", outcome: "error" })
    // The writer replays after every append, so reaching this line means the event sequence is valid.
    await ledger.append({
      kind: "run.finished",
      outcome: "failed",
      executions: 1,
      improvements: 0,
      physicalAttempts: 1,
    })
    await ledger.close()

    const events = await readLedgerFile(path.join(dir, "ledger.jsonl"))
    const attempt = events.find((event) => event.kind === "attempt.recorded")
    assert.equal(attempt?.kind === "attempt.recorded" ? attempt.reason : null, "overflow-recovery")
    assert.equal(attempt?.kind === "attempt.recorded" ? attempt.targetId : null, "e1")
  })

  it("refuses to record a residual that is not positive", async () => {
    const ledger = { append: async (event: unknown) => event } as unknown as Pick<RunLedger, "append">
    for (const residual of [0, -1, 1.5, Number.NaN]) {
      await assert.rejects(
        recordOverflowRecovery({ ledger, executionId: "e1", attemptId: "a1", residual }),
        (error: unknown) => error instanceof ContextError && error.code === "CONTEXT_RESIDUAL_INVALID",
      )
    }
  })
})

describe("review regressions", () => {
  it("keeps tool calls in the summariser's input even when the turn also has prose", async () => {
    let seen = ""
    const spy: Summariser = {
      id: "spy",
      summarise: (input) => {
        seen = input.messages.map((message) => JSON.stringify(message.raw)).join("\n")
        return "ok"
      },
    }
    await compactContext({
      messages: [
        message("user", "task line"),
        message("assistant", "let me look", { tool_calls: [{ id: "c1", function: { name: "read_files" } }] }),
        message("tool", "file body ".repeat(60), { tool_call_id: "c1" }),
        message("user", "newest question"),
      ],
      thresholds: THRESHOLDS,
      estimator,
      summariser: spy,
    })
    assert.ok(seen.includes("read_files"), "the tool name reaching the summariser is what describes the work")
  })

  it("keeps history in order when a system message splits the candidates into two runs", async () => {
    const messages = [
      message("user", "task line"),
      message("user", "old one".repeat(120)),
      message("system", "standing rule"),
      message("user", "old two".repeat(120)),
      message("user", "newest question"),
    ]
    const result = await compactContext({
      messages,
      thresholds: { tailTokens: 5, targetTokens: 1_500, b1Tokens: 1_800, b2Tokens: 2_000 },
      estimator,
    })
    assert.equal(result.kind, "applied")
    if (result.kind !== "applied") return
    const roles = result.messages.map((entry) => String((entry as { role: unknown }).role))
    // Two runs before the system message each collapse in place, so the system rule stays between them and
    // the summary of the later turns never appears before the turns that were retained.
    assert.deepEqual(roles, ["user", "user", "system", "user", "user"])
    const contents = result.messages.map((entry) => String((entry as { content: unknown }).content))
    assert.ok(contents[1]?.startsWith(SUMMARY_PREFIX.slice(0, 10)))
    assert.ok(contents[3]?.startsWith(SUMMARY_PREFIX.slice(0, 10)))
    assert.equal(result.messages[result.messages.length - 1], messages[4])
  })

  it("reports a residual for every refusal that happens while over target", async () => {
    const blocked = await compactContext({
      messages: [message("user", "only task".repeat(40))],
      thresholds: { tailTokens: 1, targetTokens: 10, b1Tokens: 20, b2Tokens: 30 },
      estimator,
    })
    assert.equal(blocked.kind, "refused")
    if (blocked.kind !== "refused") return
    assert.equal(blocked.reason, "NOTHING_ELIGIBLE")
    assert.ok(blocked.residual > 0, "nothing to record would mean the run looks like it met its target")

    const empty = await compactContext({
      messages: conversation(),
      thresholds: THRESHOLDS,
      estimator,
      summariser: { id: "empty", summarise: () => "" },
    })
    assert.equal(empty.kind, "refused")
    if (empty.kind !== "refused") return
    assert.equal(empty.reason, "SUMMARY_EMPTY")
    assert.ok(empty.residual > 0)
  })

  it("uses a one-token budget instead of declaring a tiny summary empty", () => {
    const summary = extractiveSummariser().summarise({
      messages: [{ index: 1, role: "user", raw: { role: "user", content: "abcdef" } }],
      budgetTokens: 1,
      estimator,
    })
    assert.equal(summary, "a", "the only separator is between lines, so the first line keeps its token")
  })
})
