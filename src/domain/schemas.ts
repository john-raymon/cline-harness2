import { z } from "zod"

/**
 * Domain contracts frozen in Chunk 1.
 *
 * Only shapes whose semantics are already fixed — by the upstream method or by a decision recorded
 * in `docs/ADAPTER.md` — live here. Schemas that depend on unowned decisions (`OracleOutputs`,
 * `ComposeNotes`, `LedgerEvent`) are deliberately deferred to their owning chunks so this file
 * never becomes a guess that later chunks inherit.
 */

export const REL_PATH_MAX_LENGTH = 240

/** Segments that would let a record key reach into an object prototype chain. */
const PROTOTYPE_SENSITIVE_SEGMENTS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
])

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/** Windows splits `C:/outside` into a drive segment, so a relative path must never start with one. */
const DRIVE_PREFIX = /^[A-Za-z]:$/

/** Reserved device names are unopenable on Windows and silently resolve to devices. */
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(\..*)?$/i

/** `NAME_MAX` on ext4 and APFS. */
const SEGMENT_MAX_BYTES = 255

/** Illegal in a Windows filename; a tree that only works on one OS is not a harness. */
const WINDOWS_ILLEGAL_PUNCTUATION = /[<>:"|?*]/

/**
 * Well-formed UTF-16: every surrogate is half of a valid pair.
 *
 * `String.prototype.isWellFormed` is ES2024 and this project targets ES2023, so the scan is local.
 * It matters because V8 writes an unpaired surrogate as `U+FFFD`, which silently changes the bytes
 * and breaks every round-trip and hash in the system.
 */
export function isWellFormedText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit < 0xd800 || unit > 0xdfff) continue
    if (unit > 0xdbff) return false
    const next = value.charCodeAt(index + 1)
    if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    index += 1
  }
  return true
}

const WELL_FORMED_MESSAGE =
  "must be well-formed UTF-16; an unpaired surrogate is written to disk as U+FFFD and cannot round-trip"

/**
 * Policy limits for a harness tree, shared by the writer and the reader so both enforce one policy.
 *
 * These are defaults, not measurements: a harness is prompt/markdown/config files, and 8 MiB of
 * UTF-8 text is roughly 4M tokens, far past any budget this harness will ever use.
 */
export const TREE_LIMITS = {
  maxFiles: 1024,
  maxFileBytes: 1_048_576,
  maxTotalBytes: 8_388_608,
  /** Files plus implied directories; bounds traversal through empty-directory forests. */
  maxEntries: 4096,
} as const

/** Text that may be stored as one file body. */
export const fileBodySchema = z.string().superRefine((value, ctx) => {
  if (!isWellFormedText(value)) {
    ctx.addIssue({ code: "custom", message: `file body ${WELL_FORMED_MESSAGE}` })
  }
})

/**
 * A normalised relative POSIX path, as used for every key of a harness tree.
 *
 * This rejects everything that could escape a directory once joined to one. It is a *lexical*
 * check only: filesystem containment (symlinks, mounts) is a separate concern owned by the
 * sandbox and contract-enforcement layers.
 */
export const relPathSchema = z.string().superRefine((value, ctx) => {
  const reject = (message: string): void => {
    ctx.addIssue({ code: "custom", message })
  }
  if (value.length === 0) return reject("path must not be empty")
  if (value.length > REL_PATH_MAX_LENGTH) {
    return reject(`path exceeds ${REL_PATH_MAX_LENGTH} characters`)
  }
  if (value.includes("\\")) return reject("path must use POSIX separators; found a backslash")
  if (value.includes("\0")) return reject("path must not contain a NUL byte")
  if (!isWellFormedText(value)) return reject(`path ${WELL_FORMED_MESSAGE}`)
  if (value !== value.normalize("NFC")) {
    return reject("path must be NFC-normalised; a decomposed form collides on macOS file systems")
  }
  if (value.startsWith("/")) return reject("path must be relative; found a leading slash")
  if (value.endsWith("/")) return reject("path must not end with a separator")
  if (value.includes("//")) return reject("path must not contain an empty segment")
  for (const segment of value.split("/")) {
    if (segment === "") return reject("path must not contain an empty segment")
    if (segment === ".") return reject('path must not contain a "." segment')
    if (segment === "..") return reject('path must not contain a ".." (parent-directory) segment')
    if (segment.trim() !== segment) {
      return reject("path segments must not have leading or trailing whitespace")
    }
    if (PROTOTYPE_SENSITIVE_SEGMENTS.has(segment)) {
      return reject(`path segment ${segment} is prototype-sensitive and is not allowed`)
    }
    if (DRIVE_PREFIX.test(segment)) {
      return reject(`path segment ${segment} looks like a Windows drive prefix`)
    }
    if (WINDOWS_ILLEGAL_PUNCTUATION.test(segment)) {
      return reject(
        `path segment ${segment} contains a character that is illegal in a Windows filename ` +
          "(one of < > : \" | ? *)",
      )
    }
    if (segment.endsWith(".")) {
      return reject("path segments must not end with a dot; such names are unopenable on Windows")
    }
    if (RESERVED_DEVICE_NAME.test(segment)) {
      return reject(`path segment ${segment} is a reserved device name`)
    }
    if (Buffer.byteLength(segment, "utf8") > SEGMENT_MAX_BYTES) {
      return reject(`path segment exceeds ${SEGMENT_MAX_BYTES} bytes on disk`)
    }
    if (CONTROL_CHARACTERS.test(segment)) {
      return reject("path must not contain control characters")
    }
  }
})

export type RelPath = z.infer<typeof relPathSchema>

/** The editable harness: relative path -> file body. */
export const harnessTreeSchema = z.record(relPathSchema, fileBodySchema)
export type HarnessTree = z.infer<typeof harnessTreeSchema>

/**
 * An edit proposal over a harness tree.
 *
 * Three-valued, mirroring how the upstream workspace behaves: an omitted path inherits its current
 * body, `""` overwrites it with an empty file, and `null` removes it. Deletion is expressed here
 * rather than by touching the disk, so a patch is a value that can be diffed, hashed and replayed.
 */
export const treePatchSchema = z.record(relPathSchema, fileBodySchema.nullable())
export type TreePatch = z.infer<typeof treePatchSchema>

/**
 * Apply a patch to a tree, returning a new tree. Omitted keys inherit; `""` empties; `null` deletes.
 *
 * Deleting a path that is not present is a no-op rather than an error: patches get composed and
 * replayed, so the algebra has to stay idempotent. An oracle edit that deletes nothing it meant to
 * has to be caught by a validator, not by making this function throw.
 */
export function applyTreePatch(base: HarnessTree, patch: TreePatch): HarnessTree {
  const next: HarnessTree = { ...base }
  for (const [path, body] of Object.entries(patch)) {
    if (body === null) delete next[path]
    else next[path] = body
  }
  return next
}

/** Paths the patch changes relative to `base` (added, modified, blanked or deleted). */
export function changedPaths(base: HarnessTree, patch: TreePatch): string[] {
  return Object.entries(patch)
    // `Object.hasOwn`, not `in`: a path may legally be named `toString`, and `"toString" in {}` is
    // true through `Object.prototype`, which would report deleting a file that never existed.
    .filter(([path, body]) =>
      body === null
        ? Object.hasOwn(base, path)
        : !Object.hasOwn(base, path) || base[path] !== body,
    )
    .map(([path]) => path)
    .sort()
}

export interface TreeDiff {
  readonly added: readonly string[]
  readonly modified: readonly string[]
  readonly removed: readonly string[]
}

/**
 * Compare two trees over the union of their keys.
 *
 * `changedPaths` compares a *patch*, so it cannot see a removal: the removed key is simply absent
 * from the patch. A read-back workspace has to be diffed as before/after trees, which is this.
 */
export function diffTrees(before: HarnessTree, after: HarnessTree): TreeDiff {
  const added: string[] = []
  const modified: string[] = []
  const removed: string[] = []
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  for (const key of keys) {
    // Ownership, not presence-by-prototype: `toString` and friends are legal filenames.
    const hadBefore = Object.hasOwn(before, key)
    const hasAfter = Object.hasOwn(after, key)
    if (!hadBefore) added.push(key)
    else if (!hasAfter) removed.push(key)
    else if (before[key] !== after[key]) modified.push(key)
  }
  return { added, modified, removed }
}

export class HarnessTreeError extends Error {
  override readonly name = "HarnessTreeError"
  readonly issues: readonly string[]

  constructor(message: string, issues: readonly string[]) {
    super(message)
    this.issues = issues
  }
}

/** Case-fold key used to detect names that collide on APFS/NTFS/ext4-casefold. */
function foldKey(path: string): string {
  return path.normalize("NFC").toLowerCase()
}

function impliedDirectories(path: string): string[] {
  const segments = path.split("/")
  const directories: string[] = []
  for (let index = 1; index < segments.length; index += 1) {
    directories.push(segments.slice(0, index).join("/"))
  }
  return directories
}

/**
 * Everything that would make a tree impossible to write, collected in one pass.
 *
 * Pure and portable: it never touches a disk, so a tree is rejected before a single byte is written
 * and the same checks run in CI on a case-insensitive macOS volume or a case-sensitive one.
 */
export function materialisabilityIssues(tree: HarnessTree): string[] {
  const issues: string[] = []
  const paths = Object.keys(tree).sort()
  if (paths.length > TREE_LIMITS.maxFiles) {
    issues.push(`${paths.length} files exceeds the ${TREE_LIMITS.maxFiles}-file limit`)
  }

  const files = new Set(paths)
  const directories = new Set<string>()
  let totalBytes = 0
  for (const path of paths) {
    const bytes = Buffer.byteLength(tree[path] ?? "", "utf8")
    if (bytes > TREE_LIMITS.maxFileBytes) {
      issues.push(`${path}: ${bytes} bytes exceeds the ${TREE_LIMITS.maxFileBytes}-byte file limit`)
    }
    totalBytes += bytes
    for (const directory of impliedDirectories(path)) {
      if (files.has(directory)) {
        issues.push(
          `${JSON.stringify(directory)}: is a file and also a directory containing ${path}`,
        )
      }
      directories.add(directory)
    }
  }
  if (totalBytes > TREE_LIMITS.maxTotalBytes) {
    issues.push(`${totalBytes} bytes exceeds the ${TREE_LIMITS.maxTotalBytes}-byte tree limit`)
  }
  if (paths.length + directories.size > TREE_LIMITS.maxEntries) {
    issues.push(
      `${paths.length + directories.size} entries exceeds the ${TREE_LIMITS.maxEntries}-entry limit`,
    )
  }

  // Directories are folded too: `A/x` and `a/y` are different records but one directory on APFS.
  // Collected into sets first, because one path can legitimately appear as both a file key and an
  // implied directory, and that self-overlap is reported by the prefix check above, not as a collision.
  const folded = new Map<string, Set<string>>()
  for (const entry of [...paths, ...directories]) {
    const key = foldKey(entry)
    const group = folded.get(key)
    if (group === undefined) folded.set(key, new Set([entry]))
    else group.add(entry)
  }
  for (const [key, group] of folded) {
    if (group.size > 1) {
      issues.push(
        `${[...group].sort().join(" and ")} collide on a case-insensitive file system ` +
          `(both fold to ${JSON.stringify(key)})`,
      )
    }
  }
  return issues
}

/** Throw unless the tree can be materialised. Collects every problem, not just the first. */
export function assertMaterialisableTree(tree: HarnessTree): void {
  const issues = materialisabilityIssues(tree)
  if (issues.length > 0) {
    throw new HarnessTreeError(`tree cannot be materialised:\n  ${issues.join("\n  ")}`, issues)
  }
}

export const RUN_MODES = ["parallel", "sequential"] as const
export const runModeSchema = z.enum(RUN_MODES)
export type RunMode = z.infer<typeof runModeSchema>

/** Matches the SDK's `REASONING_LEVELS` so a fingerprint value is always one the SDK accepts. */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const
export const reasoningEffortSchema = z.enum(REASONING_EFFORTS)
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>

const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected a lowercase hex sha256 digest")

const LOOPBACK_IPV4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/

/**
 * True only for hosts that cannot leave the machine.
 *
 * `new URL` hands back the IPv6 host *with* brackets and has already normalised exotic IPv4 forms
 * (`0x7f000001`, `127.1`) to dotted quads, so the checks below run on the normalised host. Equality
 * is exact on purpose: `endsWith("localhost")` would happily accept `localhost.evil.com`.
 *
 * `*.localhost` (RFC 6761) is deliberately *not* accepted: it is only loopback if the resolver
 * honours the RFC, and this check must not depend on the resolver. IPv4-mapped `[::ffff:7f00:1]` is
 * rejected for the same reason — the operator gets an actionable message instead of a silent choice.
 */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "localhost." ||
    hostname === "[::1]" ||
    LOOPBACK_IPV4.test(hostname)
  )
}

/**
 * The solver endpoint, normalised to one canonical spelling.
 *
 * `baseUrl` changes which client speaks and which capability set is available, so two runs against
 * different endpoints are not a matched contrast. Normalising here means the fingerprint records a
 * value that is comparable rather than whatever string the caller typed.
 */
export const baseUrlSchema = z.string().transform((value, ctx) => {
  const reject = (message: string): typeof z.NEVER => {
    ctx.addIssue({ code: "custom", message })
    return z.NEVER
  }
  if (value.length === 0) return reject("base URL must not be empty")
  // Checked on the raw string: the WHATWG parser silently rewrites "\" to "/" in the authority.
  if (value.includes("\\")) return reject("base URL must not contain a backslash")
  if (WHITESPACE_OR_CONTROL.test(value)) {
    return reject("base URL must not contain whitespace or control characters")
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return reject(`base URL is not a valid absolute URL: ${JSON.stringify(value)}`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return reject(`base URL must use https, or http for loopback; got ${url.protocol}`)
  }
  if (url.username !== "" || url.password !== "") {
    return reject("base URL must not embed credentials")
  }
  if (url.search !== "") return reject("base URL must not contain a query string")
  if (url.hash !== "") return reject("base URL must not contain a fragment")
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    return reject(
      `plain http is only allowed for loopback endpoints; ${url.hostname} is not loopback`,
    )
  }

  // `url.host` keeps the explicit port and the IPv6 brackets; only trailing path slashes go.
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`
})

export const ARBITRATION_MODES = ["off", "probe"] as const
export const arbitrationModeSchema = z.enum(ARBITRATION_MODES)
export type ArbitrationMode = z.infer<typeof arbitrationModeSchema>

/** A model id is one opaque token: `hf:deepseek-ai/DeepSeek-V4.1-Flash-1017` is legal. */
const modelIdSchema = z
  .string()
  .min(1)
  .refine((value) => !WHITESPACE_OR_CONTROL.test(value), {
    message: "model id must be a single token with no whitespace or control characters",
  })


/**
 * Resolved configuration for one run.
 *
 * Token budgets are the T4 thresholds and are validated as a strictly increasing chain
 * (`tail < target < b1 < b2`): a target at or above the soft threshold would re-trigger stubbing
 * on the very next request, and a preserved tail at or above the target would make the target
 * unreachable.
 */
export const runConfigSchema = z
  .strictObject({
    k: z.int().min(1).max(16),
    mode: runModeSchema,
    b1Tokens: z.int().positive(),
    b2Tokens: z.int().positive(),
    targetTokens: z.int().positive(),
    tailTokens: z.int().nonnegative(),
    providerId: z.string().min(1),
    modelId: modelIdSchema,
    baseUrl: baseUrlSchema,
    arbitration: arbitrationModeSchema,
    apiKey: z.string().min(1).optional(),
    root: z.string().min(1),
  })
  .superRefine((config, ctx) => {
    if (config.tailTokens >= config.targetTokens) {
      ctx.addIssue({
        code: "custom",
        path: ["targetTokens"],
        message:
          `targetTokens (${config.targetTokens}) must be greater than tailTokens ` +
          `(${config.tailTokens}), or the preserved tail alone fills the compaction target`,
      })
    }
    if (config.targetTokens >= config.b1Tokens) {
      ctx.addIssue({
        code: "custom",
        path: ["b1Tokens"],
        message:
          `b1Tokens (${config.b1Tokens}) must be greater than targetTokens ` +
          `(${config.targetTokens}), or compaction lands above the soft threshold and stubs immediately`,
      })
    }
    if (config.b1Tokens >= config.b2Tokens) {
      ctx.addIssue({
        code: "custom",
        path: ["b2Tokens"],
        message:
          `b2Tokens (${config.b2Tokens}) must be greater than b1Tokens ` +
          `(${config.b1Tokens}), or the hard threshold can never be crossed first`,
      })
    }
  })

export type RunConfig = z.infer<typeof runConfigSchema>

export const PROBE_FINGERPRINT_VERSION = 2

/**
 * Everything that must be identical for a probe to count as a matched contrast against `e_0`.
 *
 * Any field that could change solver behaviour belongs here; a missing field makes two unequal
 * probes look comparable, which is the exact failure this type exists to prevent.
 */
export const probeFingerprintSchema = z.strictObject({
  version: z.literal(PROBE_FINGERPRINT_VERSION),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/, "expected a 40-character git commit sha"),
  dependencyLockHash: sha256HexSchema,
  providerId: z.string().min(1),
  modelId: modelIdSchema,
  baseUrl: baseUrlSchema,
  reasoningEffort: reasoningEffortSchema,
  thinking: z.boolean(),
  toolPolicySet: z.array(z.string().min(1)),
  toolInventoryHash: sha256HexSchema,
  compiledPromptHash: sha256HexSchema,
  t4Policy: z.string().min(1),
  ssotRulesHash: sha256HexSchema,
  librarySnapshotHash: sha256HexSchema,
  slices: z.array(z.string().min(1)),
})

export type ProbeFingerprint = z.infer<typeof probeFingerprintSchema>

export const lessonConfidenceLevelSchema = z.enum(["high", "medium", "low"])
export type LessonConfidenceLevel = z.infer<typeof lessonConfidenceLevelSchema>

/**
 * The transferable lesson the Reflector may write into the library.
 *
 * Field semantics are upstream's: `cue` is the shape of situation (not this task's facts),
 * `lesson` is an operation on a harness that names a component, and `evidence` cites the edit rows
 * and the execution contrast they rest on. A lesson resting only on confounded rows is a guess,
 * which is why `confidence` carries its reason rather than a bare word.
 */
export const lessonSchema = z.strictObject({
  cue: z.string().min(1),
  lesson: z.string().min(1),
  evidence: z.string().min(1),
  confidence: z.strictObject({
    level: lessonConfidenceLevelSchema,
    why: z.string().min(1),
  }),
})

export type Lesson = z.infer<typeof lessonSchema>

/** A lesson is usable only when every required field carries content (upstream `has_experience`). */
export function isUsableLesson(lesson: Lesson | null | undefined): lesson is Lesson {
  if (!lesson) return false
  return (
    lesson.cue.trim().length > 0 &&
    lesson.lesson.trim().length > 0 &&
    lesson.evidence.trim().length > 0
  )
}

/**
 * Budget identity for one task at recursion depth `k`.
 *
 * Upstream calls these rollouts and sessions; here they are split by *meaning* — an execution is a
 * solver run in a sandbox, an improvement is an oracle stage — because conflating the two is how
 * the `4k` / `3k` identity gets silently violated. Retries, schema repairs and oracle substitutions
 * are tracked separately as physical attempts and never fold into these counts.
 */
export function expectedExecutions(k: number): number {
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`k must be a positive integer, got ${k}`)
  return 4 * k
}

export function expectedImprovements(k: number): number {
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`k must be a positive integer, got ${k}`)
  return 3 * k
}


