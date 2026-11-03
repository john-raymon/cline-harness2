import { clipToTokens, type Summariser, type SummariserInput } from "../context/summarise.ts"
import type { OracleClient } from "./client.ts"
import type { RawContextSource } from "./context.ts"
import { OracleError, type OracleErrorCode } from "./errors.ts"

/**
 * The other half of the Chunk 13 seam: a model-backed summariser.
 *
 * `compactContext` measures whatever a summariser returns, so this can be swapped in without the
 * compactor knowing which one it got. Two rules keep the swap safe. The reply is clipped to the budget
 * with the same code-point walk the extractive floor uses, because a model that answers at three times
 * the allowance would turn a real compaction into `TARGET_NOT_MET`. And a failed *call* is reported as
 * an empty summary instead of an exception, so `compactContext` can refuse with a typed reason and a
 * residual rather than throwing past a caller that was promised refusals.
 */

/** Failures of a call that was made. Nothing here is a bug in the caller, so none of it escapes. */
const CALL_FAILURES: ReadonlySet<OracleErrorCode> = new Set<OracleErrorCode>([
  "CLI_NOT_FOUND",
  "TRANSPORT_FAILED",
  "TRANSPORT_TIMEOUT",
  "REPLY_EMPTY",
  "REPLY_UNPARSEABLE",
  // These two arise from the *conversation*, not from a caller mistake: a message may legitimately
  // contain a fence-shaped line or an unpaired surrogate. Refusing the whole compaction because the
  // history was unusual would be worse than returning nothing and letting the compactor refuse.
  "RAW_CONTEXT_FENCE",
  "RAW_CONTEXT_INVALID",
])

export interface OracleSummariserOptions {
  readonly timeoutMs?: number
  /** Called with the failure before the empty summary is returned, so a run can record the attempt. */
  readonly onCallFailure?: (error: OracleError) => void
}

export function oracleSummariser(
  client: OracleClient,
  options: OracleSummariserOptions = {},
): Summariser {
  return {
    id: `oracle:${client.provider}:${client.modelId}`,
    async summarise(input: SummariserInput): Promise<string> {
      if (input.budgetTokens <= 0) return ""
      if (input.messages.length === 0) return ""

      // The raw messages, verbatim: a model shown a re-description of the history is summarising the
      // re-description. JSON as the body means a message's structure survives intact.
      const context: RawContextSource[] = input.messages.map((message, index) => ({
        path: `messages/${String(index).padStart(3, "0")}.json`,
        body: JSON.stringify(message.raw, null, 2) ?? "",
      }))

      try {
        const reply = await client.ask({
          role: "composer",
          ask:
            `Rewrite this conversation prefix as one compact account of what happened and what was ` +
            `established. Keep every fact a later turn depends on; invent nothing. Answer in at most ` +
            `${input.budgetTokens} tokens.`,
          context,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        })
        return clipToTokens(reply.text.trim(), input.budgetTokens, input.estimator)
      } catch (error) {
        if (error instanceof OracleError && CALL_FAILURES.has(error.code)) {
          options.onCallFailure?.(error)
          return ""
        }
        throw error
      }
    },
  }
}
