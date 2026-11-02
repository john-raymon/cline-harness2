import type { Stats } from "node:fs"
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import {
  HarnessTreeError,
  TREE_LIMITS,
  assertMaterialisableTree,
  harnessTreeSchema,
  relPathSchema,
  type HarnessTree,
} from "../domain/schemas.ts"
import { ReadError, UTF8, readCappedText } from "./fs-read.ts"

/**
 * Filesystem adapter for a harness tree.
 *
 * Everything here assumes the session owns the directory: a fresh leaf is claimed exclusively, and
 * no other writer touches it while it is being filled or read. Portable Node path checks cannot
 * defend against a hostile concurrent writer, so that assumption is the actual boundary — see the
 * ownership note in `docs/ADAPTER.md`.
 *
 * There is deliberately no API that deletes an arbitrary path. Deleting a harness file is expressed
 * as `null` in a `TreePatch` and applied in memory, then the resulting tree is materialised into a
 * new directory. The only deletion here is rollback of a directory this call created.
 */

export type TreeStoreErrorCode =
  | "INVALID_PATH"
  | "NOT_MATERIALISABLE"
  | "DIR_EXISTS"
  | "NOT_A_DIRECTORY"
  | "SYMLINK_FORBIDDEN"
  | "HARDLINK_FORBIDDEN"
  | "UNSUPPORTED_ENTRY"
  | "NOT_UTF8"
  | "TOO_LARGE"
  | "TOO_MANY_FILES"
  | "MISSING_ROOT"
  | "WRITE_FAILED"
  | "READ_FAILED"

export class TreeStoreError extends Error {
  override readonly name = "TreeStoreError"
  readonly code: TreeStoreErrorCode
  readonly relPath: string | undefined
  /** Set only when rollback failed. The primary failure stays `cause`, never replaced. */
  readonly cleanupError: unknown

  constructor(
    code: TreeStoreErrorCode,
    message: string,
    options: {
      relPath?: string | undefined
      cause?: unknown
      cleanupError?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.relPath = options.relPath
    this.cleanupError = options.cleanupError
  }
}

const WRITE_CONCURRENCY = 8

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null | undefined)?.code
}

/**
 * Deterministic code-unit ordering.
 *
 * `localeCompare` follows the host locale, so the order — and therefore which invalid path is
 * reported first — would change with `LANG`. Anything that can reach a hash must not do that.
 */
function compareNames(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** Validate a tree before anything touches the disk, so a bad tree writes zero bytes. */
function requireMaterialisableTree(input: HarnessTree): HarnessTree {
  const parsed = harnessTreeSchema.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
    )
    throw new TreeStoreError("INVALID_PATH", `not a valid harness tree:\n  ${issues.join("\n  ")}`)
  }
  try {
    assertMaterialisableTree(parsed.data)
  } catch (error) {
    if (error instanceof HarnessTreeError) {
      throw new TreeStoreError("NOT_MATERIALISABLE", error.message, { cause: error })
    }
    throw error
  }
  return parsed.data
}

/**
 * Write a tree into a directory this call owns.
 *
 * The target must not exist: an existing directory cannot be claimed with exclusive `mkdir`, so
 * rollback could not tell our files from the operator's. Parents are created first, in one
 * deterministic pass, so the concurrent writers never race on `mkdir`.
 */
export async function materialiseTree(input: {
  dir: string
  tree: HarnessTree
}): Promise<{ dir: string; files: string[] }> {
  const dir = path.resolve(input.dir)
  const tree = requireMaterialisableTree(input.tree)
  const files = Object.keys(tree).sort()

  let existing: Stats | undefined
  try {
    existing = await lstat(dir)
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw new TreeStoreError("WRITE_FAILED", `could not inspect ${dir}`, { cause: error })
    }
  }
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) {
      throw new TreeStoreError("SYMLINK_FORBIDDEN", `${dir} is a symlink; refusing to write through it`)
    }
    throw new TreeStoreError(
      "DIR_EXISTS",
      `${dir} already exists; materialiseTree needs a directory it can own exclusively`,
    )
  }

  try {
    await mkdir(dir)
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new TreeStoreError("DIR_EXISTS", `${dir} appeared while being claimed; refusing to share it`, {
        cause: error,
      })
    }
    throw new TreeStoreError("NOT_A_DIRECTORY", `could not create ${dir}`, { cause: error })
  }

  try {
    await createImpliedDirectories(dir, tree)
    await writeFiles(dir, tree)
  } catch (error) {
    const cleanupError = await removeOwnedDirectory(dir)
    const code = error instanceof TreeStoreError ? error.code : "WRITE_FAILED"
    const message = error instanceof TreeStoreError ? error.message : `failed while writing ${dir}`
    const relPath = error instanceof TreeStoreError ? error.relPath : undefined
    throw new TreeStoreError(code, message, { relPath, cause: error, cleanupError })
  }

  return { dir, files }
}

async function createImpliedDirectories(root: string, tree: HarnessTree): Promise<void> {
  const directories = new Set<string>()
  for (const relPath of Object.keys(tree)) {
    const segments = relPath.split("/")
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"))
    }
  }
  // Shallowest first, then code-unit order: deterministic, and every parent precedes its child.
  const ordered = [...directories].sort(
    (left, right) => left.split("/").length - right.split("/").length || compareNames(left, right),
  )
  for (const relative of ordered) {
    try {
      await mkdir(path.join(root, relative))
    } catch (error) {
      throw new TreeStoreError("WRITE_FAILED", `could not create ${relative}`, {
        relPath: relative,
        cause: error,
      })
    }
  }
}

/**
 * Write every file with `wx` (fail if it exists) and bounded concurrency.
 *
 * `Promise.allSettled` is the point: after the first failure no new write starts, but the ones
 * already running are awaited before the caller rolls back, so cleanup cannot race live writers.
 */
async function writeFiles(root: string, tree: HarnessTree): Promise<void> {
  const entries = Object.entries(tree).sort(([left], [right]) => compareNames(left, right))
  let failure: unknown
  let cursor = 0

  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const entry = entries[cursor]
      cursor += 1
      if (entry === undefined) return
      const [relative, body] = entry
      try {
        await writeFile(path.join(root, relative), body, { flag: "wx", mode: 0o644 })
      } catch (error) {
        failure = new TreeStoreError("WRITE_FAILED", `could not write ${relative}`, {
          relPath: relative,
          cause: error,
        })
      }
    }
  }

  const width = Math.min(WRITE_CONCURRENCY, entries.length)
  await Promise.allSettled(Array.from({ length: width }, worker))
  if (failure !== undefined) throw failure
}

async function removeOwnedDirectory(dir: string): Promise<unknown> {
  try {
    await rm(dir, { recursive: true, force: true })
    return undefined
  } catch (error) {
    return error
  }
}

interface ReadCounters {
  files: number
  entries: number
  bytes: number
}

/**
 * Read a workspace back into a tree.
 *
 * Everything representable is included: the harness root belongs to the session, so a file the agent
 * created is part of the resulting harness, and filtering by "what we wrote" would silently discard
 * exactly the edits we are trying to measure.
 *
 * Anything unrepresentable is an error, never a skip. Skipping a symlinked `guardrails.md` would look
 * like the agent deleted it, and one bad name would turn a real edit into an untraceable no-op. The
 * tree returned here satisfies the same contract as the one that was written.
 */
export async function readTree(input: { dir: string }): Promise<HarnessTree> {
  const dir = path.resolve(input.dir)

  let root: Stats
  try {
    root = await lstat(dir)
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new TreeStoreError("MISSING_ROOT", `${dir} does not exist`, { cause: error })
    }
    throw new TreeStoreError("READ_FAILED", `could not inspect ${dir}`, { cause: error })
  }
  // `lstat` first: resolving with `realpath` would happily follow a symlinked root.
  if (root.isSymbolicLink()) {
    throw new TreeStoreError("SYMLINK_FORBIDDEN", `${dir} is a symlink; refusing to read through it`)
  }
  if (!root.isDirectory()) {
    throw new TreeStoreError("NOT_A_DIRECTORY", `${dir} is not a directory`)
  }

  const tree: HarnessTree = {}
  const counters: ReadCounters = { files: 0, entries: 0, bytes: 0 }
  await walk(dir, "", tree, counters)

  const parsed = harnessTreeSchema.safeParse(tree)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
    )
    throw new TreeStoreError(
      "INVALID_PATH",
      `read-back is not a valid harness tree:\n  ${issues.join("\n  ")}`,
    )
  }
  try {
    assertMaterialisableTree(parsed.data)
  } catch (error) {
    if (error instanceof HarnessTreeError) {
      throw new TreeStoreError("NOT_MATERIALISABLE", error.message, { cause: error })
    }
    throw error
  }
  return parsed.data
}

async function walk(
  dir: string,
  relative: string,
  tree: Record<string, string>,
  counters: ReadCounters,
): Promise<void> {
  const absolute = relative === "" ? dir : path.join(dir, relative)
  let children
  try {
    // Buffer names, decoded strictly below: the default string encoding replaces invalid bytes with
    // U+FFFD, so two different raw names on disk can decode onto one key and silently merge.
    children = await readdir(absolute, { withFileTypes: true, encoding: "buffer" })
  } catch (error) {
    throw new TreeStoreError("READ_FAILED", `could not list ${relative || "."}`, {
      relPath: relative || undefined,
      cause: error,
    })
  }

  if (children.length === 0) {
    // An empty root is a legitimately empty tree; an empty subdirectory has no representation.
    if (relative === "") return
    throw new TreeStoreError(
      "UNSUPPORTED_ENTRY",
      `${relative} is an empty directory; a harness tree cannot represent one`,
      { relPath: relative },
    )
  }

  const entries: Array<{ name: string; entry: (typeof children)[number] }> = []
  for (const entry of children) {
    let name: string
    try {
      name = UTF8.decode(entry.name)
    } catch (error) {
      throw new TreeStoreError(
        "NOT_UTF8",
        `${relative || "."} contains a filename that is not valid UTF-8`,
        { relPath: relative || undefined, cause: error },
      )
    }
    entries.push({ name, entry })
  }
  entries.sort((left, right) => compareNames(left.name, right.name))

  for (const { name, entry } of entries) {
    counters.entries += 1
    if (counters.entries > TREE_LIMITS.maxEntries) {
      throw new TreeStoreError(
        "TOO_MANY_FILES",
        `${dir} has more than ${TREE_LIMITS.maxEntries} entries`,
        { relPath: relative || undefined },
      )
    }
    const childRelative = relative === "" ? name : `${relative}/${name}`
    // Validate the name before it becomes a key, so a rejected name never enters the record.
    const validPath = relPathSchema.safeParse(childRelative)
    if (!validPath.success) {
      throw new TreeStoreError(
        "INVALID_PATH",
        `${childRelative}: ${validPath.error.issues[0]?.message ?? "invalid path"}`,
        { relPath: childRelative },
      )
    }
    if (entry.isSymbolicLink()) {
      throw new TreeStoreError(
        "SYMLINK_FORBIDDEN",
        `${childRelative} is a symlink; a harness tree contains regular files only`,
        { relPath: childRelative },
      )
    }
    if (entry.isDirectory()) {
      await walk(dir, childRelative, tree, counters)
      continue
    }
    if (!entry.isFile()) {
      throw new TreeStoreError("UNSUPPORTED_ENTRY", `${childRelative} is not a regular file`, {
        relPath: childRelative,
      })
    }

    counters.files += 1
    if (counters.files > TREE_LIMITS.maxFiles) {
      throw new TreeStoreError("TOO_MANY_FILES", `${dir} has more than ${TREE_LIMITS.maxFiles} files`, {
        relPath: childRelative,
      })
    }
    const file = await readFileCapped(path.join(dir, childRelative), childRelative)
    counters.bytes += file.bytes
    if (counters.bytes > TREE_LIMITS.maxTotalBytes) {
      throw new TreeStoreError(
        "TOO_LARGE",
        `${dir} is larger than the ${TREE_LIMITS.maxTotalBytes}-byte tree limit`,
        { relPath: childRelative },
      )
    }
    tree[childRelative] = file.body
  }
}

/**
 * Read a regular file for a directory this store owns.
 *
 * The hardening lives in `fs-read.ts`, which is shared with the baseline capture. This wrapper only
 * translates its error type so callers of the tree store keep seeing `TreeStoreError`, and keeps the
 * store's own policy: a scratch harness tree contains single-link files, so a hardlink is refused.
 */
async function readFileCapped(
  absolute: string,
  relative: string,
): Promise<{ body: string; bytes: number }> {
  try {
    const result = await readCappedText(absolute, {
      relPath: relative,
      maxBytes: TREE_LIMITS.maxFileBytes,
      allowHardlink: false,
    })
    return { body: result.body, bytes: result.bytes }
  } catch (error) {
    if (error instanceof ReadError) {
      throw new TreeStoreError(error.code, error.message, { relPath: error.relPath, cause: error })
    }
    throw error
  }
}

