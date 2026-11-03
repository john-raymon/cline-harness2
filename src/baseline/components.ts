import { relPathSchema } from "../domain/schemas.ts"
import { BaselineError } from "./errors.ts"

/**
 * Which parts of a repository make up its harness.
 *
 * The list is a whitelist, not a filter: capture only ever visits these paths, so `node_modules/` and
 * `.git/` are not walked because they are not here — not because something remembered to skip them.
 * That is the difference between a guarantee and a habit.
 *
 * `scripts/verify-helpers` is deliberately absent. It holds executable scripts, a `HarnessTree` is
 * text only, and `materialiseTree` writes `0o644`; capturing it today would silently strip `+x`.
 * It joins the manifest once materialisation carries a mode map.
 */

export const COMPONENT_VERSION = 1

/**
 * An exact link from one captured file to the SSOT file that is supposed to back it.
 *
 * Exactness is the point. A directory-prefix grant ("anything under `cline-config/.clinerules`") would
 * let a symlink inside the SSOT redirect a body to a different file than the one the operator meant.
 */
export interface CanonicalSource {
  /** Repo-relative destination, i.e. the key it will have in the tree. */
  readonly destination: string
  readonly source: { readonly root: "ssot"; readonly path: string }
}

export interface ComponentSpec {
  readonly id: string
  /** Repo-relative path of the component. */
  readonly path: string
  readonly kind: "file" | "directory"
  readonly required?: boolean
  readonly canonicalSources?: readonly CanonicalSource[]
}

/**
 * The default harness: everything the prompt compiler and the tool inventory read.
 *
 * `systemprompt.md` and `tools/` are here because Chunks 7–8 gave them a consumer. A component that
 * capture never visits is a file the compiled prompt cannot see, so leaving them out would make the
 * tree and the prompt disagree about what the harness is.
 */
export const DEFAULT_COMPONENTS: readonly ComponentSpec[] = [
  { id: "clinerules", path: ".clinerules", kind: "directory" },
  { id: "experience", path: "EXPERIENCE.md", kind: "file" },
  { id: "skills", path: ".cline/skills", kind: "directory" },
  { id: "instructions", path: "systemprompt.md", kind: "file" },
  { id: "tools", path: "tools", kind: "directory" },
]

/** Directories that must never appear anywhere in a component path, at any depth. */
export const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set([
  ".git",
  ".tmp",
  ".ds_store",
  "node_modules",
])

function fail(message: string): never {
  throw new BaselineError("INVALID_COMPONENTS", message)
}

function requireRelPath(value: unknown, what: string): string {
  const parsed = relPathSchema.safeParse(value)
  if (!parsed.success) {
    const detail = parsed.error.issues[0]?.message ?? "invalid path"
    return fail(`${what} ${JSON.stringify(value)} is not a usable relative path: ${detail}`)
  }
  return parsed.data
}

/**
 * Validate and normalise a component manifest before anything touches a disk.
 *
 * Every failure here happens before I/O, so a bad manifest cannot leave a half-captured baseline
 * behind, and overlapping entries are refused rather than silently captured twice.
 */
export function validateComponents(specs: readonly ComponentSpec[]): readonly ComponentSpec[] {
  if (specs.length === 0) fail("a component manifest must declare at least one component")

  const ids = new Set<string>()
  const paths = new Set<string>()
  const destinations = new Set<string>()
  const normalised: ComponentSpec[] = []

  for (const spec of specs) {
    if (typeof spec.id !== "string" || spec.id.length === 0 || /\s/.test(spec.id)) {
      fail(`component id ${JSON.stringify(spec.id)} must be a non-empty token without whitespace`)
    }
    if (ids.has(spec.id)) fail(`component id ${JSON.stringify(spec.id)} is declared twice`)
    ids.add(spec.id)

    const path = requireRelPath(spec.path, `component ${spec.id} path`)
    for (const segment of path.split("/")) {
      if (FORBIDDEN_SEGMENTS.has(segment.toLowerCase())) {
        fail(`component ${spec.id} points at ${path}, which passes through a never-captured directory`)
      }
    }
    if (paths.has(path)) fail(`component path ${path} is declared twice`)
    paths.add(path)

    if (spec.kind !== "file" && spec.kind !== "directory") {
      fail(`component ${spec.id} has unknown kind ${JSON.stringify(spec.kind)}`)
    }

    const canonicalSources = spec.canonicalSources ?? []
    for (const mapping of canonicalSources) {
      const destination = requireRelPath(
        mapping.destination,
        `component ${spec.id} canonical destination`,
      )
      const inside =
        spec.kind === "file" ? destination === path : destination.startsWith(`${path}/`)
      if (!inside) {
        fail(
          `component ${spec.id} declares a canonical source for ${destination}, ` +
            `which is not inside ${path}`,
        )
      }
      if (destinations.has(destination)) {
        fail(`canonical destination ${destination} is declared more than once`)
      }
      destinations.add(destination)
      if (mapping.source?.root !== "ssot") {
        fail(`canonical destination ${destination} must name the "ssot" root`)
      }
      requireRelPath(mapping.source.path, `canonical destination ${destination} source`)
    }

    normalised.push({
      id: spec.id,
      path,
      kind: spec.kind,
      required: spec.required === true,
      ...(canonicalSources.length === 0 ? {} : { canonicalSources }),
    })
  }

  // Overlap: `a` and `a/b` would capture the same bytes twice, and the second walk would read files
  // the first one already claimed. Case folds are rejected too, because APFS would merge them.
  const ordered = [...paths].sort()
  const folded = new Map<string, string>()
  for (const path of ordered) {
    const key = path.normalize("NFC").toLowerCase()
    const clash = folded.get(key)
    if (clash !== undefined) fail(`${clash} and ${path} collide on a case-insensitive file system`)
    folded.set(key, path)
    const prefix = `${path}/`
    const nested = ordered.find((other) => other !== path && other.startsWith(prefix))
    if (nested !== undefined) fail(`${path} and ${nested} overlap; a component may not contain another`)
  }

  return normalised
}
