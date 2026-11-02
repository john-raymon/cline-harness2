import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { LedgerError } from "../src/ledger/errors.ts"
import type { LedgerEvent } from "../src/ledger/events.ts"
import { EMPTY_COUNTS, replayLedger } from "../src/ledger/replay.ts"
import { eventAt, eventSequence, runStartedBody } from "./support/ledger-fixtures.ts"

/**
 * Replay is where "counts are exact" is decided.
 *
 * Each test below is a way a naive counter gets the wrong answer: a gap in the sequence, a duplicate
 * finish, an attempt silently treated as progress, a summary that disagrees with its own events. The
 * function refuses all of them, so a caller can trust its output rather than its tone.
 */

function replayError(events: readonly LedgerEvent[]): LedgerError {
  try {
    replayLedger(events)
  } catch (error) {
    assert.ok(error instanceof LedgerError, `expected a LedgerError, got ${String(error)}`)
    return error
  }
  assert.fail("expected replayLedger to refuse this history")
}

const STAGES = ["improver", "composer", "selector", "reflector"] as const

describe("ledger replay", () => {
  it("reports nothing for an empty ledger", () => {
    assert.deepEqual(replayLedger([]), EMPTY_COUNTS)
  })

  it("counts a started run with no work as zero", () => {
    const counts = replayLedger(eventSequence([runStartedBody()]))
    assert.equal(counts.executions, 0)
    assert.equal(counts.improvements, 0)
    assert.equal(counts.physicalAttempts, 0)
    assert.equal(counts.lastSeq, 1)
    assert.equal(counts.finished, false)
  })

  it("counts a full 4k/3k budget exactly and keeps attempts separate", () => {
    const bodies: Record<string, unknown>[] = [runStartedBody({ k: 2 })]
    for (let index = 1; index <= 8; index += 1) {
      bodies.push({ kind: "execution.started", executionId: `exec-${index}`, taskId: "task-1" })
      if (index === 1) {
        bodies.push({ kind: "attempt.recorded", attemptId: "att-1", of: "execution", targetId: `exec-${index}`, reason: "initial" })
        bodies.push({ kind: "attempt.recorded", attemptId: "att-2", of: "execution", targetId: `exec-${index}`, reason: "retry" })
      }
      bodies.push({ kind: "execution.finished", executionId: `exec-${index}`, outcome: "pass" })
    }
    for (let index = 1; index <= 6; index += 1) {
      const stage = STAGES[(index - 1) % STAGES.length]
      bodies.push({ kind: "improvement.started", improvementId: `imp-${index}`, stage })
      bodies.push({ kind: "improvement.finished", improvementId: `imp-${index}`, outcome: "accepted" })
    }
    bodies.push({
      kind: "run.finished",
      outcome: "completed",
      executions: 8,
      improvements: 6,
      physicalAttempts: 2,
    })

    const counts = replayLedger(eventSequence(bodies))
    assert.equal(counts.executions, 8, "4k with k=2 is 8 executions")
    assert.equal(counts.improvements, 6, "3k with k=2 is 6 improvements")
    assert.equal(counts.physicalAttempts, 2, "attempts are cost, not progress")
    assert.deepEqual(counts.openExecutions, [])
    assert.deepEqual(counts.openImprovements, [])
    assert.equal(counts.byStage.improver, 2)
    assert.equal(
      counts.byStage.improver + counts.byStage.composer + counts.byStage.selector + counts.byStage.reflector,
      6,
    )
    assert.equal(counts.finished, true)
  })

  it("does not let attempts inflate the execution count", () => {
    const counts = replayLedger(
      eventSequence([
        runStartedBody(),
        { kind: "execution.started", executionId: "exec-1", taskId: "task-1" },
        { kind: "attempt.recorded", attemptId: "att-1", of: "execution", targetId: "exec-1", reason: "retry" },
        { kind: "attempt.recorded", attemptId: "att-2", of: "execution", targetId: "exec-1", reason: "schema-repair" },
      ]),
    )
    assert.equal(counts.executions, 0)
    assert.equal(counts.physicalAttempts, 2)
    assert.deepEqual(counts.openExecutions, ["exec-1"])
  })

  it("refuses a history that does not start with run.started", () => {
    const error = replayError(
      eventSequence([{ kind: "execution.started", executionId: "exec-1", taskId: "task-1" }]),
    )
    assert.equal(error.code, "LEDGER_INVALID_EVENT")
    assert.match(error.message, /must be run\.started/)
  })

  it("refuses a second run in one file", () => {
    const error = replayError(eventSequence([runStartedBody(), runStartedBody()]))
    assert.equal(error.code, "LEDGER_DUPLICATE")
    assert.match(error.message, /exactly one run/)
  })

  it("refuses a gap in the sequence and names the line", () => {
    const error = replayError([
      eventAt(1, runStartedBody()),
      eventAt(3, { kind: "execution.started", executionId: "e", taskId: "t" }),
    ])
    assert.equal(error.code, "LEDGER_CORRUPT")
    assert.equal(error.line, 2)
    assert.match(error.message, /expected seq 2/)
  })

  it("refuses a duplicate start for the same id", () => {
    const error = replayError(
      eventSequence([
        runStartedBody(),
        { kind: "execution.started", executionId: "exec-1", taskId: "task-1" },
        { kind: "execution.started", executionId: "exec-1", taskId: "task-1" },
      ]),
    )
    assert.equal(error.code, "LEDGER_DUPLICATE")
    assert.equal(error.line, 3)
  })

  it("refuses a finish without a start, and a second finish", () => {
    const orphan = replayError(
      eventSequence([runStartedBody(), { kind: "execution.finished", executionId: "exec-1", outcome: "pass" }]),
    )
    assert.equal(orphan.code, "LEDGER_INVALID_EVENT")
    assert.match(orphan.message, /without a start/)

    const twice = replayError(
      eventSequence([
        runStartedBody(),
        { kind: "execution.started", executionId: "exec-1", taskId: "task-1" },
        { kind: "execution.finished", executionId: "exec-1", outcome: "pass" },
        { kind: "execution.finished", executionId: "exec-1", outcome: "pass" },
      ]),
    )
    assert.equal(twice.code, "LEDGER_DUPLICATE")
    assert.match(twice.message, /already finished/)
  })

  it("refuses an attempt before its operation starts, or against the wrong kind", () => {
    const early = replayError(
      eventSequence([
        runStartedBody(),
        { kind: "attempt.recorded", attemptId: "att-1", of: "execution", targetId: "exec-1", reason: "initial" },
      ]),
    )
    assert.equal(early.code, "LEDGER_INVALID_EVENT")
    assert.match(early.message, /not open/)

    const wrongKind = replayError(
      eventSequence([
        runStartedBody(),
        { kind: "execution.started", executionId: "exec-1", taskId: "task-1" },
        { kind: "attempt.recorded", attemptId: "att-1", of: "improvement", targetId: "exec-1", reason: "initial" },
      ]),
    )
    assert.equal(wrongKind.code, "LEDGER_INVALID_EVENT")
    assert.match(wrongKind.message, /open as an execution/)
  })

  it("refuses a duplicated attempt id", () => {
    const error = replayError(
      eventSequence([
        runStartedBody(),
        { kind: "execution.started", executionId: "exec-1", taskId: "task-1" },
        { kind: "attempt.recorded", attemptId: "att-1", of: "execution", targetId: "exec-1", reason: "initial" },
        { kind: "attempt.recorded", attemptId: "att-1", of: "execution", targetId: "exec-1", reason: "retry" },
      ]),
    )
    assert.equal(error.code, "LEDGER_DUPLICATE")
    assert.match(error.message, /recorded twice/)
  })

  it("refuses a summary whose totals disagree with the events", () => {
    const error = replayError(
      eventSequence([
        runStartedBody(),
        { kind: "execution.started", executionId: "exec-1", taskId: "task-1" },
        { kind: "execution.finished", executionId: "exec-1", outcome: "pass" },
        { kind: "run.finished", outcome: "completed", executions: 4, improvements: 0, physicalAttempts: 0 },
      ]),
    )
    assert.equal(error.code, "LEDGER_INVALID_EVENT")
    assert.match(error.message, /totals disagree/)
  })

  it("refuses a completed run that left work open", () => {
    const error = replayError(
      eventSequence([
        runStartedBody(),
        { kind: "execution.started", executionId: "exec-1", taskId: "task-1" },
        { kind: "run.finished", outcome: "completed", executions: 0, improvements: 0, physicalAttempts: 0 },
      ]),
    )
    assert.equal(error.code, "LEDGER_INVALID_EVENT")
    assert.match(error.message, /cannot leave 1 open/)
  })

  it("allows a failed run to leave work open, but nothing after its close", () => {
    const failed = replayLedger(
      eventSequence([
        runStartedBody(),
        { kind: "execution.started", executionId: "exec-1", taskId: "task-1" },
        { kind: "run.finished", outcome: "failed", executions: 0, improvements: 0, physicalAttempts: 0 },
      ]),
    )
    assert.equal(failed.finished, true)
    assert.deepEqual(failed.openExecutions, ["exec-1"])

    const after = replayError(
      eventSequence([
        runStartedBody(),
        { kind: "run.finished", outcome: "halted", executions: 0, improvements: 0, physicalAttempts: 0 },
        { kind: "execution.started", executionId: "exec-1", taskId: "task-1" },
      ]),
    )
    assert.equal(after.code, "LEDGER_INVALID_EVENT")
    assert.match(after.message, /terminal/)
  })

  it("refuses to restart an id that already finished", () => {
    const reusedExecution = replayError(
      eventSequence([
        runStartedBody(),
        { kind: "execution.started", executionId: "exec-1", taskId: "task-1" },
        { kind: "execution.finished", executionId: "exec-1", outcome: "pass" },
        { kind: "execution.started", executionId: "exec-1", taskId: "task-1" },
      ]),
    )
    assert.equal(reusedExecution.code, "LEDGER_DUPLICATE")
    assert.match(reusedExecution.message, /already been used/)

    const reusedImprovement = replayError(
      eventSequence([
        runStartedBody(),
        { kind: "improvement.started", improvementId: "imp-1", stage: "improver" },
        { kind: "improvement.finished", improvementId: "imp-1", outcome: "accepted" },
        { kind: "improvement.started", improvementId: "imp-1", stage: "composer" },
      ]),
    )
    assert.equal(reusedImprovement.code, "LEDGER_DUPLICATE")
  })

  it("enforces the budget declared by run.started, not only the writer's memory", () => {
    const executions: Record<string, unknown>[] = [runStartedBody({ k: 1 })]
    for (let index = 1; index <= 5; index += 1) {
      executions.push({ kind: "execution.started", executionId: `exec-${index}`, taskId: "task-1" })
    }
    const over = replayError(eventSequence(executions))
    assert.equal(over.code, "BUDGET_EXCEEDED")
    assert.equal(over.line, 6)
    assert.match(over.message, /would be 5 of a 4 budget/)

    const improvements: Record<string, unknown>[] = [runStartedBody({ k: 1 })]
    for (let index = 1; index <= 4; index += 1) {
      improvements.push({ kind: "improvement.started", improvementId: `imp-${index}`, stage: "improver" })
    }
    const overImprovements = replayError(eventSequence(improvements))
    assert.equal(overImprovements.code, "BUDGET_EXCEEDED")
    assert.match(overImprovements.message, /would be 4 of a 3 budget/)
  })
})
