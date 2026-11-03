import { ContextError } from "./errors.ts"
import type { ConversationMessage } from "./messages.ts"

/**
 * A stand-in for the provider's tokenizer, and what it does *not* claim.
 *
 * There is no tokenizer in this harness on purpose: one that disagrees with the provider's is worse than a
 * stated approximation, because it turns a measurement into a false assertion. The estimate is
 * `ceil(utf8Bytes / bytesPerToken)` plus framing overhead, which is conservative for ASCII prose and code
 * (real English runs near four bytes per token against a ratio of three) and roughly one-to-one for CJK.
 * It is **not** an upper bound: payloads dense in punctuation, digit runs or JSON escape sequences can cost
 * more than one token per three bytes.
 *
 * `ESTIMATOR_ID` travels with every measurement so a record says which approximation produced it, and so a
 * later calibration against provider usage cannot be mistaken for the same numbers.
 */
export const ESTIMATOR_ID = "utf8-bytes-per-token-v1"

export const DEFAULT_BYTES_PER_TOKEN = 3

/**
 * The accepted calibration band.
 *
 * This is a typo guard, not a quality claim: a ratio of `0.3` or `30` is a mis-scaled measurement rather than
 * a pessimistic one, and accepting it would silently shrink or inflate every threshold decision.
 */
export const MIN_BYTES_PER_TOKEN = 1

export const MAX_BYTES_PER_TOKEN = 8

/** Per-message chat framing allowance (role markers, delimiters). Not measured, not claimed. */
export const MESSAGE_OVERHEAD_TOKENS = 4

/** Per-tool framing allowance, charged *in addition to* the serialized definition, never instead of it. */
export const TOOL_OVERHEAD_TOKENS = 8

export interface TokenEstimator {
  readonly id: string
  readonly bytesPerToken: number
  /** Whole tokens for a string, so a caller can sum estimates without losing fractions. */
  estimateText(text: string): number
  estimateMessage(message: ConversationMessage): number
  estimateTools(tools: readonly unknown[] | undefined): number
}

/**
 * Build an estimator.
 *
 * `bytesPerToken` exists for calibration against provider usage once that telemetry is captured; until then
 * every caller takes the default, and the band above refuses a value that is obviously wrong rather than
 * quietly changing what "over budget" means.
 */
export function createEstimator(options: { readonly bytesPerToken?: number | undefined } = {}): TokenEstimator {
  const bytesPerToken = options.bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN
  if (
    !Number.isFinite(bytesPerToken) ||
    bytesPerToken < MIN_BYTES_PER_TOKEN ||
    bytesPerToken > MAX_BYTES_PER_TOKEN
  ) {
    throw new ContextError(
      "CONTEXT_ESTIMATOR_INVALID",
      `bytesPerToken must be a finite number in [${MIN_BYTES_PER_TOKEN}, ${MAX_BYTES_PER_TOKEN}], ` +
        `got ${String(bytesPerToken)}`,
    )
  }

  const estimateText = (text: string): number => {
    if (text.length === 0) return 0
    return Math.ceil(Buffer.byteLength(text, "utf8") / bytesPerToken)
  }

  return {
    id: `${ESTIMATOR_ID}:${bytesPerToken}`,
    bytesPerToken,
    estimateText,
    // The whole message is serialized, not just `content`: a tool call, its arguments and any reasoning
    // field cost tokens the provider will charge for, and projecting the message down to `{role, content}`
    // would count none of them.
    estimateMessage: (message: ConversationMessage): number =>
      estimateText(safeStringify(message.raw)) + MESSAGE_OVERHEAD_TOKENS,
    estimateTools: (tools: readonly unknown[] | undefined): number => {
      if (tools === undefined) return 0
      let total = 0
      for (const tool of tools) total += estimateText(safeStringify(tool)) + TOOL_OVERHEAD_TOKENS
      return total
    },
  }
}

export const DEFAULT_ESTIMATOR: TokenEstimator = createEstimator()

/**
 * Stringify a payload for measurement, or refuse to guess.
 *
 * An unserializable payload (a cycle, a `BigInt`) used to collapse to a short marker, which made a 600k
 * message measure ten tokens and report a comfortable `ok` — the worst possible failure for a detector,
 * because the number was small rather than wrong-looking. Raising means the caller hears about it.
 * `JSON.stringify` returning `undefined` is different: `undefined`, functions and symbols contribute no
 * serialized bytes at all, so an empty string is the honest measure rather than an error.
 */
function safeStringify(value: unknown): string {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch (error) {
    throw new ContextError(
      "CONTEXT_MEASURE_INVALID",
      `a context payload could not be serialized for measurement: ${describe(error)}`,
      { cause: error },
    )
  }
  return text ?? ""
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
