import { LEDGER_EVENT_VERSION, ledgerEventSchema, type LedgerEvent, type LedgerEventInput } from "../../src/ledger/events.ts"

/**
 * Ledger fixtures.
 *
 * `at` is fixed rather than `new Date()`, so a test that compares two records is comparing the events
 * and not the clock. Bodies are plain objects and every one is validated on the way in: a fixture that
 * is invalid by accident would make the test that uses it pass for the wrong reason.
 */

export const AT = "2026-11-02T00:00:00.000Z"
export const SHA_A = "a".repeat(64)
export const SHA_B = "b".repeat(64)

export function runStartedBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "run.started",
    runId: "run-1",
    baselineSha: SHA_A,
    probeSha: SHA_B,
    providerId: "openai-compatible",
    modelId: "hf:test/model",
    baseUrl: "http://127.0.0.1:1/v1",
    promptSha256: SHA_A,
    toolPolicySet: ["default:deny"],
    toolInventoryHash: SHA_B,
    k: 1,
    ...overrides,
  }
}

/** Validate one event at an explicit `seq`, so a gap can be built on purpose. */
export function eventAt(seq: number, body: Record<string, unknown>): LedgerEvent {
  return ledgerEventSchema.parse({ version: LEDGER_EVENT_VERSION, seq, at: AT, ...body })
}

/** Validate a sequence, numbering from 1. */
export function eventSequence(bodies: readonly Record<string, unknown>[]): LedgerEvent[] {
  return bodies.map((body, index) => eventAt(index + 1, body))
}

/**
 * A fixture body as `append` expects it.
 *
 * The fixture is a plain record so a test can vary any field; this is the one place that asserts the
 * shape is close enough to be the writer's problem rather than the test's.
 */
export function asInput(body: Record<string, unknown>): LedgerEventInput {
  return body as LedgerEventInput
}
