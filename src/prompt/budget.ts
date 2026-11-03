import { PromptError } from "./errors.ts"
import type { RenderedSlice } from "./slices.ts"

/**
 * How much always-on text this harness will send, in **characters**.
 *
 * The number is the T4 `tailTokens` constant because that is the size the compaction design budgets
 * for the standing context, but the unit here is deliberately not tokens: measuring tokens means
 * shipping a tokenizer, and a tokenizer that disagrees with the provider's is worse than no
 * measurement. Characters are a conservative stand-in — English and code run at roughly four
 * characters per token — so a prompt that fits in 24,000 characters is comfortably inside 24,000
 * tokens. The converse is not claimed: this is a compiler limit, not T4 headroom accounting.
 */
export const ALWAYS_ON_BUDGET_CHARS = 24_000

export function measureAlwaysOn(slices: readonly RenderedSlice[]): number {
  let total = 0
  for (const slice of slices) total += slice.chars
  return total
}

/**
 * Refuse a prompt that cannot fit, and name the slice that broke it.
 *
 * The total is measured over the assembled text, not over a sum of estimates, so this is also the
 * check that `chars` agrees with what actually gets sent.
 */
export function assertAlwaysOnBudget(
  slices: readonly RenderedSlice[],
  systemPrompt: string,
  budget: number = ALWAYS_ON_BUDGET_CHARS,
): number {
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new PromptError(
      "PROMPT_BUDGET_INVALID",
      `the always-on budget must be a positive integer, got ${String(budget)}`,
    )
  }
  const measured = measureAlwaysOn(slices)
  if (measured !== systemPrompt.length) {
    throw new PromptError(
      "PROMPT_SLICE_INVALID",
      `slice characters (${measured}) do not match the assembled prompt (${systemPrompt.length}); ` +
        "the budget would be enforced against a number that is not the prompt",
    )
  }
  if (measured <= budget) return measured

  let running = 0
  let offender = slices.at(-1)?.id ?? "core"
  for (const slice of slices) {
    running += slice.chars
    if (running > budget) {
      offender = slice.id
      break
    }
  }
  throw new PromptError(
    "PROMPT_TOO_LARGE",
    `the always-on prompt is ${measured} characters, over the ${budget}-character budget; ` +
      `slice "${offender}" pushed it past the limit`,
  )
}
