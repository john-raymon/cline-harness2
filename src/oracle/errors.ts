/**
 * Errors raised while asking an oracle.
 *
 * Two families, deliberately separated by their prefix. `RAW_CONTEXT_*` and `ROLE_*` are refusals this
 * module makes: the call never left the process, so a run can record "no oracle was asked" with a
 * reason. `TRANSPORT_*` and `REPLY_*` are failures of a call that was made, where the honest statement
 * is that something was sent and nothing usable came back. Collapsing them would make a refused call
 * look like a failed one.
 */
export type OracleErrorCode =
  | "ROLE_UNKNOWN"
  | "RAW_CONTEXT_MISSING"
  | "RAW_CONTEXT_INVALID"
  | "RAW_CONTEXT_DUPLICATE"
  | "RAW_CONTEXT_FENCE"
  | "PROMPT_EMPTY"
  | "PROMPT_FENCE"
  | "PROVIDER_UNKNOWN"
  | "CLI_NOT_FOUND"
  | "TRANSPORT_FAILED"
  | "TRANSPORT_TIMEOUT"
  | "REPLY_UNPARSEABLE"
  | "REPLY_EMPTY"

export class OracleError extends Error {
  override readonly name = "OracleError"
  readonly code: OracleErrorCode

  constructor(code: OracleErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
  }
}
