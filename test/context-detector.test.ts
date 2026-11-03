import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { ContextError } from "../src/context/errors.ts"
import { assertThresholds, detectContext, SUMMARY_FRAMING_TOKENS } from "../src/context/detector.ts"
import { messageGroups, normalizeMessages, tailBoundary } from "../src/context/messages.ts"
import { createEstimator, DEFAULT_ESTIMATOR, MESSAGE_OVERHEAD_TOKENS } from "../src/context/tokens.ts"

/**
 * T4's measurement half: the numbers the compaction executor will act on.
 *
 * Every assertion here is about the *estimate*, never about provider tokens — there is no tokenizer in this
 * harness, so a test that claimed otherwise would be encoding a guess as evidence.
 */

const HUGE = { tailTokens: 1_000_000, targetTokens: 2_000_000, b1Tokens: 3_000_000, b2Tokens: 4_000_000 }

function message(role: string, content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { role, content, ...extra }
}

function totalOf(messages: readonly unknown[], extra: { systemPrompt?: string } = {}): number {
  return detectContext({ messages, thresholds: HUGE, systemPrompt: extra.systemPrompt }).measurement.total
}

describe("token estimator", () => {
  it("counts bytes, not code units, so non-ASCII text is not flattered", () => {
    const estimator = createEstimator({ bytesPerToken: 3 })
    // 3 bytes per CJK char and 4 per emoji, so the byte/3 ratio lands at 1 and 2 tokens respectively. This
    // asserts the arithmetic only: it is not a claim that the provider agrees with those counts.
    assert.equal(estimator.estimateText("漢".repeat(3)), 3)
    assert.equal(estimator.estimateText("😀"), 2)
    assert.equal(estimator.estimateText("abcd"), 2)
    assert.equal(estimator.estimateText(""), 0)
  })

  it("charges framing per message and per tool on top of the serialized definition", () => {
    const estimator = createEstimator({ bytesPerToken: 1 })
    const raw = message("user", "abc")
    const serialized = estimator.estimateText(JSON.stringify(raw))
    assert.equal(estimator.estimateMessage({ index: 0, role: "user", raw }), serialized + MESSAGE_OVERHEAD_TOKENS)
    assert.equal(estimator.estimateTools([]), 0)
    assert.equal(estimator.estimateTools(undefined), 0)
    const one = estimator.estimateTools([{ name: "read_files" }])
    assert.ok(one > estimator.estimateText(JSON.stringify({ name: "read_files" })) )
  })

  it("refuses a calibration ratio that would silently rescale every threshold", () => {
    for (const ratio of [0.5, 0, -3, 9, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => createEstimator({ bytesPerToken: ratio }),
        (error: unknown) => error instanceof ContextError && error.code === "CONTEXT_ESTIMATOR_INVALID",
      )
    }
  })

  it("identifies itself in the measurement so a record says which approximation produced it", () => {
    const assessment = detectContext({ messages: [message("user", "hi")], thresholds: HUGE })
    assert.equal(assessment.measurement.estimatorId, DEFAULT_ESTIMATOR.id)
    assert.equal(assessment.measurement.kind, "estimate")
  })
})

describe("threshold ladder", () => {
  const messages = [message("user", "task"), message("assistant", "a".repeat(600)), message("user", "next")]
  const total = totalOf(messages)

  function tierAt(limits: { b1: number; b2: number }): string {
    return detectContext({
      messages,
      thresholds: {
        tailTokens: 1,
        targetTokens: Math.min(2, limits.b1 - 1),
        b1Tokens: limits.b1,
        b2Tokens: limits.b2,
      },
    }).tier
  }

  it("stays ok one token below b1 and stubs exactly at it", () => {
    assert.equal(tierAt({ b1: total + 1, b2: total + 2 }), "ok")
    assert.equal(tierAt({ b1: total, b2: total + 1 }), "stub")
  })

  it("compacts exactly at b2 and not one token below", () => {
    assert.equal(tierAt({ b1: total - 1, b2: total + 1 }), "stub")
    assert.equal(tierAt({ b1: total - 1, b2: total }), "compact")
  })

  it("counts the always-on text and tool definitions the builder never sees", () => {
    const withFixed = detectContext({
      messages,
      thresholds: HUGE,
      systemPrompt: "s".repeat(300),
      tools: [{ name: "read_files", description: "read a file" }],
    })
    assert.ok(withFixed.measurement.fixed > 0)
    assert.equal(withFixed.measurement.total, withFixed.measurement.fixed + totalOf(messages))
  })

  it("rejects a hand-built config the schema never saw, and a NaN that defeats comparison guards", () => {
    for (const thresholds of [
      { tailTokens: 10, targetTokens: 10, b1Tokens: 20, b2Tokens: 30 },
      { tailTokens: 1, targetTokens: 2, b1Tokens: 3, b2Tokens: 2 },
      { tailTokens: 1, targetTokens: 2, b1Tokens: Number.NaN, b2Tokens: 30 },
      { tailTokens: 0, targetTokens: 2, b1Tokens: 3, b2Tokens: 30 },
      { tailTokens: 1.5, targetTokens: 2, b1Tokens: 3, b2Tokens: 30 },
    ]) {
      assert.throws(
        () => assertThresholds(thresholds),
        (error: unknown) => error instanceof ContextError && error.code === "CONTEXT_THRESHOLDS_INVALID",
      )
    }
  })
})

describe("message validation", () => {
  const np = "CONTEXT_MESSAGES_INVALID"

  it("accepts a tool-call turn with null content", () => {
    const normalized = normalizeMessages([
      message("assistant", null, { tool_calls: [{ id: "c1", function: { name: "read_files" } }] }),
    ])
    assert.equal(normalized.length, 1)
    assert.equal(normalized[0]?.role, "assistant")
  })

  it("keeps the original object so the tail is verbatim, extensions included", () => {
    const raw = message("assistant", "thinking", { reasoning_content: "why", tool_calls: [] })
    const normalized = normalizeMessages([raw])
    assert.equal(normalized[0]?.raw, raw)
    assert.equal(normalized[0]?.raw.reasoning_content, "why")
  })

  it("refuses what it cannot measure", () => {
    for (const bad of ["not an array", [null], [[1, 2]], [{ role: "developer", content: "x" }], [{ role: "user" }]]) {
      assert.throws(
        () => normalizeMessages(bad),
        (error: unknown) => error instanceof ContextError && error.code === np,
      )
    }
  })

  it("accepts an empty conversation, which a builder can legitimately see on turn zero", () => {
    const assessment = detectContext({ messages: [], thresholds: HUGE })
    assert.equal(assessment.tier, "ok")
    assert.equal(assessment.tailStart, 0)
  })
})

describe("tail boundary", () => {
  const toolTurn = [
    message("user", "task"),
    message("assistant", null, { tool_calls: [{ id: "c1", function: { name: "read_files" } }] }),
    message("tool", "first result", { tool_call_id: "c1" }),
    message("tool", "second result", { tool_call_id: "c1" }),
    message("user", "follow up"),
  ]

  it("keeps a tool request and every result that answers it in one group", () => {
    const groups = messageGroups(normalizeMessages(toolTurn))
    assert.deepEqual(
      groups.map((group) => [group.start, group.end]),
      [[0, 0], [1, 3], [4, 4]],
    )
  })

  it("never splits that group when the budget lands inside it", () => {
    const estimator = createEstimator({ bytesPerToken: 1 })
    const boundary = tailBoundary(normalizeMessages(toolTurn), { tailTokens: 30, estimator })
    // 30 tokens is enough for the final user message and not for the tool group, so the tail starts at the
    // user message rather than halfway through the results.
    assert.equal(boundary.start, 4)
  })

  it("preserves the final group even when it alone exceeds the budget, and says so", () => {
    const estimator = createEstimator({ bytesPerToken: 1 })
    const boundary = tailBoundary(normalizeMessages(toolTurn), { tailTokens: 1, estimator })
    assert.equal(boundary.start, 4)
    const big = [message("user", "task"), message("assistant", "z".repeat(400))]
    const oversize = tailBoundary(normalizeMessages(big), { tailTokens: 10, estimator })
    assert.equal(oversize.start, 1)
    assert.equal(oversize.oversizeGroup, true)
  })

  it("meets the budget from the end instead of crossing it, so the tail cannot overshoot silently", () => {
    const estimator = createEstimator({ bytesPerToken: 1 })
    const messages = [message("user", "a".repeat(200)), message("user", "b".repeat(200)), message("user", "c")]
    const boundary = tailBoundary(normalizeMessages(messages), { tailTokens: 100, estimator })
    // The 200-token message before the last one does not fit inside 100, so only the last message is kept.
    assert.equal(boundary.start, 2)
    assert.ok(boundary.tokens <= 100)
  })

  it("groups a tool result with no request before it alone rather than refusing the array", () => {
    const groups = messageGroups(normalizeMessages([message("tool", "orphan", { tool_call_id: "c9" })]))
    assert.deepEqual(groups, [{ start: 0, end: 0 }])
  })
})

describe("feasibility", () => {
  it("blocks a compaction whose target cannot hold the fixed text plus the preserved tail", () => {
    // One eligible message in the middle, so the refusal is about the budget rather than about having
    // nothing to rewrite.
    const messages = [
      message("user", "task"),
      message("user", "m".repeat(200)),
      message("assistant", "a".repeat(400)),
    ]
    const assessment = detectContext({
      messages,
      systemPrompt: "s".repeat(900),
      thresholds: { tailTokens: 1, targetTokens: 20, b1Tokens: 30, b2Tokens: 40 },
    })
    assert.equal(assessment.tier, "compact")
    assert.deepEqual(assessment.feasibility, { kind: "blocked", reason: "TARGET_UNREACHABLE" })
    assert.match(assessment.reason, /the executor must refuse/)
  })

  it("reports the budget a summary actually has when it fits", () => {
    const messages = [
      message("user", "task"),
      message("user", "m".repeat(100)),
      message("assistant", "a".repeat(400)),
    ]
    const assessment = detectContext({
      messages,
      thresholds: { tailTokens: 1, targetTokens: 10_000, b1Tokens: 10_001, b2Tokens: 10_002 },
    })
    assert.equal(assessment.feasibility.kind, "fits")
    if (assessment.feasibility.kind === "fits") {
      // Everything rewriting cannot touch is subtracted: the task at index 0 survives too, so it belongs in
      // the retained total rather than being forgotten.
      const retained = assessment.measurement.total - assessment.measurement.eligible
      assert.equal(assessment.feasibility.summaryBudget, 10_000 - retained - SUMMARY_FRAMING_TOKENS)
      assert.ok(retained > assessment.measurement.fixed, "the task itself is part of what is retained")
    }
  })

  it("blocks when nothing may be rewritten, and never offers the task itself as a candidate", () => {
    const messages = [message("user", "t".repeat(600)), message("system", "s".repeat(100)), message("user", "last")]
    const assessment = detectContext({
      messages,
      thresholds: { tailTokens: 1_000, targetTokens: 2_000, b1Tokens: 3_000, b2Tokens: 5_000 },
    })
    // The tail budget swallows everything, so there is nothing to rewrite — and saying "fits" here would
    // claim room for a summary that would replace nothing.
    assert.deepEqual(assessment.stubCandidates, [])
    assert.deepEqual(assessment.feasibility, { kind: "blocked", reason: "NOTHING_ELIGIBLE" })

    // With a real queue behind the task: the task (index 0) and the system message (index 1) stay out of
    // the candidate list even though both are outside the tail.
    const queued = [
      message("user", "task"),
      message("system", "s".repeat(50)),
      message("user", "middle"),
      message("user", "last"),
    ]
    const squeezed = detectContext({
      messages: queued,
      thresholds: { tailTokens: 1, targetTokens: 2, b1Tokens: 3, b2Tokens: 4 },
    })
    assert.deepEqual(squeezed.stubCandidates, [2], "index 0 and the system message are never candidates")
    assert.equal(squeezed.tier, "compact")
  })
})

describe("review regressions", () => {
  it("never offers a message whose group is anchored at the task (blocker A)", () => {
    // Index 0 is a tool-request turn, so its group spans [0, 1]. Enumerating positions would offer the tool
    // result for stubbing while the request that produced it stayed preserved.
    const messages = [
      message("assistant", null, { tool_calls: [{ id: "c1", function: { name: "read_files" } }] }),
      message("tool", "result", { tool_call_id: "c1" }),
      message("user", "last"),
    ]
    const assessment = detectContext({
      messages,
      thresholds: { tailTokens: 1, targetTokens: 2, b1Tokens: 3, b2Tokens: 4 },
    })
    assert.deepEqual(assessment.stubCandidates, [])
    assert.deepEqual(assessment.feasibility, { kind: "blocked", reason: "NOTHING_ELIGIBLE" })
  })

  it("subtracts the retained task before claiming a target is reachable (blocker B)", () => {
    // The task alone exceeds the target, so no summary budget can meet it however small the summary is.
    const messages = [
      message("user", "t".repeat(1_200)),
      message("user", "m".repeat(40)),
      message("assistant", "a".repeat(40)),
    ]
    const assessment = detectContext({
      messages,
      thresholds: { tailTokens: 1, targetTokens: 200, b1Tokens: 300, b2Tokens: 400 },
    })
    assert.equal(assessment.tier, "compact")
    assert.ok(assessment.measurement.eligible > 0, "there is something to rewrite")
    assert.deepEqual(assessment.feasibility, { kind: "blocked", reason: "TARGET_UNREACHABLE" })
  })

  it("falls back to positional pairing when only some calls carry ids (blocker C)", () => {
    const messages = [
      message("user", "task"),
      message("assistant", null, {
        tool_calls: [{ id: "c1", function: { name: "read_files" } }, { function: { name: "write" } }],
      }),
      message("tool", "first", { tool_call_id: "c1" }),
      message("tool", "second", { tool_call_id: "c2" }),
      message("user", "last"),
    ]
    // A partial id set cannot prove which result answers which call, so the run stays together rather than
    // splitting a request from its answer.
    assert.deepEqual(
      messageGroups(normalizeMessages(messages)).map((group) => [group.start, group.end]),
      [[0, 0], [1, 3], [4, 4]],
    )
  })

  it("refuses an unserializable payload instead of measuring it as tiny (blocker D)", () => {
    const cyclic: Record<string, unknown> = { role: "user", content: "x".repeat(600_000) }
    cyclic.self = cyclic
    assert.throws(
      () => detectContext({ messages: [cyclic], thresholds: HUGE }),
      (error: unknown) => error instanceof ContextError && error.code === "CONTEXT_MEASURE_INVALID",
    )
  })

  it("treats a tool object without serialized bytes as framing only rather than as a failure", () => {
    const assessment = detectContext({
      messages: [message("user", "hi")],
      thresholds: HUGE,
      tools: [{ name: "read_files" }, undefined],
    })
    assert.ok(assessment.measurement.fixed > 0)
  })
})
