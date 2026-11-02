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
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** `NAME_MAX` on ext4 and APFS. */
const SEGMENT_MAX_BYTES = 255

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
export const harnessTreeSchema = z.record(relPathSchema, z.string())
export type HarnessTree = z.infer<typeof harnessTreeSchema>

/**
 * An edit proposal over a harness tree.
 *
 * Contract, mirroring the upstream read-back semantics: an omitted path inherits its current body,
 * and `""` overwrites it with an empty file. Deletion is NOT expressible here — upstream expresses
 * it by removing the file from the on-disk workspace and reading the directory back, which is what
 * the evidence builder does after an oracle session.
 */
export const treePatchSchema = z.record(relPathSchema, z.string())
export type TreePatch = z.infer<typeof treePatchSchema>

/** Apply a patch to a tree, returning a new tree. Omitted keys inherit; `""` overwrites. */
export function applyTreePatch(base: HarnessTree, patch: TreePatch): HarnessTree {
  return { ...base, ...patch }
}

/** Paths the patch changes relative to `base` (added, modified or blanked). */
export function changedPaths(base: HarnessTree, patch: TreePatch): string[] {
  return Object.entries(patch)
    .filter(([path, body]) => base[path] !== body)
    .map(([path]) => path)
    .sort()
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
    modelId: z.string().min(1),
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

export const PROBE_FINGERPRINT_VERSION = 1

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
  modelId: z.string().min(1),
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


