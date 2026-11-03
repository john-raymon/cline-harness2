import type { ConversationMessage } from "./messages.ts"
import type { TokenEstimator } from "./tokens.ts"

/**
 * What a compaction is allowed to replace, and how much room it has to do it in.
 *
 * The interface is the whole point of this file: the extractive summariser below is deterministic and local,
 * and Chunk 14's oracle client implements the same contract without the compactor knowing which one it got.
 */
export interface SummariserInput {
  /** The eligible messages, in conversation order. Never includes the tail. */
  readonly messages: readonly ConversationMessage[]
  /** The estimate the replacement may cost. A summariser that ignores it will be caught by the re-measure. */
  readonly budgetTokens: number
  readonly estimator: TokenEstimator
}

export interface Summariser {
  readonly id: string
  summarise(input: SummariserInput): string | Promise<string>
}

/**
 * A deterministic, extractive summariser.
 *
 * No model, no clock, no randomness: it walks the eligible messages in order and keeps whole lines until the
 * budget is spent, then truncates the one line that crossed it. That makes the output a pure function of the
 * input, which is what lets a test assert "same input, same summary" — and it means a run can be replayed
 * without a second provider call.
 *
 * It is a floor, not a summary in the useful sense: it preserves the shape of earlier work without
 * compressing it, so it cannot reclaim as much as a model would. Chunk 14 replaces it behind this contract.
 */
export function extractiveSummariser(): Summariser {
  return {
    id: "extractive-v1",
    summarise: (input: SummariserInput): string => {
      if (input.budgetTokens <= 0) return ""
      const lines: string[] = []
      for (const message of input.messages) {
        for (const line of textOf(message).split("\n")) {
          if (line.trim().length === 0) continue
          lines.push(line)
        }
      }

      let used = 0
      const kept: string[] = []
      for (const line of lines) {
        // The newline is charged only between lines that are actually kept. Charging it on the first line
        // made a one-token budget spend its whole allowance on a separator that did not exist, which turned
        // a legitimately tiny summary into `SUMMARY_EMPTY`.
        const separator = kept.length === 0 ? 0 : 1
        const cost = input.estimator.estimateText(line) + separator
        if (used + cost <= input.budgetTokens) {
          kept.push(line)
          used += cost
          continue
        }
        // The line that crossed the budget is truncated rather than dropped: the last partial line is
        // usually the one carrying the current state, and losing it entirely loses more than it saves.
        const room = input.budgetTokens - used - separator
        if (room > 0) {
          const clipped = clipToTokens(line, room, input.estimator)
          if (clipped.length > 0) kept.push(clipped)
        }
        break
      }
      return kept.join("\n")
    },
  }
}

/** The text a message contributes: its prose, its parts, or its serialized form when it has neither. */
function textOf(message: ConversationMessage): string {
  const prose = proseOf(message.raw.content)
  // A turn can carry both prose and tool calls — "let me check" plus the call itself. Returning the prose
  // alone would drop the tool name and its arguments from the summary, i.e. drop the part that describes what
  // the run actually did.
  const calls = message.raw.tool_calls ?? message.raw.toolCalls
  const rendered = Array.isArray(calls) && calls.length > 0 ? calls.map((call) => stringify(call)).join("\n") : ""
  if (prose.length === 0 && rendered.length === 0) return stringify(message.raw)
  return [prose, rendered].filter((part) => part.length > 0).join("\n")
}

function proseOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part !== null ? (part as { text?: unknown }).text : undefined))
      .filter((text): text is string => typeof text === "string")
      .join("\n")
  }
  return ""
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}

/**
 * Truncate to a token budget on a code-point boundary.
 *
 * Slicing bytes would split a multi-byte character and put a replacement character in the summary; walking
 * code points keeps the text valid while staying inside the estimate.
 */
function clipToTokens(text: string, budgetTokens: number, estimator: TokenEstimator): string {
  if (estimator.estimateText(text) <= budgetTokens) return text
  let chars = 0
  let cost = 0
  for (const char of text) {
    cost += estimator.estimateText(char)
    if (cost > budgetTokens) break
    chars += char.length
  }
  return text.slice(0, chars)
}
