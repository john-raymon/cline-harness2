import {
  baselineFingerprint,
  baselineShaOf,
  type BaselineFingerprint,
} from "../../src/baseline/fingerprint.ts"
import type { HarnessTree } from "../../src/domain/schemas.ts"
import type { HarnessBaseline } from "../../src/adapter/session.ts"

/**
 * A baseline for a hand-written tree.
 *
 * `bootstrapSession` verifies that the tree it mounts hashes to the fingerprint it was given, so a test
 * cannot invent a `baselineSha` any more. Building the real thing here is the cheapest way to keep every
 * fixture honest instead of duplicating the manifest/lockfile wiring at each call site.
 */
export interface HarnessFixtureOverrides {
  readonly dependencyLockHash?: string | null
  readonly baseSha?: string
  readonly dirty?: readonly string[]
}

export const FIXTURE_BASE_SHA = "a".repeat(40)
export const FIXTURE_LOCK_HASH = "c".repeat(64)

export function harnessBaseline(
  tree: HarnessTree,
  overrides: HarnessFixtureOverrides = {},
): HarnessBaseline {
  const fingerprint: BaselineFingerprint = baselineFingerprint({
    manifest: [],
    baseSha: overrides.baseSha ?? FIXTURE_BASE_SHA,
    dirty: overrides.dirty ?? [],
    dependencyLockHash:
      overrides.dependencyLockHash === undefined ? FIXTURE_LOCK_HASH : overrides.dependencyLockHash,
    tree,
    associations: [],
  })
  return { tree, baselineSha: baselineShaOf(fingerprint), fingerprint }
}
