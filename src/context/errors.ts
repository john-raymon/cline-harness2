/**
 * Errors the context detector can raise.
 *
 * Each one means the measurement could not be trusted, which is why none of them is recoverable here: a
 * detector that guessed its way past an unreadable message would hand the executor a number nobody can
 * defend.
 */
export type ContextErrorCode =
  | "CONTEXT_MESSAGES_INVALID"
  | "CONTEXT_THRESHOLDS_INVALID"
  | "CONTEXT_ESTIMATOR_INVALID"
  | "CONTEXT_MEASURE_INVALID"

export class ContextError extends Error {
  override readonly name = "ContextError"
  readonly code: ContextErrorCode

  constructor(code: ContextErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
  }
}
