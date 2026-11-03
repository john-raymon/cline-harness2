import { lstat, mkdir, readlink, realpath, writeFile } from "node:fs/promises"
import path from "node:path"

import type { HarnessTree } from "../domain/schemas.ts"

/**
 * Writing an improved harness back into the repository it came from.
 *
 * Everything before this chunk kept its result inside the run directory, which is the right default for a
 * research loop and useless for an editor: the operator wants the improved rules where the next session will
 * read them. So this is the one place in the project that writes to the operator's workspace, and it earns
 * that by being narrow:
 *
 * 1. **Only harness text.** `.clinerules/**`, `EXPERIENCE.md`, `LongTermMEMORY.md`, `systemprompt.md`. Never
 *    `tools/**` or `.cline/skills/**` — the first changes what the model may call, the second installs code.
 * 2. **Only what actually moved.** A file whose bytes are unchanged is reported as unchanged and not
 *    rewritten, so a no-op run does not touch modification times.
 * 3. **Never a deletion.** Removing a rule from someone's repository is not an "improvement".
 * 4. **Symlinks are followed, then checked.** `.clinerules` is often a symlink into the operator's
 *    single-source-of-truth config; writing through it is the *point* of that arrangement. But a link that
 *    resolves outside the workspace and the SSOT root is a reason to skip the file, not to follow it.
 */

/** Paths this module is willing to write. A prefix match, not a glob: `startsWith` cannot be tricked. */
export const WRITE_BACK_PREFIXES = [".clinerules/"] as const
/** Exact paths this module is willing to write. */
export const WRITE_BACK_PATHS = ["EXPERIENCE.md", "LongTermMEMORY.md", "systemprompt.md"] as const
/** A link chain longer than this is a cycle or an attack; either way, not something to follow. */
const MAX_SYMLINK_HOPS = 8

export type WriteBackOutcome =
  | { readonly path: string; readonly kind: "created" | "updated"; readonly throughSymlink: boolean }
  | { readonly path: string; readonly kind: "unchanged" }
  | { readonly path: string; readonly kind: "skipped"; readonly reason: string }

export interface WriteBackInput {
  /** The repository the capture came from. */
  readonly repo: string
  /** Tree as captured, before the run touched it. */
  readonly captured: HarnessTree
  /** Tree the run ended with. */
  readonly final: HarnessTree
  /** Root of the operator's config, when the workspace links into it. Links elsewhere are still skipped. */
  readonly ssotRoot?: string
}

export interface WriteBackResult {
  readonly written: readonly Extract<WriteBackOutcome, { kind: "created" | "updated" }>[]
  readonly unchanged: readonly string[]
  readonly skipped: readonly Extract<WriteBackOutcome, { kind: "skipped" }>[]
  /** True when at least one file on disk changed. */
  readonly changed: boolean
}

export function isWriteBackPath(relative: string): boolean {
  if (WRITE_BACK_PATHS.includes(relative as (typeof WRITE_BACK_PATHS)[number])) return true
  return WRITE_BACK_PREFIXES.some((prefix) => relative.startsWith(prefix))
}

/** Absolute, contained, and never a bare `.` — a tree path is a relative POSIX path or it is refused. */
function resolveInside(repo: string, relative: string): string | undefined {
  if (relative.length === 0 || path.isAbsolute(relative)) return undefined
  const absolute = path.resolve(repo, relative)
  const root = path.resolve(repo)
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return undefined
  return absolute
}

/**
 * Where a write to `absolute` would actually land.
 *
 * A leaf `lstat` is not enough, and getting this wrong is how "improve my rules" becomes "write anywhere":
 *
 * - `.clinerules` is often a *directory* symlink, so `lstat(".clinerules/rule.md")` follows the parent and
 *   reports a regular file. The parent has to be resolved too.
 * - A *dangling* leaf symlink makes `realpath` throw `ENOENT`, and `writeFile` would then happily create the
 *   file at the link's destination. The link is followed by hand so a dangling one is still checked.
 *
 * The returned `target` is the path the kernel will write to, compared against the workspace and SSOT roots.
 */
async function resolveWriteTarget(
  absolute: string,
): Promise<{ target: string; throughSymlink: boolean }> {
  let current = absolute
  let throughSymlink = false

  // Follow the leaf chain by hand, so a dangling link is resolved rather than reported as missing.
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop += 1) {
    const info = await lstat(current).catch(() => undefined)
    if (info?.isSymbolicLink() !== true) break
    throughSymlink = true
    const link = await readlink(current)
    current = path.resolve(path.dirname(current), link)
  }

  const parent = path.dirname(current)
  const parentReal = await realpath(parent).catch(() => undefined)
  const resolvedParent = parentReal ?? (await deepestRealDir(parent))
  const target = path.join(resolvedParent, path.basename(current))
  if (path.resolve(parent) !== resolvedParent) throughSymlink = true
  return { target, throughSymlink }
}

/** Real path of the deepest ancestor that exists, with the missing tail appended. */
async function deepestRealDir(dir: string): Promise<string> {
  const missing: string[] = []
  let current = path.resolve(dir)
  for (;;) {
    const real = await realpath(current).catch(() => undefined)
    if (real !== undefined) return path.join(real, ...missing.reverse())
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(dir)
    missing.push(path.basename(current))
    current = parent
  }
}

/**
 * A real path, or the resolved one when the target does not exist yet.
 *
 * The comparison needs *both* sides resolved: on macOS `/var` is a symlink to `/private/var`, so a realpath'd
 * symlink target never starts with an unresolved `os.tmpdir()` root and every legitimate link would be
 * refused as an escape.
 */
async function realpathOr(value: string): Promise<string> {
  try {
    return await realpath(value)
  } catch {
    return path.resolve(value)
  }
}

function isInside(parent: string, child: string): boolean {
  const root = path.resolve(parent)
  const target = path.resolve(child)
  return target === root || target.startsWith(`${root}${path.sep}`)
}

export async function writeBackHarness(input: WriteBackInput): Promise<WriteBackResult> {
  const repoReal = await realpathOr(input.repo)
  const ssotReal = input.ssotRoot === undefined ? undefined : await realpathOr(input.ssotRoot)
  const written: Extract<WriteBackOutcome, { kind: "created" | "updated" }>[] = []
  const unchanged: string[] = []
  const skipped: Extract<WriteBackOutcome, { kind: "skipped" }>[] = []

  for (const relative of Object.keys(input.final).sort()) {
    const body = input.final[relative] ?? ""
    if (!isWriteBackPath(relative)) {
      skipped.push({ path: relative, kind: "skipped", reason: "not a harness text file" })
      continue
    }

    const before = input.captured[relative]
    if (before === body) {
      unchanged.push(relative)
      continue
    }
    if (before === undefined && relative !== "LongTermMEMORY.md") {
      // A captured harness has no new paths — the loop rejects proposals that add them — so the only file a
      // run may introduce is the lesson library it owns.
      skipped.push({ path: relative, kind: "skipped", reason: "the capture never contained this file" })
      continue
    }
    if (before !== undefined && body.length === 0) {
      skipped.push({ path: relative, kind: "skipped", reason: "a write-back never empties a file" })
      continue
    }

    const absolute = resolveInside(input.repo, relative)
    if (absolute === undefined) {
      skipped.push({ path: relative, kind: "skipped", reason: "path escapes the workspace" })
      continue
    }

    const { target, throughSymlink } = await resolveWriteTarget(absolute)
    const allowed = isInside(repoReal, target) || (ssotReal !== undefined && isInside(ssotReal, target))
    if (!allowed) {
      // Following an unchecked link — or an unchecked *directory* link above it — turns "improve my rules"
      // into "write anywhere that link points".
      skipped.push({
        path: relative,
        kind: "skipped",
        reason: `resolves outside the workspace and the config root (${target})`,
      })
      continue
    }

    // `created`/`updated` describes the filesystem, not the tree: a captured file that the repository does not
    // actually contain is created, and calling that "updated" would misreport what happened to the working copy.
    const exists = await lstat(absolute).then(
      () => true,
      () => false,
    )

    await mkdir(path.dirname(absolute), { recursive: true })
    // `writeFile` follows a symlink, so a rules file linked into the config repository is updated through the
    // link — which is exactly what the operator's setup expects.
    await writeFile(absolute, body, "utf8")
    written.push({
      path: relative,
      kind: exists ? "updated" : "created",
      throughSymlink,
    })
  }

  return { written, unchanged, skipped, changed: written.length > 0 }
}
