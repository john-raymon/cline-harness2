import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  budgetOf,
  mayStartExecution,
  mayStartImprovement,
  remaining,
  stopDecision,
} from "../src/run/budget.ts"

/**
 * The budget.
 *
 * The gate is "run stops exactly on budget", so the interesting assertions are the boundary ones: the
 * last permitted step is allowed, the next is refused, and the stop reason names the counter that ran out.
 * Off-by-one is the whole risk here.
 */

describe("budgetOf", () => {
  it("derives 4k and 3k from the single source of truth", () => {
    assert.deepEqual(budgetOf({ k: 1, executions: 0, improvements: 0 }), {
      k: 1,
      maxExecutions: 4,
      maxImprovements: 3,
      executions: 0,
      improvements: 0,
      openExecutions: 0,
      openImprovements: 0,
    })
    assert.equal(budgetOf({ k: 3, executions: 0, improvements: 0 }).maxExecutions, 12)
    assert.equal(budgetOf({ k: 3, executions: 0, improvements: 0 }).maxImprovements, 9)
  })
})

describe("allowances", () => {
  it("allows the last step and refuses the next one, exactly", () => {
    for (let used = 0; used < 4; used += 1) {
      assert.equal(
        mayStartExecution(budgetOf({ k: 1, executions: used, improvements: 0 })).ok,
        true,
        `execution ${used + 1} of 4 must be allowed`,
      )
    }
    const refused = mayStartExecution(budgetOf({ k: 1, executions: 4, improvements: 0 }))
    assert.equal(refused.ok, false)
    if (refused.ok) return
    assert.equal(refused.reason, "executions-exhausted")
    assert.equal(refused.used, 4)
    assert.equal(refused.limit, 4)
  })

  it("counts improvements separately from executions", () => {
    const spent = budgetOf({ k: 1, executions: 4, improvements: 2 })
    assert.equal(mayStartImprovement(spent).ok, true, "a full execution budget does not touch improvements")
    const refused = mayStartImprovement(budgetOf({ k: 1, executions: 0, improvements: 3 }))
    assert.equal(refused.ok, false)
    if (refused.ok) return
    assert.equal(refused.reason, "improvements-exhausted")
  })

  it("never reports negative headroom", () => {
    assert.deepEqual(remaining(budgetOf({ k: 1, executions: 9, improvements: 9 })), {
      executions: 0,
      improvements: 0,
    })
  })
})

describe("stopDecision", () => {
  it("stops a completed run exactly when the execution budget is spent", () => {
    const before = stopDecision({ budget: budgetOf({ k: 1, executions: 3, improvements: 0 }) })
    assert.equal(before.stop, false)

    const at = stopDecision({ budget: budgetOf({ k: 1, executions: 4, improvements: 0 }) })
    assert.equal(at.stop, true)
    if (!at.stop) return
    assert.equal(at.outcome, "completed", "spending the budget is finishing, not giving up")
    assert.equal(at.reason, "executions-exhausted")
    assert.match(at.detail, /4 of 4 executions used/)
  })

  it("stops on improvements, and calls a learned-nothing cycle halted", () => {
    const exhausted = stopDecision({ budget: budgetOf({ k: 2, executions: 1, improvements: 6 }) })
    assert.equal(exhausted.stop, true)
    if (!exhausted.stop) return
    assert.equal(exhausted.reason, "improvements-exhausted")

    const barren = stopDecision({
      budget: budgetOf({ k: 1, executions: 1, improvements: 1 }),
      lastImprovementAccepted: false,
    })
    assert.equal(barren.stop, true)
    if (!barren.stop) return
    assert.equal(barren.outcome, "halted")
    assert.equal(barren.reason, "no-improvement")
  })

  it("lets a run with budget left and a productive cycle continue", () => {
    const go = stopDecision({
      budget: budgetOf({ k: 1, executions: 1, improvements: 1 }),
      lastImprovementAccepted: true,
    })
    assert.equal(go.stop, false)
  })

  it("reports a failure before it reports a budget", () => {
    const failed = stopDecision({
      budget: budgetOf({ k: 1, executions: 4, improvements: 3 }),
      error: "provider returned 502",
    })
    assert.equal(failed.stop, true)
    if (!failed.stop) return
    assert.equal(failed.outcome, "failed")
    assert.equal(failed.reason, "error")
    assert.match(failed.detail, /502/)
  })
})

describe("review regressions", () => {
  it("counts in-flight operations, so the allowance matches the ledger", () => {
    const inFlight = budgetOf({ k: 1, executions: 3, improvements: 0, openExecutions: 1 })
    const allowance = mayStartExecution(inFlight)
    assert.equal(
      allowance.ok,
      false,
      "3 finished + 1 open fills a 4-execution budget; the ledger would refuse the next start",
    )
    if (allowance.ok) return
    assert.equal(allowance.used, 4)
  })

  it("does not claim completion while an operation is still open", () => {
    const executionOpen = stopDecision({
      budget: budgetOf({ k: 1, executions: 4, improvements: 3, openExecutions: 1 }),
    })
    assert.equal(executionOpen.stop, false, "run.finished would refuse a completed run with work open")

    const improvementOpen = stopDecision({
      budget: budgetOf({ k: 1, executions: 0, improvements: 3, openImprovements: 1 }),
    })
    assert.equal(improvementOpen.stop, false)

    const closed = stopDecision({ budget: budgetOf({ k: 1, executions: 4, improvements: 3 }) })
    assert.equal(closed.stop, true)
  })

  it("reports an empty error message rather than swallowing it", () => {
    const failed = stopDecision({ budget: budgetOf({ k: 1, executions: 0, improvements: 0 }), error: "  " })
    assert.equal(failed.stop, true)
    if (!failed.stop) return
    assert.equal(failed.outcome, "failed")
    assert.equal(failed.detail, "unknown failure")
  })
})
