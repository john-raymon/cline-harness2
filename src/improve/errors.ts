/**
 * Errors raised while turning an oracle proposal into a harness.
 *
 * A bad proposal is an expected outcome, not a crash, so most of these are returned as a refusal by the
 * improver loop and recorded. They stay a typed union so "the model wrote prose" and "the model tried to
 * replace the whole harness" are distinguishable facts rather than one message.
 */
export type ImproveErrorCode =
  | "PROPOSAL_UNPARSEABLE"
  | "PROPOSAL_INVALID"
  | "PROPOSAL_FENCE"
  | "PROPOSAL_EMPTY"
  | "PROPOSAL_TOO_BROAD"
  | "PROPOSAL_EMPTIES_TREE"

export class ImproveError extends Error {
  override readonly name = "ImproveError"
  readonly code: ImproveErrorCode

  constructor(code: ImproveErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
  }
}
