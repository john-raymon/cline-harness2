import { z } from "zod"

import { canonicalSha256 } from "../domain/canonical.ts"
import { sha256HexSchema, type HarnessTree } from "../domain/schemas.ts"
import { COMPONENT_VERSION } from "./components.ts"

/**
 * The baseline fingerprint: everything capture owns, frozen.
 *
 * This is deliberately *not* `probeFingerprintSchema`. The probe fingerprint also covers the tool
 * inventory (Chunk 7), the compiled prompt (Chunk 8), the T4 policy and the slices — values that do
 * not exist yet. Emitting them as placeholders would make two different states hash alike, so capture
 * produces a complete fingerprint of its own and Chunks 7–8 compose the probe one from it.
 */

export const BASELINE_FINGERPRINT_VERSION = 1

/** Git object ids are SHA-1 today and SHA-256 in a repository created with `--object-format`. */
const gitShaSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "expected a lowercase hex git object id")

export const baselineFingerprintSchema = z.strictObject({
  version: z.literal(BASELINE_FINGERPRINT_VERSION),
  manifestSha: sha256HexSchema,
  baseSha: gitShaSchema,
  isDirty: z.boolean(),
  /**
   * `null` means "there is no lockfile", which is a different state from an empty one. Composition
   * must reject `null` rather than substitute a digest, or an absent lockfile would look pinned.
   */
  dependencyLockHash: sha256HexSchema.nullable(),
  treeSha: sha256HexSchema,
  ssotRulesHash: sha256HexSchema,
})

export type BaselineFingerprint = z.infer<typeof baselineFingerprintSchema>

export interface ManifestEntry {
  readonly id: string
  readonly path: string
  readonly kind: "file" | "directory"
  readonly required: boolean
  readonly present: boolean
}

/** One captured file that is backed by an SSOT file, whether declared or resolved through a link. */
export interface SsotAssociation {
  readonly destination: string
  readonly sourceRoot: "ssot"
  readonly sourcePath: string
  readonly sourceSha256: string
}

function compare(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Hash of the manifest as it was actually applied.
 *
 * Presence is included and content is not: whether a component existed is part of what the baseline
 * claims, while the bytes are already covered by `treeSha`. Including file counts here would make one
 * edit change two hashes and blur which one moved.
 */
export function manifestShaOf(entries: readonly ManifestEntry[]): string {
  const components = entries
    .map((entry) => ({
      id: entry.id,
      path: entry.path,
      kind: entry.kind,
      required: entry.required,
      present: entry.present,
    }))
    .sort((left, right) => compare(left.id, right.id))
  return canonicalSha256({ version: COMPONENT_VERSION, components })
}

/**
 * Hash of the SSOT provenance: which canonical file backed which captured file, and at what digest.
 *
 * The envelope is labelled and versioned so an empty association list cannot collide with any other
 * empty value that might be hashed later. Zero associations is a real state ("this repo links to
 * nothing in the SSOT"); a *declared* association whose source is missing is an error instead.
 */
export function ssotRulesHashOf(associations: readonly SsotAssociation[]): string {
  const normalised = associations
    .map((association) => ({
      destination: association.destination,
      sourceRoot: association.sourceRoot,
      sourcePath: association.sourcePath,
      sourceSha256: association.sourceSha256,
    }))
    .sort(
      (left, right) =>
        compare(left.destination, right.destination) || compare(left.sourcePath, right.sourcePath),
    )
  return canonicalSha256({ kind: "ssot-rules", version: 1, associations: normalised })
}

export interface BaselineFingerprintInput {
  readonly manifest: readonly ManifestEntry[]
  readonly baseSha: string
  readonly dirty: readonly string[]
  readonly dependencyLockHash: string | null
  readonly tree: HarnessTree
  readonly associations: readonly SsotAssociation[]
}

export function baselineFingerprint(input: BaselineFingerprintInput): BaselineFingerprint {
  return baselineFingerprintSchema.parse({
    version: BASELINE_FINGERPRINT_VERSION,
    manifestSha: manifestShaOf(input.manifest),
    baseSha: input.baseSha,
    isDirty: input.dirty.length > 0,
    dependencyLockHash: input.dependencyLockHash,
    treeSha: canonicalSha256(input.tree),
    ssotRulesHash: ssotRulesHashOf(input.associations),
  })
}

/**
 * The one identifier for this baseline.
 *
 * It hashes an explicit projection rather than the object that carries it, so adding a field to the
 * capture (a file list, a timing) can never silently change the identity of an unchanged `e_0`. The
 * projection is labelled for the same reason the association envelope is.
 */
export function baselineShaOf(fingerprint: BaselineFingerprint): string {
  return canonicalSha256({
    kind: "baseline",
    version: BASELINE_FINGERPRINT_VERSION,
    fingerprint: baselineFingerprintSchema.parse(fingerprint),
  })
}
