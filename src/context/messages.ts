import { ContextError } from "./errors.ts"
import type { TokenEstimator } from "./tokens.ts"

/**
 * The conversation as the SDK hands it to a message builder, validated without being rewritten.
 *
 * `raw` is the original object, extensions and all. Projecting a message down to `{role, content}` would
 * discard the fields that cost the most tokens (tool calls, their arguments, reasoning content) and would
 * make "preserve the tail verbatim" impossible to honour — the tail must be the caller's own objects, not a
 * reconstruction of them.
 */
export type MessageRole = "system" | "user" | "assistant" | "tool"

export interface ConversationMessage {
  readonly index: number
  readonly role: MessageRole
  readonly raw: Record<string, unknown>
}

const ROLES: readonly string[] = ["system", "user", "assistant", "tool"]

/**
 * Validate the array a message builder received.
 *
 * `content: null` is accepted on purpose: an OpenAI-compatible tool-call turn may carry no prose at all, and
 * refusing it would reject a legal request on a technicality. What is refused is anything the measurement
 * cannot defend — a non-array, a non-object element, or a role outside the four this harness models.
 */
export function normalizeMessages(raw: unknown): ConversationMessage[] {
  if (!Array.isArray(raw)) {
    throw new ContextError(
      "CONTEXT_MESSAGES_INVALID",
      `the message builder received ${describeType(raw)} instead of an array of messages`,
    )
  }

  return raw.map((element: unknown, index: number) => {
    if (typeof element !== "object" || element === null || Array.isArray(element)) {
      throw new ContextError(
        "CONTEXT_MESSAGES_INVALID",
        `message ${index} is ${describeType(element)}, not a message object`,
      )
    }
    const message = element as Record<string, unknown>
    const role = message.role
    if (typeof role !== "string" || !ROLES.includes(role)) {
      throw new ContextError(
        "CONTEXT_MESSAGES_INVALID",
        `message ${index} has role ${JSON.stringify(role)}, which is not one of ${ROLES.join(", ")}`,
      )
    }
    assertContent(index, role, message.content)
    return { index, role: role as MessageRole, raw: message }
  })
}

function assertContent(index: number, role: string, content: unknown): void {
  // Accepted for every role: an OpenAI-compatible tool-call turn may carry no prose at all, and a null
  // without calls simply costs framing. Refusing it would reject a legal payload on a technicality.
  if (content === null) return
  if (typeof content === "string") return
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part !== "object" || part === null || typeof (part as { type?: unknown }).type !== "string") {
        throw new ContextError(
          "CONTEXT_MESSAGES_INVALID",
          `message ${index} has a content part that is not a {type, ...} object`,
        )
      }
    }
    return
  }
  throw new ContextError(
    "CONTEXT_MESSAGES_INVALID",
    `message ${index} has content of type ${describeType(content)}, which is not a string, an array of parts or null`,
  )
}

/** An indivisible run of messages: never rewritten apart, never preserved apart. */
export interface MessageGroup {
  readonly start: number
  readonly end: number
}

const TOOL_CALL_KEYS = ["tool_calls", "toolCalls"] as const

function callsOf(message: ConversationMessage): readonly Record<string, unknown>[] {
  for (const key of TOOL_CALL_KEYS) {
    const value = message.raw[key]
    if (!Array.isArray(value)) continue
    if (value.every((entry) => typeof entry === "object" && entry !== null)) {
      return value as readonly Record<string, unknown>[]
    }
  }
  return []
}

function carriesToolCalls(message: ConversationMessage): boolean {
  for (const key of TOOL_CALL_KEYS) {
    const value = message.raw[key]
    if (Array.isArray(value) && value.length > 0) return true
  }
  return false
}

/**
 * Group the conversation into runs that must be rewritten or preserved together.
 *
 * An assistant message that asks for tools and the `tool` messages answering it are one unit: preserving the
 * results while rewriting away the request produces a request the provider rejects. Pairing is by call id
 * where both sides carry one and positional otherwise, because the exact tool-message shape is not pinned by
 * any claim — and a `tool` message with no request before it is grouped alone rather than refused, since
 * whether that array is legal is the provider's judgement, not this module's.
 */
export function messageGroups(messages: readonly ConversationMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index]
    if (message === undefined) break
    if (message.role === "assistant" && carriesToolCalls(message)) {
      const calls = callsOf(message)
      const ids = calls
        .map((call) => stringOf(call.id ?? call.callId ?? call.toolCallId))
        .filter((id): id is string => id !== undefined)
      // Id matching only when *every* call carries one. With a partial set, a result for the id-less call
      // would look foreign and end the group, splitting a request from its answer — the one outcome this
      // function exists to prevent. Positional grouping keeps them together and over-preserves instead.
      const reliableIds = calls.length > 0 && ids.length === calls.length ? new Set(ids) : undefined
      let end = index
      let cursor = index + 1
      while (cursor < messages.length && messages[cursor]?.role === "tool") {
        const toolMessage = messages[cursor]
        const toolId =
          toolMessage === undefined
            ? undefined
            : stringOf(toolMessage.raw.tool_call_id ?? toolMessage.raw.toolCallId ?? toolMessage.raw.id)
        // A result that answers some other request ends this group: keeping it would preserve a pairing the
        // request never made.
        if (reliableIds !== undefined && toolId !== undefined && !reliableIds.has(toolId)) break
        end = cursor
        cursor += 1
      }
      groups.push({ start: index, end })
      index = end + 1
      continue
    }
    groups.push({ start: index, end: index })
    index += 1
  }
  return groups
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function describeType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  return `a ${typeof value}`
}

/** Where the verbatim tail starts, and what it costs. */
export interface TailBoundary {
  /** Inclusive: `[start, messages.length)` is preserved and `[0, start)` is eligible for rewriting. */
  readonly start: number
  readonly tokens: number
  /** True when the mandatory final group alone exceeds the tail budget. */
  readonly oversizeGroup: boolean
}

/**
 * Find the tail boundary.
 *
 * The final group is always preserved, because a builder that rewrote the newest turn would be answering a
 * question the model has not seen. Everything before it joins the tail only while the accumulated estimate
 * stays within `tailTokens`, so the tail is a budget that is met from the end rather than a count that is
 * crossed: "at least 24k" with unbounded overshoot could preserve 111k, which is above the 105k compaction
 * target and still below the 160k refusal threshold — a tail that cannot be compacted to target and would
 * not be refused either. When the mandatory group is bigger than the whole budget the exception is reported
 * rather than hidden, and the caller decides whether the target is still reachable.
 */
export function tailBoundary(
  messages: readonly ConversationMessage[],
  options: { readonly tailTokens: number; readonly estimator: TokenEstimator },
): TailBoundary {
  const { tailTokens, estimator } = options
  if (messages.length === 0) return { start: 0, tokens: 0, oversizeGroup: false }

  const groups = messageGroups(messages)
  const tokensOf = (group: MessageGroup): number => {
    let total = 0
    for (let index = group.start; index <= group.end; index += 1) {
      const message = messages[index]
      if (message !== undefined) total += estimator.estimateMessage(message)
    }
    return total
  }

  const last = groups[groups.length - 1]
  if (last === undefined) return { start: 0, tokens: 0, oversizeGroup: false }

  const lastTokens = tokensOf(last)
  let accumulated = lastTokens
  let cursor = groups.length - 1
  while (cursor > 0) {
    const previous = groups[cursor - 1]
    if (previous === undefined) break
    const cost = tokensOf(previous)
    if (accumulated + cost > tailTokens) break
    accumulated += cost
    cursor -= 1
  }

  return { start: groups[cursor]?.start ?? 0, tokens: accumulated, oversizeGroup: lastTokens > tailTokens }
}
