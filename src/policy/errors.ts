/**
 * Errors raised while deciding what a session may do.
 *
 * All of them are configuration failures found before a session starts, which is the point: a policy
 * that names a tool the tree does not define is a lie about the harness, and discovering it at the
 * first tool call would mean the run had already spent a turn believing it.
 */
export type PolicyErrorCode =
  | "TOOL_INVENTORY_INVALID"
  | "TOOL_NAME_INVALID"
  | "TOOL_DESCRIPTION_EMPTY"
  | "POLICY_INVALID"
  | "POLICY_CONFLICT"
  | "POLICY_UNKNOWN_TOOL"

export class PolicyError extends Error {
  override readonly name = "PolicyError"
  readonly code: PolicyErrorCode

  constructor(code: PolicyErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
  }
}
