import { canonicalSha256 } from "../domain/canonical.ts"
import { AdapterError } from "./errors.ts"

/**
 * The prompt a session is started with.
 *
 * Assembling the real prompt out of tree files is Chunk 8's job. Chunk 5 only has to prove a session
 * starts, so it ships a fixed system prompt and records *which* producer wrote it. The consumer never
 * changes: Chunk 8 replaces `buildBootstrapPrompt` with a tree compiler that returns the same shape.
 */

export const PROMPT_SOURCES = ["bootstrap-constant", "compiled"] as const
export type PromptSource = (typeof PROMPT_SOURCES)[number]

export const PROMPT_VERSION = 1

/**
 * The bootstrap system prompt states the Chunk 5 contract instead of pretending to be a real harness.
 *
 * Tool execution is denied by the default `beforeTool` hook until the tool-policy chunk lands, so the
 * prompt says so plainly — a model that is told it cannot act will answer in text, while a model that
 * is told to act and silently cannot spends the turn retrying and burns the iteration budget.
 */
export const BOOTSTRAP_SYSTEM_PROMPT = [
  "You are the harness bootstrap probe for cline-harness2.",
  "This session exists to prove that a session can be started and can complete one turn.",
  "Tool execution is disabled for this session by policy.",
  "Answer the operator's task directly in text, without calling tools.",
].join("\n")

export interface CompiledPrompt {
  readonly source: PromptSource
  readonly systemPrompt: string
  readonly taskPrompt: string
  readonly sha256: string
}

/**
 * Hash over the labelled envelope, not just the concatenation.
 *
 * Two different producers must not collide: an empty task under a bootstrap system prompt is a
 * different prompt from the same bytes split the other way, and the ledger compares these hashes.
 */
export function promptSha256(input: {
  source: PromptSource
  systemPrompt: string
  taskPrompt: string
}): string {
  return canonicalSha256({
    version: PROMPT_VERSION,
    source: input.source,
    systemPrompt: input.systemPrompt,
    taskPrompt: input.taskPrompt,
  })
}

export function buildBootstrapPrompt(
  taskPrompt: string,
  options: { readonly allowedTools?: readonly string[] } = {},
): CompiledPrompt {
  if (taskPrompt.trim().length === 0) {
    throw new AdapterError(
      "PROMPT_INVALID",
      "the task prompt is empty; a session started with it could only produce a meaningless turn",
    )
  }
  const source: PromptSource = "bootstrap-constant"
  const allowed = options.allowedTools ?? []
  const systemPrompt =
    allowed.length === 0
      ? BOOTSTRAP_SYSTEM_PROMPT
      : [
          "You are the harness bootstrap probe for cline-harness2.",
          `You may call only these tools: ${[...allowed].sort().join(", ")}.`,
          "Any other tool call is refused by policy. Answer in text when no tool is needed.",
        ].join("\n")
  return {
    source,
    systemPrompt,
    taskPrompt,
    sha256: promptSha256({ source, systemPrompt, taskPrompt }),
  }
}
