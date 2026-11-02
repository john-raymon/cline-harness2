import { randomBytes } from "node:crypto"
import type { Stats } from "node:fs"
import { lstat, mkdir, rm } from "node:fs/promises"
import path from "node:path"

import type { HarnessTree } from "../domain/schemas.ts"
import { materialiseTree } from "../harness/tree-store.ts"
import { AdapterError } from "./errors.ts"

/**
 * The directory one bootstrap owns.
 *
 * A run directory is an identity, not a cache: it is created once, exclusively, and never reused. That
 * is what makes "which tree did this session see" answerable later, and it is why the id is validated
 * as strictly as a path component — it arrives from `--run-id` on a command line in Chunk 20, which
 * makes it an injection point rather than a convenience.
 *
 * Layout: `<root>/<runId>/harness/` holds the materialised tree and nothing else, so `readTree` over
 * it can never pick up a ledger file that a later chunk writes beside it.
 */

export const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
export const HARNESS_DIR_NAME = "harness"

export interface PreparedRunDir {
  readonly runId: string
  readonly runDir: string
  readonly harnessDir: string
  readonly files: readonly string[]
}

/** `20261102T080512Z-a1b2c3` — sortable, collision-resistant, and legal as a single path component. */
export function newRunId(now: Date = new Date(), random: () => string = defaultRandom): string {
  const stamp = `${now.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`
  const id = `${stamp}-${random()}`
  assertRunId(id)
  return id
}

export async function prepareRunDir(input: {
  rootDir: string
  runId: string
  tree: HarnessTree
}): Promise<PreparedRunDir> {
  assertRunId(input.runId)
  const rootDir = path.resolve(input.rootDir)
  await ensureOwnableRoot(rootDir)

  const runDir = path.join(rootDir, input.runId)
  try {
    // Non-recursive on purpose: the existence of the parent is already established, so an EEXIST here
    // can only mean this exact run id is taken.
    await mkdir(runDir)
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new AdapterError(
        "RUN_DIR_EXISTS",
        `${runDir} already exists; a run id is never reused — choose a new one, or remove that ` +
          "directory deliberately if it is stale",
        { cause: error },
      )
    }
    throw new AdapterError("RUN_ROOT_UNUSABLE", `could not create ${runDir}: ${describe(error)}`, {
      cause: error,
    })
  }

  const harnessDir = path.join(runDir, HARNESS_DIR_NAME)
  try {
    const { files } = await materialiseTree({ dir: harnessDir, tree: input.tree })
    return { runId: input.runId, runDir, harnessDir, files }
  } catch (error) {
    // Rollback is safe because this call created `runDir` itself, so the whole subtree is ours.
    // A failed rollback is not allowed to replace the real error, only to be mentioned by it.
    const leftover = await rm(runDir, { recursive: true, force: true }).then(
      () => "",
      (rollbackError: unknown) => ` (and rollback failed: ${describe(rollbackError)})`,
    )
    throw new AdapterError(
      "HARNESS_MATERIALISE_FAILED",
      `could not materialise the harness tree into ${harnessDir}: ${describe(error)}${leftover}`,
      { cause: error },
    )
  }
}

function assertRunId(runId: string): void {
  if (runId === "." || runId === ".." || !RUN_ID_PATTERN.test(runId)) {
    throw new AdapterError(
      "RUN_ROOT_UNUSABLE",
      `run id ${JSON.stringify(runId)} is not a safe path component: it must match ` +
        `${String(RUN_ID_PATTERN)} and must not be "." or ".."`,
    )
  }
}

/**
 * The run root is created if it is missing, and must be a real directory.
 *
 * A symlinked root is refused rather than resolved: the whole point of the root is that everything
 * below it belongs to this run, and a link means the operator pointed us at a place we did not create.
 */
async function ensureOwnableRoot(rootDir: string): Promise<void> {
  let stats: Stats | undefined
  try {
    stats = await lstat(rootDir)
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw new AdapterError(
        "RUN_ROOT_UNUSABLE",
        `could not inspect the run root ${rootDir}: ${describe(error)}`,
        { cause: error },
      )
    }
  }

  if (stats === undefined) {
    try {
      await mkdir(rootDir, { recursive: true })
      stats = await lstat(rootDir)
    } catch (error) {
      throw new AdapterError(
        "RUN_ROOT_UNUSABLE",
        `could not create the run root ${rootDir}: ${describe(error)}`,
        { cause: error },
      )
    }
  }

  if (stats.isSymbolicLink()) {
    throw new AdapterError(
      "RUN_ROOT_UNUSABLE",
      `the run root ${rootDir} is a symlink; refusing to write a run through a link`,
    )
  }
  if (!stats.isDirectory()) {
    throw new AdapterError("RUN_ROOT_UNUSABLE", `the run root ${rootDir} is not a directory`)
  }
}

function defaultRandom(): string {
  return randomBytes(3).toString("hex")
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null | undefined)?.code
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
