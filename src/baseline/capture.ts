import { execFile } from "node:child_process"
import type { Stats } from "node:fs"
import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises"
import path from "node:path"

import {
  HarnessTreeError,
  TREE_LIMITS,
  assertMaterialisableTree,
  harnessTreeSchema,
  relPathSchema,
  type HarnessTree,
} from "../domain/schemas.ts"
import { ReadError, UTF8, readCappedText, type ReadCappedTextResult, identityOf, sameIdentity } from "../harness/fs-read.ts"
import {
  DEFAULT_COMPONENTS,
  validateComponents,
  type CanonicalSource,
  type ComponentSpec,
} from "./components.ts"
import { BaselineError, type BaselineErrorCode } from "./errors.ts"
import {
  baselineFingerprint,
  baselineShaOf,
  type BaselineFingerprint,
  type ManifestEntry,
  type SsotAssociation,
} from "./fingerprint.ts"

/**
 * Capture the harness of a repository the session does not own.
 *
 * Two decisions shape everything here:
 *
 * 1. **Whitelist, not filter.** Only declared component paths are visited, so `node_modules/` and
 *    `.git/` are never entered because they are not components — not because a skip list remembered
 *    them. Anything skipped *inside* a component is reported in `excluded`, because a silent skip
 *    would look like a deleted file downstream.
 * 2. **Bodies, not links, in the tree.** A `HarnessTree` is text, and `materialiseTree` writes regular
 *    files. A symlinked rule file is therefore read through, and the link itself is recorded as
 *    provenance (`origin` + `canonical`) so `e_0` still says which canonical file produced the body.
 *
 * Capture is read-only and not atomic. It assumes quiescent sources: an ordinary mid-read edit is
 * detected by re-`lstat`ing after the read, but a hostile concurrent writer is out of scope, exactly as
 * it is for the tree store.
 */

export const MAX_SYMLINK_HOPS = 8

/** The only SSOT subtree an undeclared link may resolve into. */
const SSOT_RULES_SUBTREE = ".clinerules"

/** Entries skipped inside a component, compared case-insensitively. */
const IGNORED_NAMES: ReadonlySet<string> = new Set([".ds_store", ".git", "node_modules", ".tmp"])

const LOCKFILE_NAME = "pnpm-lock.yaml"
const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024
const GIT_TIMEOUT_MS = 10_000
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024

/**
 * Path separator, as a splitter.
 *
 * POSIX treats `\\` as an ordinary filename character, so splitting on it there would silently turn
 * the single name `real\\rules.md` into the two-component path `real/rules.md`.
 */
const PATH_SEPARATOR = path.sep === "/" ? /\// : /[\\/]+/

function splitPath(value: string): string[] {
  return value.split(PATH_SEPARATOR).filter((segment) => segment !== "" && segment !== ".")
}

/**
 * Sentinel for "the component before me must be a directory".
 *
 * `file.md/.` and `file.md/` both mean the same thing to the kernel — `ENOTDIR` — while `file.md`
 * means the file itself. `splitPath` drops the `.` and the empty tail, so the requirement is recorded
 * separately instead of being thrown away. NUL cannot appear in a filename, so this cannot collide.
 */
const DIRECTORY_MARKER = "\u0000directory"

function demandsDirectory(pointer: string): boolean {
  return pointer === "." || pointer.endsWith(path.sep) || pointer.endsWith(`${path.sep}.`)
}

/** Safety bound on total link expansions, independent of how many are inside an authorised root. */
const MAX_SYMLINK_EXPANSIONS = MAX_SYMLINK_HOPS * 8

export type FileOrigin =
  | { readonly kind: "regular"; readonly root: "repo" | "ssot" }
  | {
      readonly kind: "symlink"
      readonly hops: number
      readonly resolved: { readonly root: "repo" | "ssot"; readonly rootRelPath: string }
    }

/** A captured file that a component declared a canonical SSOT counterpart for. */
export interface CanonicalLink {
  readonly root: "ssot"
  readonly rootRelPath: string
  readonly sha256: string
  /** False only for a generated copy whose bytes have drifted from the canonical file. */
  readonly identical: boolean
}

export interface FileRecord {
  readonly relPath: string
  readonly sha256: string
  readonly origin: FileOrigin
  readonly canonical?: CanonicalLink
  /** Recorded for provenance; never hashed. `pnpm` hardlinks are legitimate in a repository. */
  readonly hardlinked?: true
}

export type ExclusionReason = "ignored-name" | "pruned-directory" | "empty-directory"

export interface Exclusion {
  readonly relPath: string
  readonly reason: ExclusionReason
}

export interface GitMetadata {
  readonly baseSha: string
  /**
   * Tracked index/worktree changes, excluding submodules.
   *
   * This says nothing about untracked files, and two different dirty states share the same `isDirty`,
   * so the fingerprint identifies the captured harness plus a commit and coarse dirtiness — not a
   * reproducible whole-repository state.
   */
  readonly dirty: readonly string[]
  readonly dependencyLockHash: string | null
  readonly toplevelMatches: boolean
}

export interface EffectiveComponent {
  readonly id: string
  readonly path: string
  readonly kind: "file" | "directory"
  readonly required: boolean
  readonly present: boolean
  readonly files: number
}

export interface BaselineCapture {
  readonly version: 1
  readonly tree: HarnessTree
  readonly files: readonly FileRecord[]
  readonly components: readonly EffectiveComponent[]
  readonly excluded: readonly Exclusion[]
  readonly git: GitMetadata
  readonly fingerprint: BaselineFingerprint
  readonly baselineSha: string
}

export interface CaptureInput {
  readonly repoDir: string
  /** Root of the operator's single source of truth for rules (`cline-config`). */
  readonly ssotRoot: string
  readonly components?: readonly ComponentSpec[]
}

interface WalkCounters {
  files: number
  entries: number
  bytes: number
}

interface WalkState {
  readonly repoRoot: string
  readonly ssotRoot: string | null
  readonly tree: HarnessTree
  readonly files: FileRecord[]
  readonly excluded: Exclusion[]
  readonly associations: SsotAssociation[]
  readonly counters: WalkCounters
}

interface Classification {
  readonly root: "repo" | "ssot"
  readonly rootRelPath: string
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null | undefined)?.code
}

/** Code-unit ordering: `localeCompare` would make the result depend on `LANG`. */
function compare(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function decodeName(bytes: Buffer, relative: string): string {
  try {
    return UTF8.decode(bytes)
  } catch (error) {
    throw new BaselineError("NOT_UTF8", `${relative} contains a filename that is not valid UTF-8`, {
      relPath: relative,
      cause: error,
    })
  }
}

/**
 * Path of `target` relative to `root`, or `null` when it is not inside.
 *
 * `path.relative` on two *resolved* paths is the only portable containment check: a plain
 * `startsWith(root)` accepts `/root-evil` for `/root`, and on Windows the two arguments can sit on
 * different drives, which `relative` reports as an absolute path.
 */
function relativeWithin(root: string, target: string): string | null {
  const relative = path.relative(root, target)
  if (relative === "") return null
  if (path.isAbsolute(relative)) return null
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) return null
  return relative.split(path.sep).join("/")
}

function hasExcludedSegment(relative: string): boolean {
  return relative.split("/").some((segment) => IGNORED_NAMES.has(segment.toLowerCase()))
}

/**
 * True when `target` is `root` itself or lives under it.
 *
 * `relativeWithin` deliberately returns `null` for the root itself, because a directory is not a file
 * inside itself; the hop counter needs the weaker "at or under" question.
 */
function isAtOrInside(root: string, target: string): boolean {
  return target === root || relativeWithin(root, target) !== null
}

function isIgnoredName(name: string): boolean {
  return IGNORED_NAMES.has(name.toLowerCase())
}

/** Resolve a directory the caller named, refusing anything that is not one. */
async function requireDirectory(dir: string): Promise<string> {
  let info: Stats
  try {
    info = await stat(dir)
  } catch (error) {
    throw new BaselineError("NOT_A_DIRECTORY", `${dir} does not exist`, { cause: error })
  }
  if (!info.isDirectory()) {
    throw new BaselineError("NOT_A_DIRECTORY", `${dir} is not a directory`)
  }
  try {
    return await realpath(dir)
  } catch (error) {
    throw new BaselineError("READ_FAILED", `could not resolve ${dir}`, { cause: error })
  }
}

/** Resolve an optional directory; `null` means it is absent, which disables canonical sources. */
async function resolveIfPresent(dir: string): Promise<string | null> {
  let info: Stats
  try {
    info = await stat(dir)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null
    throw new BaselineError("READ_FAILED", `could not inspect ${dir}`, { cause: error })
  }
  if (!info.isDirectory()) {
    throw new BaselineError("NOT_A_DIRECTORY", `${dir} is not a directory`)
  }
  try {
    return await realpath(dir)
  } catch (error) {
    throw new BaselineError("READ_FAILED", `could not resolve ${dir}`, { cause: error })
  }
}

function readGuarded(
  absolute: string,
  relPath: string,
  maxBytes: number = TREE_LIMITS.maxFileBytes,
): Promise<ReadCappedTextResult> {
  return readCappedText(absolute, {
    relPath,
    maxBytes,
    allowHardlink: true,
  }).catch((error: unknown) => {
    if (error instanceof ReadError) {
      throw new BaselineError(error.code as BaselineErrorCode, error.message, {
        relPath: error.relPath,
        cause: error,
      })
    }
    throw error
  })
}

/**
 * Read a file whose digest will reach the fingerprint, and prove it did not change.
 *
 * Three identities are compared: the `lstat` before opening, the descriptor that was actually read,
 * and the `lstat` after closing. The middle one is what makes this more than a double check — it
 * catches a file replaced between the caller's `lstat` and the `open`, which `O_NOFOLLOW` alone does
 * not, and it means the bytes that were hashed are the bytes that were validated.
 */
async function readStable(
  absolute: string,
  relPath: string,
  maxBytes: number = TREE_LIMITS.maxFileBytes,
): Promise<ReadCappedTextResult> {
  const before = await lstatForRead(absolute, relPath)
  const result = await readGuarded(absolute, relPath, maxBytes)
  const after = await lstatForRead(absolute, relPath)
  if (
    !sameIdentity(identityOf(before), result.identity) ||
    !sameIdentity(identityOf(after), result.identity)
  ) {
    throw new BaselineError("SOURCE_CHANGED", `${relPath} changed while being read`, { relPath })
  }
  return result
}

async function lstatForRead(absolute: string, relPath: string): Promise<Stats> {
  try {
    return await lstat(absolute)
  } catch (error) {
    throw new BaselineError("SOURCE_CHANGED", `${relPath} disappeared while being read`, {
      relPath,
      cause: error,
    })
  }
}

async function statTarget(absolute: string, relPath: string): Promise<Stats> {
  try {
    return await stat(absolute)
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new BaselineError("SYMLINK_UNRESOLVED", `${relPath} points at a path that does not exist`, {
        relPath,
        cause: error,
      })
    }
    throw new BaselineError("READ_FAILED", `could not inspect ${relPath}`, { relPath, cause: error })
  }
}

/**
 * Capture `e_0` for one repository.
 *
 * The manifest is validated before any I/O, the tree is validated before it is returned, and the
 * fingerprint is derived from those validated values only — so a capture that returns is a capture
 * that could be written to a directory and compared against another one.
 */
export async function captureBaseline(input: CaptureInput): Promise<BaselineCapture> {
  const components = validateComponents(input.components ?? DEFAULT_COMPONENTS)
  const repoRoot = await requireDirectory(input.repoDir)
  const ssotRoot = await resolveIfPresent(input.ssotRoot)
  const git = await readGitMetadata(input.repoDir, repoRoot)

  const state: WalkState = {
    repoRoot,
    ssotRoot,
    tree: {},
    files: [],
    excluded: [],
    associations: [],
    counters: { files: 0, entries: 0, bytes: 0 },
  }

  const effective: EffectiveComponent[] = []
  for (const component of components) {
    const byDestination = new Map<string, CanonicalSource>()
    for (const mapping of component.canonicalSources ?? []) {
      byDestination.set(mapping.destination, mapping)
    }
    effective.push(await captureComponent(state, component, byDestination))
  }

  const parsed = harnessTreeSchema.safeParse(state.tree)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
    )
    throw new BaselineError(
      "INVALID_PATH",
      `captured tree is not a valid harness tree:\n  ${issues.join("\n  ")}`,
    )
  }
  try {
    assertMaterialisableTree(parsed.data)
  } catch (error) {
    if (error instanceof HarnessTreeError) {
      throw new BaselineError("NOT_MATERIALISABLE", error.message, { cause: error })
    }
    throw error
  }

  const manifest: ManifestEntry[] = effective.map((component) => ({
    id: component.id,
    path: component.path,
    kind: component.kind,
    required: component.required,
    present: component.present,
  }))
  const fingerprint = baselineFingerprint({
    manifest,
    baseSha: git.baseSha,
    dirty: git.dirty,
    dependencyLockHash: git.dependencyLockHash,
    tree: parsed.data,
    associations: state.associations,
  })

  return {
    version: 1,
    tree: parsed.data,
    files: [...state.files].sort((left, right) => compare(left.relPath, right.relPath)),
    components: effective,
    excluded: [...state.excluded].sort((left, right) => compare(left.relPath, right.relPath)),
    git,
    fingerprint,
    baselineSha: baselineShaOf(fingerprint),
  }
}

async function captureComponent(
  state: WalkState,
  component: ComponentSpec,
  byDestination: Map<string, CanonicalSource>,
): Promise<EffectiveComponent> {
  const summary = {
    id: component.id,
    path: component.path,
    kind: component.kind,
    required: component.required === true,
  }
  const located = await locateComponent(
    state,
    component,
    component.kind === "file" && byDestination.has(component.path),
  )
  if (located === null) {
    if (summary.required) {
      throw new BaselineError(
        "MISSING_COMPONENT",
        `required component ${component.id} (${component.path}) does not exist`,
        { relPath: component.path },
      )
    }
    return { ...summary, present: false, files: 0 }
  }

  const before = state.files.length
  if (component.kind === "file") {
    if (located.linkPath !== null) {
      // Still a link at the filesystem level, even though `located.absolute` is its target.
      await captureLink(state, located.linkPath, component.path, byDestination)
    } else {
      const info = await lstat(located.absolute).catch((error: unknown) => {
        throw new BaselineError("READ_FAILED", `could not inspect ${component.path}`, {
          relPath: component.path,
          cause: error,
        })
      })
      if (!info.isFile()) {
        throw new BaselineError(
          "UNSUPPORTED_ENTRY",
          `${component.path} is declared as a file but is not one`,
          { relPath: component.path },
        )
      }
      await captureRegular(
        state,
        located.absolute,
        component.path,
        info,
        located.root,
        byDestination,
      )
    }
  } else {
    const info = await statTarget(located.absolute, component.path)
    if (!info.isDirectory()) {
      throw new BaselineError("NOT_A_DIRECTORY", `${component.path} is not a directory`, {
        relPath: component.path,
      })
    }
    await walkDirectory(
      state,
      located.absolute,
      component.path,
      located.root,
      component,
      byDestination,
    )
  }

  return { ...summary, present: true, files: state.files.length - before }
}

/**
 * Resolve a component path one segment at a time.
 *
 * `realpath` alone would follow a symlinked *ancestor* without saying so: `.cline/skills` where
 * `.cline` points outside the repository would silently capture foreign bytes. Walking the segments
 * means each hop is authorised by the same rule as a leaf link.
 */
async function locateComponent(
  state: WalkState,
  component: ComponentSpec,
  declaredForLeaf: boolean,
): Promise<{ absolute: string; linkPath: string | null; root: "repo" | "ssot" } | null> {
  const segments = component.path.split("/")
  let current = state.repoRoot
  let root: "repo" | "ssot" = "repo"
  let linkPath: string | null = null

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (segment === undefined) break
    // `current` is always canonical: the repo root was `realpath`ed, and a followed link is replaced
    // by its resolved target. So `lstat` here never depends on an unread ancestor.
    const candidate = path.join(current, segment)
    const last = index === segments.length - 1

    let info: Stats
    try {
      info = await lstat(candidate)
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null
      if (errorCode(error) === "ELOOP") {
        throw new BaselineError("SYMLINK_CYCLE", `${component.path} is part of a symlink cycle`, {
          relPath: component.path,
        })
      }
      throw new BaselineError("READ_FAILED", `could not inspect ${component.path}`, {
        relPath: component.path,
        cause: error,
      })
    }

    if (info.isSymbolicLink()) {
      const resolved = await resolvePath(state, candidate, component.path)
      const classification = classifyTarget(
        state,
        resolved.target,
        component.path,
        declaredForLeaf && last,
      )
      const target = await statTarget(resolved.target, component.path)
      if (!last && !target.isDirectory()) {
        throw new BaselineError(
          "NOT_A_DIRECTORY",
          `${component.path} passes through a link to something that is not a directory`,
          { relPath: component.path },
        )
      }
      current = resolved.target
      root = classification.root
      // Only a symlinked *leaf* is a link the caller must capture as a link. An ancestor link is part
      // of resolution, and handing its path on would capture the directory instead of the file.
      if (last) linkPath = candidate
      continue
    }

    if (!last && !info.isDirectory()) {
      throw new BaselineError(
        "NOT_A_DIRECTORY",
        `${segment} inside ${component.path} is not a directory`,
        { relPath: component.path },
      )
    }
    current = candidate
  }

  return { absolute: current, linkPath, root }
}


async function walkDirectory(
  state: WalkState,
  absoluteDir: string,
  relativeDir: string,
  root: "repo" | "ssot",
  component: ComponentSpec,
  byDestination: Map<string, CanonicalSource>,
): Promise<void> {
  let names: Buffer[]
  try {
    names = await readdir(absoluteDir, { encoding: "buffer" })
  } catch (error) {
    throw new BaselineError("READ_FAILED", `could not list ${relativeDir}`, {
      relPath: relativeDir,
      cause: error,
    })
  }

  const decoded = names.map((bytes) => decodeName(bytes, relativeDir)).sort(compare)
  if (decoded.length === 0) {
    // An empty component root is a real state (a repo may declare `.cline/skills` before adding
    // skills). A nested empty directory has no representation in a tree, so it is reported rather
    // than silently vanishing.
    if (relativeDir !== component.path) {
      state.excluded.push({ relPath: relativeDir, reason: "empty-directory" })
    }
    return
  }

  for (const name of decoded) {
    state.counters.entries += 1
    if (state.counters.entries > TREE_LIMITS.maxEntries) {
      throw new BaselineError(
        "TOO_MANY_FILES",
        `${relativeDir} walked past the ${TREE_LIMITS.maxEntries}-entry limit`,
        { relPath: relativeDir },
      )
    }

    const childRelative = `${relativeDir}/${name}`
    const valid = relPathSchema.safeParse(childRelative)
    if (!valid.success) {
      throw new BaselineError(
        "INVALID_PATH",
        `${childRelative}: ${valid.error.issues[0]?.message ?? "invalid path"}`,
        { relPath: childRelative },
      )
    }

    const absoluteChild = path.join(absoluteDir, name)
    let info: Stats
    try {
      info = await lstat(absoluteChild)
    } catch (error) {
      throw new BaselineError("READ_FAILED", `could not inspect ${childRelative}`, {
        relPath: childRelative,
        cause: error,
      })
    }

    if (isIgnoredName(name)) {
      state.excluded.push({
        relPath: childRelative,
        reason: info.isDirectory() ? "pruned-directory" : "ignored-name",
      })
      continue
    }
    if (info.isSymbolicLink()) {
      await captureLink(state, absoluteChild, childRelative, byDestination)
      continue
    }
    if (info.isDirectory()) {
      await walkDirectory(state, absoluteChild, childRelative, root, component, byDestination)
      continue
    }
    if (!info.isFile()) {
      // FIFOs, sockets and device nodes land here, before any `open()`: reading a FIFO would block
      // forever, so the type is checked rather than discovered by hanging.
      throw new BaselineError("UNSUPPORTED_ENTRY", `${childRelative} is not a regular file`, {
        relPath: childRelative,
      })
    }
    await captureRegular(state, absoluteChild, childRelative, info, root, byDestination)
  }
}

async function captureRegular(
  state: WalkState,
  absolute: string,
  relPath: string,
  info: Stats,
  root: "repo" | "ssot",
  byDestination: Map<string, CanonicalSource>,
): Promise<void> {
  if ((info.mode & 0o111) !== 0) {
    // A tree carries text, not modes, and `materialiseTree` writes `0o644`. Refusing is loud;
    // capturing and then materialising would silently drop the bit and change what runs.
    throw new BaselineError(
      "EXECUTABLE_FORBIDDEN",
      `${relPath} is executable; a harness tree cannot carry its mode`,
      { relPath },
    )
  }

  countFile(state, relPath)
  const read = await readStable(absolute, relPath)
  countBytes(state, read.bytes, relPath)

  state.tree[relPath] = read.body
  const canonical = await canonicalFor(state, relPath, read.sha256, absolute, "regular", byDestination)
  if (canonical === undefined && root === "ssot" && state.ssotRoot !== null) {
    // The file physically lives in the SSOT because a whole component directory was linked there.
    // That is still provenance, so it is recorded and hashed rather than implied by `root`.
    const sourcePath = relativeWithin(state.ssotRoot, absolute)
    if (sourcePath !== null) {
      state.associations.push({
        destination: relPath,
        sourceRoot: "ssot",
        sourcePath,
        sourceSha256: read.sha256,
      })
    }
  }
  state.files.push({
    relPath,
    sha256: read.sha256,
    origin: { kind: "regular", root },
    ...(canonical === undefined ? {} : { canonical }),
    ...(read.nlink > 1 ? { hardlinked: true as const } : {}),
  })
}

async function captureLink(
  state: WalkState,
  absolute: string,
  relPath: string,
  byDestination: Map<string, CanonicalSource>,
): Promise<void> {
  const resolved = await resolvePath(state, absolute, relPath)
  const declared = byDestination.has(relPath)
  const classification = classifyTarget(state, resolved.target, relPath, declared)
  const info = await statTarget(resolved.target, relPath)
  if (!info.isFile()) {
    throw new BaselineError(
      "UNSUPPORTED_ENTRY",
      `${relPath} links to something that is not a regular file`,
      { relPath },
    )
  }
  if ((info.mode & 0o111) !== 0) {
    throw new BaselineError(
      "EXECUTABLE_FORBIDDEN",
      `${relPath} links to an executable; a harness tree cannot carry its mode`,
      { relPath },
    )
  }

  countFile(state, relPath)
  // The resolved path is what gets opened, and `readCappedText` opens with `O_NOFOLLOW`, so a leaf
  // swapped for another link after resolution fails closed instead of redirecting the read.
  const read = await readStable(resolved.target, relPath)
  countBytes(state, read.bytes, relPath)

  state.tree[relPath] = read.body
  const canonical = await canonicalFor(
    state,
    relPath,
    read.sha256,
    resolved.target,
    "symlink",
    byDestination,
  )
  if (canonical === undefined && classification.root === "ssot") {
    // Undeclared, but still provenance: the operator can see exactly which SSOT file backed the body.
    state.associations.push({
      destination: relPath,
      sourceRoot: "ssot",
      sourcePath: classification.rootRelPath,
      sourceSha256: read.sha256,
    })
  }
  state.files.push({
    relPath,
    sha256: read.sha256,
    origin: { kind: "symlink", hops: resolved.hops, resolved: classification },
    ...(canonical === undefined ? {} : { canonical }),
    ...(read.nlink > 1 ? { hardlinked: true as const } : {}),
  })
}

function countFile(state: WalkState, relPath: string): void {
  state.counters.files += 1
  if (state.counters.files > TREE_LIMITS.maxFiles) {
    throw new BaselineError(
      "TOO_MANY_FILES",
      `capture passed the ${TREE_LIMITS.maxFiles}-file limit`,
      { relPath },
    )
  }
}

function countBytes(state: WalkState, bytes: number, relPath: string): void {
  state.counters.bytes += bytes
  if (state.counters.bytes > TREE_LIMITS.maxTotalBytes) {
    throw new BaselineError(
      "TOO_LARGE",
      `capture passed the ${TREE_LIMITS.maxTotalBytes}-byte tree limit`,
      { relPath },
    )
  }
}

/**
 * Resolve a path one component at a time, in filesystem order.
 *
 * `path.resolve(dirname, pointer)` is not good enough. For `alias/../rules.md`, where `alias` is a
 * symlink to `real/subdir`, the kernel reaches `real/rules.md` while lexical normalisation picks
 * `rules.md` beside the link — a different file, silently. So the path is consumed component by
 * component, `..` pops the *resolved* stack, and every hop is counted and cycle-checked. That also
 * means an intermediate symlinked directory cannot smuggle an unread path past the hop limit.
 */
async function resolvePath(
  state: WalkState,
  absolute: string,
  relPath: string,
): Promise<{ target: string; hops: number }> {
  const root = path.parse(absolute).root
  const floor = root === "" ? 0 : 1
  let stack: string[] = root === "" ? [] : [root]
  let queue = splitPath(absolute.slice(root.length))
  // Links whose expansion is still being consumed, outermost first.
  const active: Array<{ candidate: string; baseQueueLength: number }> = []
  let hops = 0
  let expansions = 0

  while (queue.length > 0) {
    // A link's expansion is finished once the queue shrinks back to where it was spliced in, so a
    // later revisit of the same link from a different position is not mistaken for a cycle.
    while (active.length > 0 && queue.length <= (active.at(-1)?.baseQueueLength ?? 0)) active.pop()
    const segment = queue.shift()
    if (segment === undefined) break
    if (segment === DIRECTORY_MARKER) continue
    if (segment === "..") {
      if (stack.length > floor) stack.pop()
      continue
    }

    const candidate = path.join(...stack, segment)
    let info: Stats
    try {
      info = await lstat(candidate)
    } catch (error) {
      const code = errorCode(error)
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new BaselineError(
          "SYMLINK_UNRESOLVED",
          `${relPath} points at ${candidate}, which does not exist`,
          { relPath, cause: error },
        )
      }
      if (code === "ELOOP") {
        throw new BaselineError("SYMLINK_CYCLE", `${relPath} is part of a symlink cycle`, {
          relPath,
        })
      }
      throw new BaselineError("READ_FAILED", `could not inspect ${relPath}`, {
        relPath,
        cause: error,
      })
    }

    if (!info.isSymbolicLink()) {
      // A component that still has segments after it must be a directory, exactly as the kernel
      // would report `ENOTDIR`. Accepting `file.md/../x` would read a path the kernel cannot open.
      if (queue.length > 0 && !info.isDirectory()) {
        throw new BaselineError(
          "SYMLINK_UNRESOLVED",
          `${relPath} passes through ${candidate}, which is not a directory`,
          { relPath },
        )
      }
      stack.push(segment)
      continue
    }

    // Only hops inside an authorised root are counted. System aliases above the roots (`/var` on
    // macOS is a symlink to `/private/var`) would otherwise make the count depend on the host, and
    // they are not something a repository can use to deepen a chain.
    const parent = path.join(...stack)
    const insideAuthorised =
      isAtOrInside(state.repoRoot, parent) ||
      (state.ssotRoot !== null && isAtOrInside(state.ssotRoot, parent))
    if (insideAuthorised) {
      hops += 1
      if (hops > MAX_SYMLINK_HOPS) {
        throw new BaselineError(
          "SYMLINK_TOO_DEEP",
          `${relPath} follows more than ${MAX_SYMLINK_HOPS} links`,
          { relPath },
        )
      }
    }
    // A cycle means revisiting a link that is still expanding. Keying on the link alone would reject
    // `alias/../alias/rules.md`; keying on the queue length would miss `a -> a/b`, which deepens the
    // queue on every pass. The active stack answers exactly the question being asked.
    expansions += 1
    if (expansions > MAX_SYMLINK_EXPANSIONS) {
      throw new BaselineError(
        "SYMLINK_TOO_DEEP",
        `${relPath} expands more than ${MAX_SYMLINK_EXPANSIONS} links`,
        { relPath },
      )
    }
    if (active.some((entry) => entry.candidate === candidate)) {
      throw new BaselineError("SYMLINK_CYCLE", `${relPath} is part of a symlink cycle`, { relPath })
    }
    active.push({ candidate, baseQueueLength: queue.length })

    let pointer: string
    try {
      pointer = await readlink(candidate)
    } catch (error) {
      throw new BaselineError("SYMLINK_UNRESOLVED", `could not read the link at ${candidate}`, {
        relPath,
        cause: error,
      })
    }
    if (path.isAbsolute(pointer)) stack = root === "" ? [] : [root]
    queue = [
      ...splitPath(pointer),
      ...(demandsDirectory(pointer) ? [DIRECTORY_MARKER] : []),
      ...queue,
    ]
  }

  return { target: path.join(...stack), hops }
}


/**
 * Decide which authorised root a resolved target belongs to.
 *
 * Both roots are already `realpath`-resolved, so a macOS `/var` → `/private/var` alias cannot look
 * like an escape. An undeclared link may only reach the SSOT's `.clinerules/` subtree (or that
 * directory itself, which is how a whole rules directory gets linked); a *declared* destination may
 * name any SSOT file, because the mapping is exact and is identity-checked afterwards. Excluded
 * directories are refused on both sides — a link is not a way around the prune.
 */
function classifyTarget(
  state: WalkState,
  target: string,
  relPath: string,
  declared: boolean,
): Classification {
  const repoRelative = relativeWithin(state.repoRoot, target)
  if (repoRelative !== null) {
    if (hasExcludedSegment(repoRelative)) {
      throw new BaselineError(
        "LINK_INTO_EXCLUDED",
        `${relPath} resolves into excluded ${repoRelative}`,
        { relPath },
      )
    }
    return { root: "repo", rootRelPath: repoRelative }
  }

  if (state.ssotRoot !== null) {
    const ssotRelative = relativeWithin(state.ssotRoot, target)
    if (ssotRelative !== null) {
      if (hasExcludedSegment(ssotRelative)) {
        throw new BaselineError(
          "LINK_INTO_EXCLUDED",
          `${relPath} resolves into excluded SSOT path ${ssotRelative}`,
          { relPath },
        )
      }
      const inRulesSubtree =
        ssotRelative === SSOT_RULES_SUBTREE || ssotRelative.startsWith(`${SSOT_RULES_SUBTREE}/`)
      if (!declared && !inRulesSubtree) {
        throw new BaselineError(
          "SYMLINK_OUTSIDE_ROOTS",
          `${relPath} resolves to ${ssotRelative}, outside the ${SSOT_RULES_SUBTREE}/ subtree`,
          { relPath },
        )
      }
      return { root: "ssot", rootRelPath: ssotRelative }
    }
  }

  throw new BaselineError(
    "SYMLINK_OUTSIDE_ROOTS",
    `${relPath} resolves outside both the repository and the SSOT`,
    { relPath },
  )
}


/**
 * Resolve the SSOT file a component declared for this destination.
 *
 * A declared source must name the file itself: if `a.md` is itself a symlink, following it would let
 * the declaration authorise whatever that link happens to point at, which is exactly the indirection
 * the per-destination mapping exists to prevent. The *parent* is still resolved, because `/var` is an
 * alias of `/private/var` on macOS and that has nothing to do with the declared name.
 */
async function resolveDeclaredSource(
  ssotRoot: string,
  sourcePath: string,
  relPath: string,
): Promise<{ real: string; relative: string; info: Stats }> {
  const candidate = path.join(ssotRoot, sourcePath)
  const missing = (detail: string, cause?: unknown): never => {
    throw new BaselineError(
      "CANONICAL_SOURCE_MISSING",
      `${relPath} declares SSOT source ${sourcePath}, which ${detail}`,
      cause === undefined ? { relPath } : { relPath, cause },
    )
  }

  let info: Stats
  try {
    info = await lstat(candidate)
  } catch (error) {
    return missing("does not exist", error)
  }
  if (info.isSymbolicLink()) {
    return missing("is a symlink; name the file it points at")
  }
  if (!info.isFile()) {
    return missing("is not a file")
  }

  let parentReal: string
  try {
    parentReal = await realpath(path.dirname(candidate))
  } catch (error) {
    return missing("cannot be resolved", error)
  }
  if (!isAtOrInside(ssotRoot, parentReal)) {
    return missing("resolves outside the SSOT root")
  }

  const real = path.join(parentReal, path.basename(candidate))
  const relative = relativeWithin(ssotRoot, real)
  if (relative === null) return missing("resolves outside the SSOT root")
  if (hasExcludedSegment(relative)) {
    throw new BaselineError(
      "LINK_INTO_EXCLUDED",
      `${relPath} declares SSOT source ${sourcePath}, which sits inside excluded ${relative}`,
      { relPath },
    )
  }
  return { real, relative, info }
}

/**
 * Record the declared canonical counterpart of a captured body.
 *
 * A link must have resolved to *exactly* the declared file — being somewhere inside the SSOT is not
 * enough, or an internal SSOT link could redirect the body. Its digest is reused rather than re-read:
 * it is the same file, and a second read could only introduce a chance for the two to disagree.
 *
 * A regular file may legitimately differ (a generated copy), so that case records `identical: false`
 * instead of failing, and the divergence stays visible in the fingerprint's `ssotRulesHash`.
 */
async function canonicalFor(
  state: WalkState,
  relPath: string,
  capturedSha: string,
  capturedRealPath: string,
  kind: "regular" | "symlink",
  byDestination: Map<string, CanonicalSource>,
): Promise<CanonicalLink | undefined> {
  const declared = byDestination.get(relPath)
  if (declared === undefined) return undefined
  if (state.ssotRoot === null) {
    throw new BaselineError(
      "CANONICAL_SOURCE_MISSING",
      `${relPath} declares an SSOT source, but no SSOT root is available`,
      { relPath },
    )
  }

  const source = await resolveDeclaredSource(state.ssotRoot, declared.source.path, relPath)
  if (kind === "symlink") {
    if (source.real !== capturedRealPath) {
      throw new BaselineError(
        "CANONICAL_SOURCE_MISMATCH",
        `${relPath} resolves to a different SSOT file than the declared ${declared.source.path}`,
        { relPath },
      )
    }
    state.associations.push({
      destination: relPath,
      sourceRoot: "ssot",
      sourcePath: source.relative,
      sourceSha256: capturedSha,
    })
    return {
      root: "ssot",
      rootRelPath: source.relative,
      sha256: capturedSha,
      identical: true,
    }
  }

  const read = await readStable(source.real, declared.source.path)
  state.associations.push({
    destination: relPath,
    sourceRoot: "ssot",
    sourcePath: source.relative,
    sourceSha256: read.sha256,
  })
  return {
    root: "ssot",
    rootRelPath: source.relative,
    sha256: read.sha256,
    identical: read.sha256 === capturedSha,
  }
}

/**
 * A minimal, sanitised environment for `git`.
 *
 * Built as an allowlist rather than by deleting known-bad keys: `GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY` and friends would otherwise let the caller's shell decide
 * which repository is read. `GIT_OPTIONAL_LOCKS=0` stops `status` taking an index lock at all, so a
 * baseline capture cannot write inside `.git`.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
  const keep = [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "SHELL",
  ]
  const env: NodeJS.ProcessEnv = {}
  for (const key of keep) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  env.GIT_OPTIONAL_LOCKS = "0"
  env.GIT_TERMINAL_PROMPT = "0"
  return env
}

type GitResult = { readonly stdout: string; readonly stderr: string }

function execGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--no-pager", "-c", "core.fsmonitor=false", ...args],
      {
        cwd,
        shell: false,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        env: gitEnvironment(),
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr })
          return
        }
        if ((error as { killed?: boolean }).killed === true) {
          reject(
            new BaselineError(
              "GIT_TIMEOUT",
              `git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`,
              { cause: error },
            ),
          )
          return
        }
        const detail = typeof stderr === "string" ? stderr.trim() : ""
        reject(
          new BaselineError(
            "GIT_FAILED",
            `git ${args.join(" ")} failed${detail === "" ? "" : `: ${detail}`}`,
            { cause: error },
          ),
        )
      },
    )
  })
}

async function readGitMetadata(repoDir: string, repoRoot: string): Promise<GitMetadata> {
  let toplevelOutput: string
  try {
    toplevelOutput = (await execGit(repoDir, ["rev-parse", "--show-toplevel"])).stdout.trim()
  } catch (error) {
    if (error instanceof BaselineError && error.code === "GIT_TIMEOUT") throw error
    throw new BaselineError("NOT_A_REPO", `${repoDir} is not inside a git repository`, {
      cause: error,
    })
  }

  const toplevel = await realpath(toplevelOutput).catch(() => path.resolve(toplevelOutput))
  if (toplevel !== repoRoot) {
    throw new BaselineError(
      "NOT_A_REPO_ROOT",
      `${repoDir} is not the repository root (the root is ${toplevel}); ` +
        "a baseline must be captured from the root it fingerprints",
    )
  }

  const head = await execGit(repoDir, ["rev-parse", "--verify", "--quiet", "HEAD"])
    .then((result) => result.stdout.trim())
    .catch((error: unknown) => {
      if (error instanceof BaselineError && error.code === "GIT_TIMEOUT") throw error
      return null
    })
  if (head === null || head === "") {
    throw new BaselineError("UNBORN_HEAD", `${repoDir} has no commit to capture`)
  }

  // `-z` because a path may contain a newline; `--untracked-files=no` so a capture never walks the
  // worktree, and `--ignore-submodules=all` so a nested repository is not reported as dirty by proxy.
  const status = (
    await execGit(repoDir, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=no",
      "--ignore-submodules=all",
      "--no-renames",
    ])
  ).stdout
  const dirty = status
    .split("\u0000")
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.slice(3))
    .sort(compare)

  return {
    baseSha: head,
    dirty,
    dependencyLockHash: await hashLockfile(repoRoot),
    toplevelMatches: true,
  }
}

/** `null` when there is no lockfile; that is a different state from an empty one. */
async function hashLockfile(repoRoot: string): Promise<string | null> {
  const lockfile = path.join(repoRoot, LOCKFILE_NAME)
  let info: Stats
  try {
    info = await lstat(lockfile)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null
    throw new BaselineError("READ_FAILED", `could not inspect ${LOCKFILE_NAME}`, { cause: error })
  }
  if (!info.isFile()) {
    throw new BaselineError("UNSUPPORTED_ENTRY", `${LOCKFILE_NAME} is not a regular file`)
  }
  if (info.size > MAX_LOCKFILE_BYTES) {
    throw new BaselineError(
      "TOO_LARGE",
      `${LOCKFILE_NAME} is ${info.size} bytes, over the ${MAX_LOCKFILE_BYTES}-byte metadata limit`,
    )
  }
  // The lockfile is metadata, not harness content, so it gets its own size policy — but the same
  // stability proof. A digest over half of one version and half of another is worse than an error.
  const read = await readStable(lockfile, LOCKFILE_NAME, MAX_LOCKFILE_BYTES)
  return read.sha256
}
