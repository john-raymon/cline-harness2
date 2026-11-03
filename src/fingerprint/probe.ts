import { baselineShaOf, baselineFingerprintSchema, type BaselineFingerprint } from "../baseline/fingerprint.ts"
import { canonicalSha256 } from "../domain/canonical.ts"
import {
  gitObjectIdSchema,
  sha256HexSchema,
  PROBE_FINGERPRINT_VERSION,
  probeFingerprintSchema,
  type HarnessTree,
  type ProbeFingerprint,
  type ReasoningEffort,
  type RunConfig,
} from "../domain/schemas.ts"
import type { CompiledPrompt } from "../prompt/compile.ts"
import { z } from "zod"
import { FingerprintError } from "./errors.ts"

/**
 * The probe fingerprint: everything that must be identical for a probe to count as a matched contrast
 * against `e_0`.
 *
 * Chunk 4 froze what capture owns. This module adds what the session owns — the compiled prompt, the
 * tool inventory, the tool policy, the T4 thresholds — and refuses to emit anything with a hole in it.
 */

/**
 * Reasoning settings this adapter requests.
 *
 * Recorded rather than guessed: the values are sent in `sessionConfig`, so the fingerprint describes
 * what was asked for. Whether the provider honours them is not established by any claim in
 * `docs/ADAPTER.md` — that is a debt, not an assumption baked into a digest.
 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "none"
export const DEFAULT_THINKING = false

/**
 * The lesson library does not exist yet (Chunk 18).
 *
 * An empty library is still a state, and it has exactly one canonical hash — pinning that is honest,
 * where inventing a random value would make every probe look like a different library.
 */
export const EMPTY_LIBRARY_SHA256 = canonicalSha256({
  kind: "lesson-library",
  version: 1,
  lessons: [],
})

/**
 * The T4 thresholds as one stable string.
 *
 * Interpolated from the config rather than hardcoded: `t4/v1` names the *policy format*, so a run that
 * overrides `tailTokens` cannot fingerprint identically to one that did not. The thresholds are policy;
 * the summariser that enforces them is Chunks 12–13, and this string does not claim it is installed.
 */
export function t4PolicyOf(config: RunConfig): string {
  return (
    `t4/v1:tail=${config.tailTokens};target=${config.targetTokens};` +
    `b1=${config.b1Tokens};b2=${config.b2Tokens}`
  )
}

export interface ComposeProbeFingerprintInput {
  readonly baseline: BaselineFingerprint
  readonly prompt: CompiledPrompt
  readonly toolPolicySet: readonly string[]
  readonly toolInventoryHash: string
  readonly config: RunConfig
  readonly reasoningEffort?: ReasoningEffort
  readonly thinking?: boolean
  /** Overridden only by a run that actually mounts a non-empty library. */
  readonly librarySnapshotHash?: string
}

export function composeProbeFingerprint(input: ComposeProbeFingerprintInput): ProbeFingerprint {
  const { baseline } = input
  if (baseline.dependencyLockHash === null) {
    throw new FingerprintError(
      "FINGERPRINT_INCOMPLETE",
      "the baseline has no dependency lockfile, so dependency identity is unknown; a probe run " +
        "against unpinned dependencies is not comparable to one that was pinned",
    )
  }
  const candidate = {
    version: PROBE_FINGERPRINT_VERSION,
    baseSha: baseline.baseSha,
    dependencyLockHash: baseline.dependencyLockHash,
    providerId: input.config.providerId,
    modelId: input.config.modelId,
    baseUrl: input.config.baseUrl,
    reasoningEffort: input.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    thinking: input.thinking ?? DEFAULT_THINKING,
    toolPolicySet: [...new Set(input.toolPolicySet)].sort(),
    toolInventoryHash: input.toolInventoryHash,
    compiledPromptHash: input.prompt.compiledPromptHash,
    t4Policy: t4PolicyOf(input.config),
    ssotRulesHash: baseline.ssotRulesHash,
    treeSha: baseline.treeSha,
    librarySnapshotHash: input.librarySnapshotHash ?? EMPTY_LIBRARY_SHA256,
    slices: input.prompt.slices.map((slice) => slice.id),
  }
  const parsed = probeFingerprintSchema.safeParse(candidate)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")
    throw new FingerprintError("FINGERPRINT_INVALID", `the composed fingerprint is not valid: ${detail}`)
  }
  return parsed.data
}

/** Stable identity of a fingerprint, for records that should not carry the whole thing inline. */
export function probeFingerprintSha256(fingerprint: ProbeFingerprint): string {
  return canonicalSha256(fingerprint)
}

/**
 * Check that the tree a session is about to mount is the one the baseline describes.
 *
 * Without this, `bootstrapSession` would happily run tree A while recording the fingerprint of tree B:
 * both values are caller-supplied, and both parse.
 */
export function verifyHarnessBaseline(input: {
  readonly tree: HarnessTree
  readonly baselineSha: string
  readonly fingerprint: BaselineFingerprint
}): void {
  const parsed = baselineFingerprintSchema.safeParse(input.fingerprint)
  if (!parsed.success) {
    throw new FingerprintError(
      "FINGERPRINT_INVALID",
      `the baseline fingerprint is not valid: ${parsed.error.issues[0]?.message ?? "unknown issue"}`,
    )
  }
  const treeSha = canonicalSha256(input.tree)
  if (treeSha !== parsed.data.treeSha) {
    throw new FingerprintError(
      "FINGERPRINT_MISMATCH",
      `the mounted tree hashes to ${treeSha} but the baseline fingerprint pins ${parsed.data.treeSha}; ` +
        "the session would run a harness it never captured",
    )
  }
  const baselineSha = baselineShaOf(parsed.data)
  if (baselineSha !== input.baselineSha) {
    throw new FingerprintError(
      "FINGERPRINT_MISMATCH",
      `the baseline fingerprint hashes to ${baselineSha} but the baseline claims ${input.baselineSha}`,
    )
  }
}

/**
 * What has to match for two probes to be comparable.
 *
 * A matched contrast is a claim that "the only difference between these two measurements is the harness".
 * That claim is about the *environment*, not about the digest: `treeSha`, `compiledPromptHash` and
 * `librarySnapshotHash` are exactly what a candidate is trying to change, and `baselineSha` is a digest
 * *over* those fields, so requiring any of them to be equal would refuse every real candidate and leave the
 * Selector able to compare a harness only with itself.
 *
 * So this is the invariant projection: same repository state, same model, same endpoint, same tool surface,
 * same context policy. If any of these moved, the probes answer different questions and no choice between
 * them means anything.
 */
export const probeEnvironmentSchema = z.strictObject({
  baseSha: gitObjectIdSchema,
  dependencyLockHash: sha256HexSchema,
  ssotRulesHash: sha256HexSchema,
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  baseUrl: z.string().min(1),
  reasoningEffort: z.string().min(1),
  thinking: z.boolean(),
  toolPolicySet: z.array(z.string().min(1)),
  toolInventoryHash: sha256HexSchema,
  t4Policy: z.string().min(1),
})

export type ProbeEnvironment = z.infer<typeof probeEnvironmentSchema>

/** The invariant half of a fingerprint, in a stable order so two projections compare directly. */
export function probeEnvironmentOf(fingerprint: ProbeFingerprint): ProbeEnvironment {
  return probeEnvironmentSchema.parse({
    baseSha: fingerprint.baseSha,
    dependencyLockHash: fingerprint.dependencyLockHash,
    ssotRulesHash: fingerprint.ssotRulesHash,
    providerId: fingerprint.providerId,
    modelId: fingerprint.modelId,
    baseUrl: fingerprint.baseUrl,
    reasoningEffort: fingerprint.reasoningEffort,
    thinking: fingerprint.thinking,
    toolPolicySet: [...new Set(fingerprint.toolPolicySet)].sort(),
    toolInventoryHash: fingerprint.toolInventoryHash,
    t4Policy: fingerprint.t4Policy,
  })
}

/**
 * Names of the invariant fields that differ, empty when the two probes are comparable.
 *
 * Field names rather than a boolean: a refusal that says only "they do not match" cannot be acted on, and
 * the whole point of the gate is that the operator can see *what* moved.
 */
export function environmentMismatches(
  left: ProbeEnvironment,
  right: ProbeEnvironment,
): readonly string[] {
  const fields = Object.keys(probeEnvironmentSchema.shape) as (keyof ProbeEnvironment)[]
  const differing: string[] = []
  for (const field of fields) {
    const a = left[field]
    const b = right[field]
    const same = Array.isArray(a) && Array.isArray(b) ? a.join("\n") === b.join("\n") : a === b
    if (!same) differing.push(field)
  }
  return differing
}
