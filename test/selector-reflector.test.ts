import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { isUsableLesson } from "../src/domain/schemas.ts"
import { parseReflection, reflect } from "../src/improve/reflector.ts"
import { selectCandidate, type Candidate } from "../src/improve/selector.ts"
import { oracleRoles } from "../src/oracle/client.ts"
import { geminiAnswer, geminiClient, scripted } from "./support/oracle-fixtures.ts"

/**
 * Selector and Reflector.
 *
 * The gate is "unequal probes are refused", and the interesting assertions are the refusals: a confounded
 * comparison must not produce a choice, and a reflection missing its evidence or its confidence reason must
 * not produce a lesson.
 */

const FINGERPRINT = "a".repeat(64)
const OTHER = "b".repeat(64)

function candidate(id: string, fingerprintSha256 = FINGERPRINT): Candidate {
  return { id, fingerprintSha256, probe: `candidate ${id} passed 3 of 4 checks\n` }
}

const BASELINE = { id: "e0", fingerprintSha256: FINGERPRINT }

describe("selectCandidate", () => {
  it("records the candidate the oracle chose", async () => {
    const script = scripted([geminiAnswer("CHOICE: candidate-2\nWHY: fewer failures\n")])
    const result = await selectCandidate({
      selector: oracleRoles(geminiClient(script)).selector,
      baseline: BASELINE,
      candidates: [candidate("candidate-1"), candidate("candidate-2")],
    })

    assert.equal(result.status, "selected")
    if (result.status !== "selected") return
    assert.equal(result.candidateId, "candidate-2")

    const prompt = script.requests[0]?.stdin ?? ""
    assert.ok(prompt.includes("candidates/candidate-1/probe.md"), "every probe must be in the context")
    assert.ok(prompt.includes(FINGERPRINT), "the oracle is told the digest it must not see differ")
  })

  it("refuses unequal probes before spending a call", async () => {
    const script = scripted([])
    const result = await selectCandidate({
      selector: oracleRoles(geminiClient(script)).selector,
      baseline: BASELINE,
      candidates: [candidate("candidate-1"), candidate("candidate-2", OTHER)],
    })

    assert.equal(result.status, "refused")
    if (result.status !== "refused") return
    assert.equal(result.code, "SELECTION_UNMATCHED")
    assert.match(result.reason, /candidate-2/)
    assert.equal(script.requests.length, 0, "a confounded comparison must not cost a call")
  })

  it("refuses a choice that is not one of the candidates, and a reply with no choice", async () => {
    const unknown = scripted([geminiAnswer("CHOICE: candidate-9")])
    const first = await selectCandidate({
      selector: oracleRoles(geminiClient(unknown)).selector,
      baseline: BASELINE,
      candidates: [candidate("candidate-1")],
    })
    assert.equal(first.status, "refused")
    if (first.status !== "refused") return
    assert.equal(first.code, "SELECTION_UNKNOWN_CANDIDATE")

    const silent = scripted([geminiAnswer("Both look fine to me.")])
    const second = await selectCandidate({
      selector: oracleRoles(geminiClient(silent)).selector,
      baseline: BASELINE,
      candidates: [candidate("candidate-1")],
    })
    assert.equal(second.status, "refused")
    if (second.status !== "refused") return
    assert.equal(second.code, "SELECTION_UNPARSEABLE")
  })

  it("refuses two candidates under one id, and an empty field", async () => {
    const script = scripted([])
    const duplicate = await selectCandidate({
      selector: oracleRoles(geminiClient(script)).selector,
      baseline: BASELINE,
      candidates: [candidate("candidate-1"), candidate("candidate-1")],
    })
    assert.equal(duplicate.status, "refused")

    const empty = await selectCandidate({
      selector: oracleRoles(geminiClient(script)).selector,
      baseline: BASELINE,
      candidates: [],
    })
    assert.equal(empty.status, "refused")
    assert.equal(script.requests.length, 0)
  })
})

const LESSON_TEXT = [
  "CUE: a task whose harness states a rule without naming the file it applies to",
  "LESSON: move the rule into rules/<topic>.md so the agent can cite it",
  "EVIDENCE: attempt-3 and attempt-4 both failed to cite a rule that lived only in core.md",
  "CONFIDENCE: high — two independent failures under the same fingerprint",
].join("\n")

describe("reflect", () => {
  it("parses a complete reflection into a usable lesson", async () => {
    const script = scripted([geminiAnswer(LESSON_TEXT)])
    const result = await reflect({
      reflector: oracleRoles(geminiClient(script)).reflector,
      failures: [{ path: "evidence/attempt-3.md", body: "the run did not cite the rule\n" }],
    })

    assert.equal(result.status, "reflected")
    if (result.status !== "reflected") return
    assert.equal(result.lesson.confidence.level, "high")
    assert.match(result.lesson.confidence.why, /two independent failures/)
    assert.ok(isUsableLesson(result.lesson))
    assert.ok((script.requests[0]?.stdin ?? "").includes("did not cite the rule"))
  })

  it("refuses a reply with no lesson lines, and one that is merely incomplete", async () => {
    const prose = scripted([geminiAnswer("The harness needs to be clearer.")])
    const first = await reflect({
      reflector: oracleRoles(geminiClient(prose)).reflector,
      failures: [{ path: "evidence/1.md", body: "failed" }],
    })
    assert.equal(first.status, "refused")
    if (first.status !== "refused") return
    assert.equal(first.code, "REFLECTION_UNPARSEABLE")

    const partial = scripted([geminiAnswer("CUE: a situation\nLESSON: do the thing")])
    const second = await reflect({
      reflector: oracleRoles(geminiClient(partial)).reflector,
      failures: [{ path: "evidence/1.md", body: "failed" }],
    })
    assert.equal(second.status, "refused")
    if (second.status !== "refused") return
    assert.equal(second.code, "REFLECTION_INCOMPLETE")
    assert.match(second.reason, /EVIDENCE, CONFIDENCE/)
  })

  it("refuses a confidence with no reason behind it", () => {
    const parsed = parseReflection(LESSON_TEXT.replace(/CONFIDENCE: .*/, "CONFIDENCE: high"))
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    assert.match(parsed.reason, /carry its reason/)
  })

  it("refuses an empty label instead of letting it swallow the next line", () => {
    const hollow = parseReflection(LESSON_TEXT.replace(/CUE: .*/, "CUE:   "))
    assert.equal(hollow.ok, false)
    if (hollow.ok) return
    assert.match(hollow.reason, /missing CUE/)

    const doubled = parseReflection(`CUE: one\nCUE: two\n${LESSON_TEXT.split("\n").slice(1).join("\n")}`)
    assert.equal(doubled.ok, false)
    if (doubled.ok) return
    assert.match(doubled.reason, /CUE more than once/)
  })

  it("refuses to reflect on nothing", async () => {
    const script = scripted([])
    const result = await reflect({ reflector: oracleRoles(geminiClient(script)).reflector, failures: [] })
    assert.equal(result.status, "refused")
    if (result.status !== "refused") return
    assert.equal(result.code, "REFLECTION_INCOMPLETE")
    assert.equal(script.requests.length, 0, "no evidence, no call")
  })
})

describe("review regressions", () => {
  it("refuses a baseline fingerprint that is not a digest, so two blanks cannot match", async () => {
    const script = scripted([])
    const result = await selectCandidate({
      selector: oracleRoles(geminiClient(script)).selector,
      baseline: { id: "e0", fingerprintSha256: "" },
      candidates: [{ id: "candidate-1", fingerprintSha256: "", probe: "unmeasured\n" }],
    })
    assert.equal(result.status, "refused")
    if (result.status !== "refused") return
    assert.equal(result.code, "SELECTION_UNMATCHED")
    assert.equal(script.requests.length, 0)
  })

  it("refuses a reply that names more than one candidate", async () => {
    const script = scripted([geminiAnswer("CHOICE: candidate-1\nActually:\nCHOICE: candidate-2")])
    const result = await selectCandidate({
      selector: oracleRoles(geminiClient(script)).selector,
      baseline: BASELINE,
      candidates: [candidate("candidate-1"), candidate("candidate-2")],
    })
    assert.equal(result.status, "refused")
    if (result.status !== "refused") return
    assert.equal(result.code, "SELECTION_UNPARSEABLE")
    assert.match(result.reason, /2 choices/)
  })
})
