import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { LEDGER_EVENT_VERSION, ledgerEventSchema } from "../src/ledger/events.ts"
import { AT, SHA_A, eventAt, runStartedBody } from "./support/ledger-fixtures.ts"

/**
 * The event contract itself.
 *
 * Every event is the unit of evidence a later chunk reads back, so the schema has to be strict enough
 * that a field this build does not understand cannot hide inside a record it produced.
 */

const ALL_BODIES: readonly Record<string, unknown>[] = [
  runStartedBody(),
  { kind: "execution.started", executionId: "exec-1", taskId: "task-1" },
  { kind: "execution.finished", executionId: "exec-1", outcome: "pass" },
  { kind: "improvement.started", improvementId: "imp-1", stage: "improver" },
  { kind: "improvement.finished", improvementId: "imp-1", outcome: "accepted" },
  { kind: "attempt.recorded", attemptId: "att-1", of: "execution", targetId: "exec-1", reason: "initial" },
  { kind: "run.finished", outcome: "completed", executions: 1, improvements: 0, physicalAttempts: 0 },
]

describe("ledger events", () => {
  it("round-trips every event kind", () => {
    for (const [index, body] of ALL_BODIES.entries()) {
      const parsed = eventAt(index + 1, body)
      assert.equal(parsed.kind, body["kind"])
      assert.equal(parsed.seq, index + 1)
      assert.equal(parsed.version, LEDGER_EVENT_VERSION)
      assert.deepEqual(ledgerEventSchema.parse(parsed), parsed)
    }
  })

  it("rejects an unknown field instead of dropping it", () => {
    const result = ledgerEventSchema.safeParse({
      ...eventAt(1, runStartedBody()),
      surprise: true,
    })
    assert.equal(result.success, false)
  })

  it("rejects an unknown kind and an unknown enum value", () => {
    assert.equal(ledgerEventSchema.safeParse({ ...eventAt(1, runStartedBody()), kind: "run.paused" }).success, false)
    assert.equal(
      ledgerEventSchema.safeParse({
        kind: "execution.finished",
        executionId: "e",
        outcome: "maybe",
        version: LEDGER_EVENT_VERSION,
        seq: 1,
        at: AT,
      }).success,
      false,
    )
  })

  it("rejects a seq that is not a positive integer", () => {
    for (const seq of [0, -1, 1.5]) {
      const result = ledgerEventSchema.safeParse({ ...runStartedBody(), version: 1, seq, at: AT })
      assert.equal(result.success, false, `seq ${String(seq)} was accepted`)
    }
  })

  it("rejects an instant without milliseconds or without a zone", () => {
    for (const at of ["2026-11-02T00:00:00Z", "2026-11-02T00:00:00.000+00:00", "now"]) {
      const result = ledgerEventSchema.safeParse({
        ...runStartedBody(),
        version: LEDGER_EVENT_VERSION,
        seq: 1,
        at,
      })
      assert.equal(result.success, false, `${at} was accepted`)
    }
  })

  it("rejects a version it does not know", () => {
    const result = ledgerEventSchema.safeParse({ ...runStartedBody(), version: 2, seq: 1, at: AT })
    assert.equal(result.success, false)
  })

  it("bounds identifiers to something safe to put in a log line", () => {
    for (const runId of ["", "run\n1", "-run", "run 1", "r".repeat(129)]) {
      const result = ledgerEventSchema.safeParse({
        ...runStartedBody({ runId }),
        version: LEDGER_EVENT_VERSION,
        seq: 1,
        at: AT,
      })
      assert.equal(result.success, false, `${JSON.stringify(runId)} was accepted`)
    }
  })

  it("requires real hashes and a non-empty policy entry", () => {
    assert.equal(ledgerEventSchema.safeParse({ ...runStartedBody({ baselineSha: "abc" }), version: 1, seq: 1, at: AT }).success, false)
    assert.equal(ledgerEventSchema.safeParse({ ...runStartedBody({ toolPolicySet: [""] }), version: 1, seq: 1, at: AT }).success, false)
    // An empty policy set is a real state: a tree with no tools and no policy.
    assert.equal(ledgerEventSchema.safeParse({ ...runStartedBody({ toolPolicySet: [] }), version: 1, seq: 1, at: AT }).success, true)
  })

  it("distinguishes a null probe digest from a missing one", () => {
    const nullProbe = ledgerEventSchema.parse({ ...runStartedBody({ probeSha: null }), version: 1, seq: 1, at: AT })
    assert.equal(nullProbe.kind === "run.started" ? nullProbe.probeSha : "unset", null)
    const { probeSha: _omitted, ...withoutProbe } = runStartedBody()
    assert.equal(ledgerEventSchema.safeParse({ ...withoutProbe, version: 1, seq: 1, at: AT }).success, false)
  })

  it("keeps attempt reasons explicit", () => {
    const reasons = ["initial", "retry", "schema-repair", "oracle-substitution"]
    for (const reason of reasons) {
      const parsed = eventAt(1, { kind: "attempt.recorded", attemptId: "a", of: "execution", targetId: "e", reason })
      assert.equal(parsed.kind, "attempt.recorded")
    }
    assert.equal(
      ledgerEventSchema.safeParse({
        kind: "attempt.recorded",
        attemptId: "a",
        of: "execution",
        targetId: "e",
        reason: "because",
        version: 1,
        seq: 1,
        at: AT,
      }).success,
      false,
    )
  })

  it("accepts the exact hash shape the rest of the domain uses", () => {
    const parsed = ledgerEventSchema.parse({ ...runStartedBody(), version: 1, seq: 1, at: AT })
    assert.equal(parsed.kind === "run.started" ? parsed.baselineSha : "", SHA_A)
  })
})
