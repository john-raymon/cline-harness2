/**
 * Errors raised while turning a harness tree into the prompt a session runs on.
 *
 * Every one of them is found before the session starts, because a prompt that does not fit, or that
 * silently drops a slice, produces a run whose recorded fingerprint describes a harness that never ran.
 */
export type PromptErrorCode =
  | "PROMPT_TASK_INVALID"
  | "PROMPT_BUDGET_INVALID"
  | "PROMPT_TOO_LARGE"
  | "PROMPT_SLICE_INVALID"
  | "SKILL_INVALID"
  | "TOOL_ENTRY_BUDGET_EXCEEDED"

export class PromptError extends Error {
  override readonly name = "PromptError"
  readonly code: PromptErrorCode

  constructor(code: PromptErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
  }
}
