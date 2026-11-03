import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { callKeyOf, recordingHooks } from "../src/policy/hooks.ts"
import type { ToolPolicy } from "../src/policy/policy.ts"

const ALLOW_RUN: ToolPolicy = { allow: ["run_commands"], deny: [] }
const DENY_RUN: ToolPolicy = { allow: [], deny: ["run_commands"] }

type Gate = (context: unknown) => unknown

function hooksFor(policy: ToolPolicy | undefined) {
  const recorder = recordingHooks({ policy })
  const hooks = recorder.hooks as Record<string, Gate>
  return { recorder, hooks }
}

describe("the hook recorder", () => {
  it("counts each phase once per call", () => {
    const { recorder, hooks } = hooksFor(ALLOW_RUN)
    hooks["beforeRun"]?.({})
    hooks["beforeTool"]?.({ toolCall: { id: "c1", name: "run_commands" } })
    hooks["afterTool"]?.({ toolCall: { id: "c1", name: "run_commands" } })
    hooks["afterRun"]?.({})
    hooks["onEvent"]?.({ type: "message" })
    hooks["onEvent"]?.({ type: "turn_start" })

    assert.deepEqual(recorder.summary(), {
      beforeRun: 1,
      afterRun: 1,
      beforeTool: 1,
      afterTool: 1,
      events: 2,
      afterToolOnSkipped: 0,
    })
  })

  it("passes the gate's refusal through unchanged", () => {
    const { hooks } = hooksFor(DENY_RUN)
    const verdict = hooks["beforeTool"]?.({ toolCall: { id: "c1", name: "run_commands" } }) as {
      skip: boolean
      appendContext: string
    }
    assert.equal(verdict.skip, true)
    assert.match(verdict.appendContext, /run_commands refused \(denied\)/)
  })

  it("lets an allowed call through as undefined, not as an object", () => {
    const { hooks } = hooksFor(ALLOW_RUN)
    assert.equal(hooks["beforeTool"]?.({ toolCall: { id: "c1", name: "run_commands" } }), undefined)
  })

  it("counts afterTool on a skipped call instead of implying the tool ran", () => {
    const { recorder, hooks } = hooksFor(DENY_RUN)
    hooks["beforeTool"]?.({ toolCall: { id: "c1", name: "run_commands" } })
    // B5 recorded exactly this: afterTool fires even though the call was refused.
    hooks["afterTool"]?.({ toolCall: { id: "c1", name: "run_commands" } })
    const summary = recorder.summary()
    assert.equal(summary.afterTool, 1)
    assert.equal(summary.afterToolOnSkipped, 1)
  })

  it("pairs calls by identity, not by tool name", () => {
    const { recorder, hooks } = hooksFor(DENY_RUN)
    hooks["beforeTool"]?.({ toolCall: { id: "denied", name: "run_commands" } })
    hooks["afterTool"]?.({ toolCall: { id: "other", name: "run_commands" } })
    // A name-only key would have called this a skipped call and invented a lie the runtime never told.
    assert.equal(recorder.summary().afterToolOnSkipped, 0)

    hooks["afterTool"]?.({ toolCall: { id: "denied", name: "run_commands" } })
    assert.equal(recorder.summary().afterToolOnSkipped, 1)
  })

  it("reads the id field the SDK actually supplies", () => {
    // `@cline/sdk` 0.2.0 puts the id on `toolCall.toolCallId`.
    const { recorder, hooks } = hooksFor(DENY_RUN)
    hooks["beforeTool"]?.({ toolCall: { toolCallId: "a", name: "run_commands" } })
    hooks["afterTool"]?.({ toolCall: { toolCallId: "b", name: "run_commands" } })
    assert.equal(recorder.summary().afterToolOnSkipped, 0)
    hooks["afterTool"]?.({ toolCall: { toolCallId: "a", name: "run_commands" } })
    assert.equal(recorder.summary().afterToolOnSkipped, 1)
  })

  it("consumes a skipped key, so a repeated afterTool is not counted twice", () => {
    const { recorder, hooks } = hooksFor(DENY_RUN)
    hooks["beforeTool"]?.({ toolCall: { id: "same", name: "run_commands" } })
    hooks["afterTool"]?.({ toolCall: { id: "same", name: "run_commands" } })
    // The runtime is documented to fire afterTool more than once for one call; one refusal is one lie.
    hooks["afterTool"]?.({ toolCall: { id: "same", name: "run_commands" } })
    assert.equal(recorder.summary().afterToolOnSkipped, 1)
  })

  it("falls back to a positional key when the runtime supplies no id", () => {
    assert.equal(callKeyOf({ toolCall: { id: "abc", name: "x" } }, 1), "id:abc")
    assert.equal(callKeyOf({ toolCall: { name: "x" } }, 1), "name:x")
    assert.equal(callKeyOf({}, 7), "#7")
    assert.equal(callKeyOf(null, 3), "#3")
  })

  it("denies every named tool when no policy is installed", () => {
    const { recorder, hooks } = hooksFor(undefined)
    const verdict = hooks["beforeTool"]?.({ toolCall: { name: "run_commands" } }) as { skip: boolean }
    assert.equal(verdict.skip, true)
    assert.equal(recorder.summary().afterToolOnSkipped, 0)
  })
})
