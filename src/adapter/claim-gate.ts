import { readFile } from "node:fs/promises"

import { z } from "zod"

import type { HarnessTree } from "../domain/schemas.ts"
import { AdapterError } from "./errors.ts"

/**
 * Pre-flight gate over the recorded SDK spike evidence.
 *
 * `docs/ADAPTER.md` is explicit: a run that depends on a claim must read the evidence file and check
 * that the claim is present, `verified`, and recorded against the *installed* SDK version. Anything
 * weaker turns "unverified" into "assumed", which is how an adapter silently drifts away from the
 * runtime it was written against.
 *
 * The gate only reads claims the caller actually depends on. An empty `requiredClaims` returns before
 * touching the filesystem — a session that depends on no claim must not fail because a developer has
 * never run the spike on this machine.
 */

export const SPIKE_EVIDENCE_PATH = ".tmp/spike-evidence.json"
export const SKILLS_CLAIM_ID = "B1.skills"
export const HOOKS_CLAIM_ID = "B5.hooks"
/**
 * `B2.plugin` is unconditional because every session injects the contract plugin.
 *
 * It is the claim that `extensions: [obj]` registers the plugin's tool and rule at all; without it the
 * session would run believing it installed a guard, and the record would say the same.
 */
export const PLUGIN_CLAIM_ID = "B2.plugin"
export const SUBAGENT_CLAIM_ID = "B6.subagent"
export const SKILLS_TREE_PREFIX = ".cline/skills/"

/**
 * Only the slice of the report the gate promises to check.
 *
 * The full `SpikeReport` is the spike's own format; validating all of it here would make every future
 * spike field a breaking change for the adapter, and would reject a report over a field nobody reads.
 */
const evidenceSchema = z.looseObject({
  sdkVersion: z.string().min(1),
  claims: z.array(
    z.looseObject({
      id: z.string().min(1),
      status: z.string().min(1),
    }),
  ),
})

export interface ClaimGateInput {
  readonly evidencePath: string
  readonly installedSdkVersion: string
  readonly requiredClaims: readonly string[]
}

export interface ClaimGateReport {
  /** The claims that had to be verified. Empty means the gate short-circuited. */
  readonly requiredClaims: readonly string[]
  readonly verifiedClaims: readonly string[]
  /** `null` when the gate never read the file. */
  readonly evidenceSdkVersion: string | null
}

/**
 * Claims a session started from this tree cannot do without.
 *
 * Mounting the tree as the session's working directory is what makes `<cwd>/.cline/skills` visible,
 * so a tree that ships skills depends on `B1.skills` — the claim that establishes discovery happens at
 * all and that an allowlist is not the gate. A tree without skills depends on nothing.
 */
/**
 * Claims a session started from this tree cannot do without.
 *
 * `B5.hooks` is unconditional: every bootstrap installs a `beforeTool` gate — deny-all or a policy — and
 * both rest on the claim that a `{ skip: true }` decision really prevents a tool's side effect. An
 * option to leave it out would be an option to start a session whose gate is unverified.
 *
 * Mounting the tree as the session's working directory is what makes `<cwd>/.cline/skills` visible, so a
 * tree that ships skills also depends on `B1.skills` — the claim that discovery happens at all and that
 * an allowlist is not the gate.
 */
export function requiredClaimsFor(
  tree: HarnessTree,
  options: { readonly subagents?: boolean } = {},
): readonly string[] {
  const claims: string[] = [HOOKS_CLAIM_ID, PLUGIN_CLAIM_ID]
  for (const key of Object.keys(tree)) {
    if (key.startsWith(SKILLS_TREE_PREFIX) && key.length > SKILLS_TREE_PREFIX.length) {
      claims.push(SKILLS_CLAIM_ID)
      break
    }
  }
  // Opt-in: a harness that never spawns a helper must not be refused by a runtime that cannot spawn one.
  if (options.subagents === true) claims.push(SUBAGENT_CLAIM_ID)
  return claims
}

export async function assertClaimsSatisfied(input: ClaimGateInput): Promise<ClaimGateReport> {
  const required = [...new Set(input.requiredClaims)]
  if (required.length === 0) {
    return { requiredClaims: [], verifiedClaims: [], evidenceSdkVersion: null }
  }

  const raw = await readEvidence(input.evidencePath)
  const parsed = evidenceSchema.safeParse(raw)
  if (!parsed.success) {
    throw new AdapterError(
      "SPIKE_EVIDENCE_INVALID",
      `${input.evidencePath} is not a usable spike report: ${describeIssue(parsed.error)}; ` +
        "re-run `pnpm spike:sdk` to regenerate it",
    )
  }

  if (parsed.data.sdkVersion !== input.installedSdkVersion) {
    throw new AdapterError(
      "SDK_VERSION_MISMATCH",
      `${input.evidencePath} was recorded against @cline/sdk ${parsed.data.sdkVersion} but ` +
        `${input.installedSdkVersion} is installed, so the claims no longer describe this runtime; ` +
        "re-run `pnpm spike:sdk` and re-read docs/ADAPTER.md before trusting the adapter",
    )
  }

  const statuses = new Map<string, string>()
  for (const claim of parsed.data.claims) {
    // A duplicated id makes "verified" ambiguous: one entry could be verified and another not, and
    // whichever the map kept would decide the outcome. That is a broken report, not a passing one.
    if (statuses.has(claim.id)) {
      throw new AdapterError(
        "SPIKE_EVIDENCE_INVALID",
        `${input.evidencePath} lists claim ${claim.id} more than once, so its status is ambiguous`,
      )
    }
    statuses.set(claim.id, claim.status)
  }

  for (const id of required) {
    const status = statuses.get(id)
    if (status === undefined) {
      throw new AdapterError(
        "CLAIM_UNVERIFIED",
        `claim ${id} is required by this session but is absent from ${input.evidencePath}; ` +
          "run `pnpm spike:sdk` to establish it",
      )
    }
    if (status !== "verified") {
      throw new AdapterError(
        "CLAIM_UNVERIFIED",
        `claim ${id} is ${status}, not verified, and this session depends on it; ` +
          "see docs/ADAPTER.md for what an unverified claim blocks",
      )
    }
  }

  return {
    requiredClaims: required,
    verifiedClaims: required,
    evidenceSdkVersion: parsed.data.sdkVersion,
  }
}

async function readEvidence(evidencePath: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(evidencePath, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new AdapterError(
        "SPIKE_EVIDENCE_MISSING",
        `${evidencePath} does not exist, so the claims this session depends on cannot be checked; ` +
          "run `pnpm spike:sdk` first",
        { cause: error },
      )
    }
    throw new AdapterError(
      "SPIKE_EVIDENCE_INVALID",
      `${evidencePath} could not be read: ${describe(error)}`,
      { cause: error },
    )
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new AdapterError(
      "SPIKE_EVIDENCE_INVALID",
      `${evidencePath} is not valid JSON: ${describe(error)}; re-run \`pnpm spike:sdk\``,
      { cause: error },
    )
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null | undefined)?.code
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return "no issue reported"
  const at = issue.path.length === 0 ? "<root>" : issue.path.map(String).join(".")
  return `${at}: ${issue.message}`
}
