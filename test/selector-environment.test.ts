import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { environmentMismatches, type ProbeEnvironment } from "../src/fingerprint/probe.ts"
import { DEFAULT_SELECTOR_ASK, readChoice, selectCandidate } from "../src/improve/selector.ts"
import { oracleRoles } from "../src/oracle/client.ts"
import { geminiAnswer, geminiClient, scripted } from "./support/oracle-fixtures.ts"

/**
 * The matched-environment gate.
 *
 * Chunk 17 gated on the whole fingerprint digest, which refused every real candidate: a candidate exists to
 * change the harness, and `treeSha`/`compiledPromptHash`/`baselineSha` all move when it does. The gate now
 * compares the invariant projection and lets the harness fields move. These tests pin both halves — the
 * environment mismatch that must still refuse, and the harness change that must now be allowed.
 */

const ENV: ProbeEnvironment = {
  baseSha: "a".repeat(40),
  dependencyLockHash: "c".repeat(64),
  ssotRulesHash: "d".repeat(64),
  providerId: "openai-compatible",
  modelId: "spike-model",
  baseUrl: "https://example.invalid/v1",
  reasoningEffort: "none",
  thinking: false,
  toolPolicySet: ["default:deny"],
  toolInventoryHash: "e".repeat(64),
  t4Policy: "t4/v1:tail=24000;target=105000;b1=120000;b2=160000",
}

const BASELINE_DIGEST = "1".repeat(64)
const CANDIDATE_DIGEST = "2".repeat(64)

describe("selectCandidate environment gate", () => {
  it("selects a candidate whose harness changed even though its digest differs", async () => {
    const script = scripted([geminiAnswer("CHOICE: candidate-b")])
    const result = await selectCandidate({
      selector: oracleRoles(geminiClient(script)).selector,
      baseline: { id: "candidate-a", fingerprintSha256: BASELINE_DIGEST, environment: ENV },
      candidates: [
        {
          id: "candidate-b",
          fingerprintSha256: CANDIDATE_DIGEST,
          probe: "the improved harness",
          environment: ENV,
        },
      ],
    })

    assert.equal(result.status, "selected")
    assert.equal(script.requests.length, 1, "the oracle was asked, because the environments agree")
    assert.match(
      JSON.stringify(script.requests[0]),
      /environment\.json/,
      "the oracle is told the environment it is meant to be checking, not just the digests",
    )
    assert.doesNotMatch(
      DEFAULT_SELECTOR_ASK,
      /if any digest differs, refuse/i,
      "an instruction to refuse on differing digests would refuse every candidate worth comparing",
    )
  })

  it("refuses when the model changed, naming the field, without paying for a call", async () => {
    const script = scripted([geminiAnswer("CHOICE: candidate-b")])
    const result = await selectCandidate({
      selector: oracleRoles(geminiClient(script)).selector,
      baseline: { id: "candidate-a", fingerprintSha256: BASELINE_DIGEST, environment: ENV },
      candidates: [
        {
          id: "candidate-b",
          fingerprintSha256: CANDIDATE_DIGEST,
          probe: "a different model, so not comparable",
          environment: { ...ENV, modelId: "some-other-model" },
        },
      ],
    })

    assert.equal(result.status, "refused")
    if (result.status !== "refused") return
    assert.equal(result.code, "SELECTION_UNMATCHED")
    assert.match(result.reason, /modelId/)
    assert.equal(script.requests.length, 0, "a confounded contrast is refused before the oracle is asked")
  })

  it("still refuses on the digest when a probe carries no environment", async () => {
    const script = scripted([geminiAnswer("CHOICE: candidate-b")])
    const result = await selectCandidate({
      selector: oracleRoles(geminiClient(script)).selector,
      baseline: { id: "candidate-a", fingerprintSha256: BASELINE_DIGEST },
      candidates: [{ id: "candidate-b", fingerprintSha256: CANDIDATE_DIGEST, probe: "unlabelled" }],
    })

    assert.equal(result.status, "refused")
    if (result.status !== "refused") return
    assert.equal(result.code, "SELECTION_UNMATCHED")
    assert.equal(script.requests.length, 0)
  })

  it("names every invariant field that moved, in a stable order", () => {
    assert.deepEqual(environmentMismatches(ENV, ENV), [])
    assert.deepEqual(
      environmentMismatches(ENV, { ...ENV, providerId: "openai", baseUrl: "https://other.invalid/v1" }),
      ["providerId", "baseUrl"],
    )
    assert.deepEqual(environmentMismatches(ENV, { ...ENV, toolPolicySet: ["default:allow"] }), [
      "toolPolicySet",
    ])
  })
})

/**
 * Reading the `CHOICE:` line a model actually writes.
 *
 * A live run refused all six selections. Two separate defects: the model answered with the only identifier it
 * could see (`candidates/exec-2`, because that is how the context labels each probe) and the gate accepted
 * only the bare id; and a legitimate `NONE`/`REFUSED` was recorded as `SELECTION_UNKNOWN_CANDIDATE`, the same
 * code as an invented id, so a refusal and a hallucination were indistinguishable. Both are pinned here.
 */

const IDS = new Set(["exec-1", "exec-2"])

async function compare(reply: string) {
  const script = scripted([geminiAnswer(reply)])
  const outcome = await selectCandidate({
    selector: oracleRoles(geminiClient(script)).selector,
    baseline: { id: "exec-1", fingerprintSha256: BASELINE_DIGEST, environment: ENV },
    candidates: [
      {
        id: "exec-1",
        fingerprintSha256: BASELINE_DIGEST,
        probe: "the harness that was already measured",
        environment: ENV,
      },
      {
        id: "exec-2",
        fingerprintSha256: CANDIDATE_DIGEST,
        probe: "the improved harness",
        environment: ENV,
      },
    ],
  })
  return { outcome, script }
}

describe("selectCandidate reads the choice the model actually wrote", () => {
  it("resolves the context path the model is shown, not just the bare id", async () => {
    const { outcome } = await compare("CHOICE: candidates/exec-2")
    assert.equal(outcome.status, "selected")
    if (outcome.status !== "selected") return
    assert.equal(outcome.candidateId, "exec-2")
  })

  it("resolves a deeper path, a backticked id and a quoted id to the same candidate", async () => {
    for (const reply of [
      "CHOICE: candidates/exec-2/probe.md",
      "CHOICE: `exec-2`",
      'CHOICE: "exec-2"',
      "CHOICE: exec-2.",
    ]) {
      const { outcome } = await compare(reply)
      assert.equal(outcome.status, "selected", `${reply} should select exec-2`)
      if (outcome.status !== "selected") continue
      assert.equal(outcome.candidateId, "exec-2")
    }
  })

  it("still selects the incumbent, so a revert stays expressible", async () => {
    const { outcome } = await compare("CHOICE: candidates/exec-1")
    assert.equal(outcome.status, "selected")
    if (outcome.status !== "selected") return
    assert.equal(outcome.candidateId, "exec-1")
  })

  it("records an explicit decline as a decline, not as an unknown candidate", async () => {
    for (const reply of [
      "CHOICE: NONE",
      "CHOICE: REFUSED",
      "CHOICE: none",
      "CHOICE: REFUSE: the probes are not comparable",
    ]) {
      const { outcome } = await compare(reply)
      assert.equal(outcome.status, "refused", `${reply} should be refused`)
      if (outcome.status !== "refused") continue
      assert.equal(outcome.code, "SELECTION_MODEL_DECLINED", `${reply} is a decision, not a typo`)
    }
  })

  it("keeps an invented id distinct from a decline", async () => {
    const { outcome } = await compare("CHOICE: candidates/exec-9")
    assert.equal(outcome.status, "refused")
    if (outcome.status !== "refused") return
    assert.equal(outcome.code, "SELECTION_UNKNOWN_CANDIDATE")
  })

  it("tells the oracle the bare ids it will be graded on", async () => {
    const { script } = await compare("CHOICE: exec-2")
    const sent = JSON.stringify(script.requests[0])
    assert.match(sent, /candidates\/ids\.txt/, "the ids are supplied as context, not only as prose")
    assert.match(sent, /exec-2/, "the accepted token is visible in the request")
    assert.match(sent, /not a path such as/, "the ask says which shape it wants back")
  })
})

describe("readChoice", () => {
  it("normalises every shape a model uses into the bare id", () => {
    for (const raw of [
      "exec-2",
      "`exec-2`",
      "candidates/exec-2",
      "candidates/exec-2/probe.md",
      "./candidates/exec-2/probe.md",
      "exec-2.",
    ]) {
      assert.deepEqual(readChoice(raw, IDS), { kind: "candidate", id: "exec-2" }, raw)
    }
  })

  it("does not invent a candidate out of a path that names nobody", () => {
    assert.deepEqual(readChoice("candidates/exec-9", IDS), { kind: "unknown" })
    assert.deepEqual(readChoice("something-else", IDS), { kind: "unknown" })
    assert.deepEqual(readChoice("", IDS), { kind: "unknown" })
  })

  it("never turns a rejection into a selection", () => {
    // A segment scan would read `not candidates/exec-2` as a vote *for* exec-2, which is the opposite of
    // what the model said. An unreadable reply is the honest outcome.
    for (const raw of [
      "not candidates/exec-2",
      "neither candidates/exec-1 nor candidates/exec-2",
      "I decline candidates/exec-2",
    ]) {
      assert.deepEqual(readChoice(raw, IDS), { kind: "unknown" }, raw)
    }
  })

  it("leaves an id that starts with a wrapper character intact", () => {
    const underscoreIds = new Set(["_exec-2", "*exec-3"])
    assert.deepEqual(readChoice("_exec-2", underscoreIds), { kind: "candidate", id: "_exec-2" })
    assert.deepEqual(readChoice("*exec-3", underscoreIds), { kind: "candidate", id: "*exec-3" })
  })

  it("reads a decline and the reason attached to it", () => {
    for (const raw of ["NONE", "none", "REFUSED", "REFUSE: the probes differ"]) {
      assert.deepEqual(readChoice(raw, IDS), { kind: "declined" }, raw)
    }
  })
})
