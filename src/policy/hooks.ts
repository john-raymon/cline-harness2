import { decisionOf, type ToolDecision, type ToolPolicy } from "./policy.ts"

/**
 * The `beforeTool` hook the session runs under.
 *
 * `B5.hooks` established that returning `{ skip: true }` from `beforeTool` actually prevents the side
 * effect, so this returns a decision instead of advice. `undefined` means "no objection" and lets the call
 * proceed; anything else is a refusal.
 *
 * `policy === undefined` is the default-deny session: every named tool is refused, which is what Chunk 5
 * shipped and what a run without a policy still gets.
 */

export interface PolicyHookInput {
  readonly policy: ToolPolicy | undefined
  /** Called once per call attempt, for the probe record and for debugging a refusal. */
  readonly onDecision?: (decision: ToolDecision) => void
}

export interface ToolGateHooks {
  readonly beforeTool: (context: unknown) => { skip: true; appendContext: string } | undefined
}

/**
 * Resolve the tool name out of the hook context.
 *
 * The three shapes are the ones `docs/ADAPTER.md` records from a live session; anything else is
 * unresolvable, and an unresolvable call is denied rather than waved through.
 */
export function toolNameOf(context: unknown): string {
  if (typeof context !== "object" || context === null) return ""
  const ctx = context as {
    toolCall?: { name?: unknown; toolName?: unknown }
    tool?: { name?: unknown }
  }
  for (const candidate of [ctx.toolCall?.name, ctx.toolCall?.toolName, ctx.tool?.name]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate
  }
  return ""
}

export function policyHooks(input: PolicyHookInput): ToolGateHooks {
  return {
    beforeTool: (context: unknown) => {
      const toolName = toolNameOf(context)
      const decision = decisionOf(input.policy, toolName)
      input.onDecision?.(decision)
      if (decision.verdict === "allow") return undefined
      const label = toolName.length === 0 ? "(unnamed tool call)" : toolName
      return {
        skip: true,
        appendContext: `harness2 tool policy: ${label} refused (${decision.reason})`,
      }
    },
  }
}
