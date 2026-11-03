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

/**
 * Hook evidence, wrapped around the gate rather than in place of it.
 *
 * `B5.hooks` recorded that all four phases fire, and that `afterTool` fires **even for a call the gate
 * skipped**. So `afterTool` is never evidence that a tool ran: this recorder counts those cases
 * separately (`afterToolOnSkipped`) instead of letting a phase counter imply a side effect.
 *
 * The gate's return value is passed through untouched — a recorder that normalised it would either
 * open the gate or make it stricter, and both would be a policy change hiding as instrumentation.
 */
export interface HookEvidenceSummary {
  readonly beforeRun: number
  readonly afterRun: number
  readonly beforeTool: number
  readonly afterTool: number
  readonly events: number
  /** `afterTool` calls whose `beforeTool` was skipped: the runtime's documented lie. */
  readonly afterToolOnSkipped: number
}

export interface HookRecorder {
  readonly hooks: Record<string, unknown>
  summary(): HookEvidenceSummary
}

/**
 * Identify one call attempt.
 *
 * `afterTool` has no dependable ordering relative to `beforeTool` for *different* calls, so the pairing
 * has to be by identity. `toolCall.id` when the runtime supplies one, then name, then a positional
 * fallback — a name-only key would mis-attribute two concurrent calls to the same tool.
 */
export function callKeyOf(context: unknown, fallback: number): string {
  if (typeof context !== "object" || context === null) return `#${String(fallback)}`
  const ctx = context as {
    toolCall?: { id?: unknown; callId?: unknown; toolCallId?: unknown; name?: unknown; toolName?: unknown }
  }
  for (const candidate of [ctx.toolCall?.id, ctx.toolCall?.callId, ctx.toolCall?.toolCallId]) {
    if (typeof candidate === "string" && candidate.length > 0) return `id:${candidate}`
  }
  const name = toolNameOf(context)
  return name.length > 0 ? `name:${name}` : `#${String(fallback)}`
}

export function recordingHooks(input: PolicyHookInput): HookRecorder {
  const gate = policyHooks(input)
  const counters = { beforeRun: 0, afterRun: 0, beforeTool: 0, afterTool: 0, events: 0, skipped: 0 }
  const skipped = new Set<string>()
  let attempts = 0

  return {
    hooks: {
      beforeRun: () => {
        counters.beforeRun += 1
        return undefined
      },
      afterRun: () => {
        counters.afterRun += 1
        return undefined
      },
      beforeTool: (context: unknown) => {
        counters.beforeTool += 1
        attempts += 1
        const verdict = gate.beforeTool(context)
        // Only a `skip: true` is a refusal. Any other shape is not this harness's vocabulary, and
        // treating "not undefined" as skipped would count a future advisory return as a refusal.
        if ((verdict as { skip?: unknown } | undefined)?.skip === true) {
          skipped.add(callKeyOf(context, attempts))
        }
        return verdict
      },
      afterTool: (context: unknown) => {
        counters.afterTool += 1
        // Consume the entry: a skipped key that lingered would make the *next* allowed call to the same
        // tool look like a lie the runtime never told.
        if (skipped.delete(callKeyOf(context, attempts))) counters.skipped += 1
        return undefined
      },
      onEvent: () => {
        counters.events += 1
        return undefined
      },
    },
    summary: () => ({
      beforeRun: counters.beforeRun,
      afterRun: counters.afterRun,
      beforeTool: counters.beforeTool,
      afterTool: counters.afterTool,
      events: counters.events,
      afterToolOnSkipped: counters.skipped,
    }),
  }
}
