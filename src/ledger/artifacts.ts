import { randomBytes } from "node:crypto"
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { sessionBootstrapRecordSchema, type SessionBootstrapRecord } from "../adapter/session.ts"
import { canonicalJson, sha256Hex } from "../domain/canonical.ts"
import { LedgerError } from "./errors.ts"

/**
 * Persisted evidence for one probe, beside the ledger and never inside the harness.
 *
 * `<runDir>/artifacts/probe.json` holds the bootstrap record exactly as the session produced it. The
 * digest returned here is the digest of those bytes, so it identifies the artifact an operator can
 * open — not an in-memory object that might have been normalised on the way in.
 *
 * Publication is claim-then-rename. `rename` replaces silently, so an existence check alone would let
 * two publishers both "win"; an exclusive claim file is what turns "refuse to overwrite" into a
 * decision instead of a race. A crashed publisher leaves its claim behind, and the next attempt says
 * so rather than cleaning it up behind the operator's back.
 */

export const ARTIFACTS_DIR_NAME = "artifacts"
export const PROBE_ARTIFACT_NAME = "probe.json"
const PROBE_CLAIM_NAME = ".probe.claim"

export function artifactsDirOf(runDir: string): string {
  return path.join(path.resolve(runDir), ARTIFACTS_DIR_NAME)
}

export function probeArtifactPath(runDir: string): string {
  return path.join(artifactsDirOf(runDir), PROBE_ARTIFACT_NAME)
}

export interface ProbeArtifact {
  readonly path: string
  readonly sha256: string
}

export interface StoredProbeRecord extends ProbeArtifact {
  readonly record: SessionBootstrapRecord
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null | undefined)?.code
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function claim(pathname: string): Promise<void> {
  try {
    await writeFile(
      pathname,
      `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`,
      { flag: "wx" },
    )
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new LedgerError(
        "ARTIFACT_EXISTS",
        `${pathname} is already claimed: another writer is publishing this artifact, or a previous ` +
          "one crashed holding the claim. It is left in place for inspection; remove it deliberately",
        { cause: error },
      )
    }
    throw new LedgerError("ARTIFACT_WRITE_FAILED", `could not claim ${pathname}: ${describe(error)}`, {
      cause: error,
    })
  }
}

export async function writeProbeRecord(input: {
  runDir: string
  record: SessionBootstrapRecord
}): Promise<ProbeArtifact> {
  const parsed = sessionBootstrapRecordSchema.safeParse(input.record)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new LedgerError(
      "ARTIFACT_INVALID",
      `the probe record is not a bootstrap record: ${
        issue === undefined ? "no issue reported" : issue.message
      }`,
      { cause: parsed.error },
    )
  }

  const dir = artifactsDirOf(input.runDir)
  const target = probeArtifactPath(input.runDir)
  const claimPath = path.join(dir, PROBE_CLAIM_NAME)
  await mkdir(dir, { recursive: true })
  await claim(claimPath)

  const temp = path.join(dir, `.${PROBE_ARTIFACT_NAME}.${randomBytes(4).toString("hex")}.tmp`)
  try {
    const exists = await lstat(target).then(
      () => true,
      (error: unknown) => {
        if (errorCode(error) === "ENOENT") return false
        throw error
      },
    )
    if (exists) {
      throw new LedgerError(
        "ARTIFACT_EXISTS",
        `${target} already exists; a probe artifact is written once so the digest in the ledger keeps ` +
          "identifying the bytes it was taken from",
      )
    }

    const body = `${canonicalJson(parsed.data)}\n`
    await writeFile(temp, body, { flag: "wx" })
    await rename(temp, target)

    const sha256 = sha256Hex(body)
    // Read back what the filesystem actually holds: a truncated rename would otherwise be signed off
    // by a digest taken from a string in memory.
    const written = await readFile(target)
    if (sha256Hex(written) !== sha256) {
      throw new LedgerError(
        "ARTIFACT_WRITE_FAILED",
        `${target} does not contain the bytes that were written to it`,
      )
    }
    return { path: target, sha256 }
  } catch (error) {
    if (error instanceof LedgerError) throw error
    throw new LedgerError("ARTIFACT_WRITE_FAILED", `could not publish ${target}: ${describe(error)}`, {
      cause: error,
    })
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
    await rm(claimPath, { force: true }).catch(() => undefined)
  }
}

export async function readProbeRecord(input: { runDir: string }): Promise<StoredProbeRecord> {
  const target = probeArtifactPath(input.runDir)
  let bytes: Buffer
  try {
    bytes = await readFile(target)
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new LedgerError(
        "ARTIFACT_INVALID",
        `no probe artifact at ${target}; this run never persisted one`,
        { cause: error },
      )
    }
    throw new LedgerError("ARTIFACT_INVALID", `could not read ${target}: ${describe(error)}`, {
      cause: error,
    })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString("utf8"))
  } catch (error) {
    throw new LedgerError("ARTIFACT_INVALID", `${target} is not JSON: ${describe(error)}`, {
      cause: error,
    })
  }

  const validated = sessionBootstrapRecordSchema.safeParse(parsed)
  if (!validated.success) {
    const issue = validated.error.issues[0]
    const at =
      issue === undefined || issue.path.length === 0 ? "<root>" : issue.path.map(String).join(".")
    throw new LedgerError(
      "ARTIFACT_INVALID",
      `${target} does not match the bootstrap record schema at ${at}: ${
        issue === undefined ? "no issue reported" : issue.message
      }`,
      { cause: validated.error },
    )
  }

  return { path: target, sha256: sha256Hex(bytes), record: validated.data }
}
