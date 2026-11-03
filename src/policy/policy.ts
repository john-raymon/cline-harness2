import { z } from "zod"

import { PolicyError } from "./errors.ts"
import type { ToolInventory } from "./inventory.ts"

/**
 * The tool policy: which of the inventoried tools a session may call.
 *
 * The policy is checked against the inventory at parse time, not at call time. A policy that names a tool
 * the tree does not define is refused as `POLICY_UNKNOWN_TOOL` — dead configuration that silently denies
 * (or silently allows) is how an operator ends up believing a run was unrestricted when it was not.
 *
 * Default is deny. A tool that is neither allowed nor denied is refused, so a policy is an allowlist with
 * an explicit deny override rather than a filter that has to remember to exclude things.
 */

export const TOOL_POLICY_VERSION = 1

/**
 * Stands in for a policy that permits nothing.
 *
 * `toolPolicySet` is a fingerprint field, and an empty array cannot be told apart from "no policy was
 * recorded at all". One explicit marker makes default-deny a state that can be compared across probes.
 */
export const DEFAULT_DENY_MARKER = "default:deny"

export const toolPolicySchema = z.strictObject({
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
})

export type ToolPolicyInput = z.input<typeof toolPolicySchema>

export interface ToolPolicy {
  readonly allow: readonly string[]
  readonly deny: readonly string[]
}

export type ToolDecisionReason =
  | "allowed"
  | "denied"
  | "not-allowed"
  | "unnamed"
  | "default-deny"

export const TOOL_DECISION_REASONS = [
  "allowed",
  "denied",
  "not-allowed",
  "unnamed",
  "default-deny",
] as const

export const toolDecisionReasonSchema = z.enum(TOOL_DECISION_REASONS)

export interface ToolDecision {
  readonly toolName: string
  readonly verdict: "allow" | "deny"
  readonly reason: ToolDecisionReason
}

/** The shape a probe record stores, so a refusal is evidence rather than a log line. */
export const toolDecisionSchema = z.strictObject({
  toolName: z.string(),
  verdict: z.enum(["allow", "deny"]),
  reason: toolDecisionReasonSchema,
})

function compare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

/**
 * Validate a policy against the inventory and normalise it.
 *
 * Sorting and de-duplicating here means `toolPolicySetOf` is a pure projection: two spellings of one
 * policy cannot hash differently, and a fingerprint comparison is not sensitive to list order.
 */
export function parseToolPolicy(input: unknown, inventory: ToolInventory): ToolPolicy {
  const parsed = toolPolicySchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue === undefined || issue.path.length === 0 ? "<root>" : issue.path.map(String).join(".")
    throw new PolicyError(
      "POLICY_INVALID",
      `the tool policy is not usable at ${at}: ${issue === undefined ? "no issue reported" : issue.message}`,
      { cause: parsed.error },
    )
  }

  const known = new Set(inventory.tools.map((tool) => tool.name))
  const allow = [...new Set(parsed.data.allow)].sort(compare)
  const deny = [...new Set(parsed.data.deny)].sort(compare)

  const unknown = [...allow, ...deny].filter((name) => !known.has(name)).sort(compare)
  if (unknown.length > 0) {
    throw new PolicyError(
      "POLICY_UNKNOWN_TOOL",
      `the tool policy names ${unknown.map((name) => JSON.stringify(name)).join(", ")}, which the tree ` +
        `does not define; known tools: ${[...known].sort(compare).join(", ") || "(none)"}`,
    )
  }

  const conflict = allow.filter((name) => deny.includes(name))
  if (conflict.length > 0) {
    throw new PolicyError(
      "POLICY_CONFLICT",
      `${conflict.map((name) => JSON.stringify(name)).join(", ")} is listed as both allowed and denied; ` +
        "that has no meaning, so it is refused rather than resolved by precedence",
    )
  }

  return { allow, deny }
}

/**
 * The fingerprint form: sorted `allow:`/`deny:` entries, or a single marker for "nothing permitted".
 *
 * Sorting across both lists keeps one policy to one value, and the prefixes keep `allow:read` from being
 * confused with `deny:read` by anything that compares strings instead of parsing them.
 */
/**
 * The names a policy actually permits.
 *
 * Deny wins, so this is not `policy.allow`: rendering a denied name into the system prompt would tell
 * the model about a tool the gate refuses, and the turn would be spent learning that the prompt lies.
 */
export function allowedToolNames(policy: ToolPolicy | undefined): string[] {
  if (policy === undefined) return []
  const denied = new Set(policy.deny)
  return policy.allow.filter((name) => !denied.has(name)).sort(compare)
}

export function toolPolicySetOf(policy: ToolPolicy | undefined): string[] {
  if (policy === undefined) return [DEFAULT_DENY_MARKER]
  const entries = [
    ...policy.allow.map((name) => `allow:${name}`),
    ...policy.deny.map((name) => `deny:${name}`),
  ].sort(compare)
  return entries.length === 0 ? [DEFAULT_DENY_MARKER] : entries
}

/** What a single call would be allowed to do. Deny wins, and an unlisted tool is not allowed. */
export function decide(
  policy: ToolPolicy | undefined,
  toolName: string,
): { allowed: boolean; reason: ToolDecisionReason } {
  if (toolName.trim().length === 0) return { allowed: false, reason: "unnamed" }
  // An empty policy permits exactly what no policy permits, and says so with the same reason — otherwise
  // the record would fingerprint `default:deny` while the decisions claimed `not-allowed`.
  if (policy === undefined || (policy.allow.length === 0 && policy.deny.length === 0)) {
    return { allowed: false, reason: "default-deny" }
  }
  // Names are matched exactly. Trimming before comparison would let `" run_commands"` match an allowlist
  // entry for `run_commands`, which is a widening: a name the operator never wrote would be permitted.
  if (policy.deny.includes(toolName)) return { allowed: false, reason: "denied" }
  if (policy.allow.includes(toolName)) return { allowed: true, reason: "allowed" }
  return { allowed: false, reason: "not-allowed" }
}

export function decisionOf(policy: ToolPolicy | undefined, toolName: string): ToolDecision {
  const outcome = decide(policy, toolName)
  return { toolName, verdict: outcome.allowed ? "allow" : "deny", reason: outcome.reason }
}
