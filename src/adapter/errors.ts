/**
 * Errors raised while driving a `ClineCore` session.
 *
 * The adapter is the first code that crosses into the SDK, so its failures are the ones an operator
 * cannot debug from a stack trace alone: a missing pre-flight artifact, a provider that never answers,
 * a credential that was never supplied. One union of codes keeps "what went wrong" answerable from a
 * single string, and every code here is reachable — none is reserved for a later chunk.
 */
export type AdapterErrorCode =
  | "SPIKE_EVIDENCE_MISSING"
  | "SPIKE_EVIDENCE_INVALID"
  | "SDK_VERSION_MISMATCH"
  | "CLAIM_UNVERIFIED"
  | "RUN_ROOT_UNUSABLE"
  | "RUN_DIR_EXISTS"
  | "HARNESS_MATERIALISE_FAILED"
  | "HARNESS_PLUGIN_FAILED"
  | "TIMEOUT_INVALID"
  | "API_KEY_MISSING"
  | "SESSION_CREATE_FAILED"
  | "SESSION_START_FAILED"
  | "SESSION_INVALID_RESULT"
  | "SESSION_TIMEOUT"
  | "SESSION_ABORTED"
  | "SESSION_DISPOSE_FAILED"

export class AdapterError extends Error {
  override readonly name = "AdapterError"
  readonly code: AdapterErrorCode

  constructor(code: AdapterErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
  }
}
