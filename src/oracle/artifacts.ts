import { randomBytes } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

import { canonicalJson, sha256Hex } from "../domain/canonical.ts"
import { sha256HexSchema } from "../domain/schemas.ts"
import { artifactsDirOf } from "../ledger/artifacts.ts"
import { ARBITRATION_STATUSES } from "../ledger/events.ts"
import { OracleError } from "./errors.ts"
import { ORACLE_ROLES } from "./roles.ts"

/**
 * Where a dual-oracle probe is frozen.
 *
 * Content-addressed: the file is named after the digest of its own bytes, so the pointer in the ledger
 * *is* the filename and reading it back re-hashes what is on disk. That buys three things a fixed name
 * cannot. Writing the same pair twice is idempotent instead of an error, a tampered file is reported
 * rather than quoted, and an operator holding only a ledger line can find the evidence without a
 * second lookup table.
 *
 * Nothing here is redacted or summarised. The point of the artifact is that a disagreement can be read
 * in full by whoever has to decide what to do about it.
 */

export const ARBITRATION_ARTIFACT_VERSION = 1

const answerSchema = z.strictObject({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  transport: z.string().min(1),
  roleId: z.string().min(1),
  promptSha256: sha256HexSchema,
  chars: z.int().nonnegative(),
  latencyMs: z.int().nonnegative(),
  text: z.string().min(1),
})

const divergenceSchema = z.strictObject({
  /** 1-based line number of the first difference, so a reader does not have to diff two blobs. */
  line: z.int().positive(),
  primary: z.string(),
  secondary: z.string(),
})

export const arbitrationArtifactSchema = z
  .strictObject({
    version: z.literal(ARBITRATION_ARTIFACT_VERSION),
    status: z.enum(ARBITRATION_STATUSES),
    role: z.enum(ORACLE_ROLES),
    /** The question both oracles were asked, verbatim. */
    ask: z.string(),
    contextSha256: sha256HexSchema,
    /** One answer, or two when the second oracle answered. Order is primary, secondary. */
    answers: z.array(answerSchema).min(1).max(2),
    /** Why the second answer is missing, for `partial`. `null` when both answered. */
    failure: z.string().nullable(),
    divergence: divergenceSchema.nullable(),
  })
  .superRefine((artifact, ctx) => {
    // The three statuses describe three different bodies. Without this, a hand-edited artifact could
    // claim `agreed` while holding one answer, and the file an operator reads would contradict itself.
    const fail = (message: string): void => {
      ctx.addIssue({ code: "custom", path: ["status"], message })
    }
    if (artifact.status === "partial") {
      if (artifact.answers.length !== 1) fail("a partial probe holds exactly one answer")
      if (artifact.failure === null) fail("a partial probe must say why the second answer is missing")
      if (artifact.divergence !== null) fail("a partial probe compared nothing, so it has no divergence")
      return
    }
    if (artifact.answers.length !== 2) fail(`a ${artifact.status} probe holds both answers`)
    if (artifact.failure !== null) fail(`a ${artifact.status} probe has no failed call to explain`)
    if (artifact.status === "agreed" && artifact.divergence !== null) {
      fail("an agreed probe has no divergence")
    }
    if (artifact.status === "disagreed" && artifact.divergence === null) {
      fail("a disagreed probe must say where the answers diverge")
    }
  })

export type ArbitrationArtifact = z.infer<typeof arbitrationArtifactSchema>
export type ArbitrationArtifactAnswer = z.infer<typeof answerSchema>

export interface StoredArbitrationArtifact {
  readonly path: string
  readonly sha256: string
}

export function arbitrationArtifactName(sha256: string): string {
  return `arbitration-${sha256}.json`
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null | undefined)?.code
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Freeze one probe.
 *
 * The digest is taken from the exact body that is written, and the file is read back afterwards: a
 * rename that landed short must not be signed off by a hash computed from a string in memory.
 */
export async function writeArbitrationArtifact(input: {
  readonly runDir: string
  readonly artifact: ArbitrationArtifact
}): Promise<StoredArbitrationArtifact> {
  const parsed = arbitrationArtifactSchema.safeParse(input.artifact)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new OracleError(
      "ARBITRATION_ARTIFACT_INVALID",
      `the arbitration record is not a valid artifact: ${
        issue === undefined ? "no issue reported" : `${issue.path.join(".")}: ${issue.message}`
      }`,
      { cause: parsed.error },
    )
  }

  const body = `${canonicalJson(parsed.data)}\n`
  const sha256 = sha256Hex(body)
  const dir = artifactsDirOf(input.runDir)
  const target = path.join(dir, arbitrationArtifactName(sha256))
  await mkdir(dir, { recursive: true })

  const existing = await readFile(target).then(
    (bytes) => bytes,
    (error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined
      throw new OracleError("ARBITRATION_ARTIFACT_CORRUPT", `could not read ${target}: ${describe(error)}`, {
        cause: error,
      })
    },
  )
  if (existing !== undefined) {
    // Content-addressed, so a file already under this name must hold these bytes.
    if (sha256Hex(existing) !== sha256) {
      throw new OracleError(
        "ARBITRATION_ARTIFACT_CORRUPT",
        `${target} exists but does not hash to the digest in its own name; the artifact was edited ` +
          "after it was frozen",
      )
    }
    return { path: target, sha256 }
  }

  const temp = path.join(dir, `.${arbitrationArtifactName(sha256)}.${randomBytes(4).toString("hex")}.tmp`)
  try {
    await writeFile(temp, body, { flag: "wx" })
    await rename(temp, target)
  } catch (error) {
    throw new OracleError(
      "ARBITRATION_ARTIFACT_CORRUPT",
      `could not publish ${target}: ${describe(error)}`,
      { cause: error },
    )
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
  }

  const written = await readFile(target)
  if (sha256Hex(written) !== sha256) {
    throw new OracleError(
      "ARBITRATION_ARTIFACT_CORRUPT",
      `${target} does not contain the bytes that were written to it`,
    )
  }
  return { path: target, sha256 }
}

/** Read a frozen probe back, verifying it against the digest the ledger recorded. */
export async function readArbitrationArtifact(input: {
  readonly runDir: string
  readonly sha256: string
}): Promise<ArbitrationArtifact & StoredArbitrationArtifact> {
  // The digest becomes a filename, and it arrives from a ledger line an operator could have edited:
  // validating it here is what stops `../../some/file` from being read out of the artifact directory.
  if (!sha256HexSchema.safeParse(input.sha256).success) {
    throw new OracleError(
      "ARBITRATION_ARTIFACT_INVALID",
      `${JSON.stringify(input.sha256)} is not a sha256 digest, so it cannot name an artifact`,
    )
  }
  const target = path.join(artifactsDirOf(input.runDir), arbitrationArtifactName(input.sha256))
  const bytes = await readFile(target).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") {
      throw new OracleError(
        "ARBITRATION_ARTIFACT_MISSING",
        `the ledger names ${input.sha256} but ${target} does not exist; the evidence for that probe ` +
          "was never written or has been removed",
        { cause: error },
      )
    }
    throw new OracleError("ARBITRATION_ARTIFACT_CORRUPT", `could not read ${target}: ${describe(error)}`, {
      cause: error,
    })
  })

  const actual = sha256Hex(bytes)
  if (actual !== input.sha256) {
    throw new OracleError(
      "ARBITRATION_ARTIFACT_CORRUPT",
      `${target} hashes to ${actual}, not ${input.sha256}; the frozen probe no longer matches the ` +
        "pointer that cites it",
    )
  }

  let payload: unknown
  try {
    payload = JSON.parse(bytes.toString("utf8"))
  } catch (error) {
    throw new OracleError("ARBITRATION_ARTIFACT_INVALID", `${target} is not JSON despite matching its digest`, {
      cause: error,
    })
  }
  const parsed = arbitrationArtifactSchema.safeParse(payload)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new OracleError(
      "ARBITRATION_ARTIFACT_INVALID",
      `${target} is not an arbitration artifact: ${
        issue === undefined ? "no issue reported" : `${issue.path.join(".")}: ${issue.message}`
      }`,
      { cause: parsed.error },
    )
  }
  return { ...parsed.data, path: target, sha256: input.sha256 }
}
