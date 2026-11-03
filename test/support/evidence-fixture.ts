import { writeFile } from "node:fs/promises"

/**
 * A spike report good enough for the claim gate.
 *
 * The adapter now refuses to start a session without `B5.hooks` in the evidence, so every test and live
 * child needs a report. Writing one here rather than reading `.tmp/spike-evidence.json` keeps the suite
 * runnable on a fresh clone (that file is gitignored) while still going through the same gate: this is a
 * fixture for the *file format*, not a claim that the spike was run in this process.
 */

export const FIXTURE_SDK_VERSION = "0.2.0"

export const DEFAULT_FIXTURE_CLAIMS = ["B1.skills", "B2.plugin", "B5.hooks"] as const

export function evidenceReport(
  sdkVersion: string,
  claimIds: readonly string[] = DEFAULT_FIXTURE_CLAIMS,
): Record<string, unknown> {
  return {
    generatedAt: "2026-11-02T00:00:00.000Z",
    sdkVersion,
    claims: claimIds.map((id) => ({
      id,
      status: "verified",
      method: "core-scripted",
      observed: "test fixture",
    })),
  }
}

export async function writeEvidence(
  pathname: string,
  sdkVersion: string = FIXTURE_SDK_VERSION,
  claimIds: readonly string[] = DEFAULT_FIXTURE_CLAIMS,
): Promise<string> {
  await writeFile(pathname, `${JSON.stringify(evidenceReport(sdkVersion, claimIds), null, 2)}\n`, "utf8")
  return pathname
}
