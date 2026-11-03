/**
 * Errors raised while composing the probe fingerprint.
 *
 * A fingerprint that is merely *constructible* is worthless: the whole point is that two probes are
 * comparable only if every field that could change behaviour is present and identical. So composition
 * refuses incomplete inputs instead of substituting a plausible value.
 */
export type FingerprintErrorCode = "FINGERPRINT_INCOMPLETE" | "FINGERPRINT_INVALID" | "FINGERPRINT_MISMATCH"

export class FingerprintError extends Error {
  override readonly name = "FingerprintError"
  readonly code: FingerprintErrorCode

  constructor(code: FingerprintErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
  }
}
