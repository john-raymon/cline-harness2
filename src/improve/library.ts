import { canonicalSha256 } from "../domain/canonical.ts"
import {
  lessonSchema,
  type HarnessTree,
  type Lesson,
  type LessonConfidenceLevel,
} from "../domain/schemas.ts"
import { ImproveError } from "./errors.ts"

/**
 * Lessons that survive the run that produced them.
 *
 * A lesson is filed under the *claim* it makes, not the rows that motivated it — two reflections that
 * reach the same cue and the same operation are the same lesson, and re-adding one because a second run
 * tripped over it would fill the library with copies that all look like independent evidence. Evidence
 * is what the entry quotes; it is not what identifies it.
 *
 * The cap is a hard count, not a token budget: the rendered library reaches the prompt through the
 * `memory` slice, so an uncapped library would grow the always-on prompt until it crowded out the task.
 */

export const LESSON_LIBRARY_CAP = 120

/** Where the rendered library lives. `collectSlices` reads it into the `memory` slice. */
export const LESSON_LIBRARY_PATH = "LongTermMEMORY.md"

export interface LibraryEntry {
  readonly lesson: Lesson
  /** ISO instant the entry was filed at. Supplied by the caller so a library is reproducible. */
  readonly addedAt: string
}

export interface LessonLibrary {
  readonly entries: readonly LibraryEntry[]
}

export const EMPTY_LIBRARY: LessonLibrary = { entries: [] }

/** Collapse whitespace, case and cosmetic punctuation: a restated claim is the same claim. */
function normalise(text: string): string {
  return text
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!;:,]+$/, "")
    .toLowerCase()
}

/** Identity of a lesson: the claim, not the evidence behind it. */
export function lessonKey(lesson: Lesson): string {
  return canonicalSha256({ cue: normalise(lesson.cue), lesson: normalise(lesson.lesson) })
}

const LEVEL_RANK: Record<LessonConfidenceLevel, number> = { high: 0, medium: 1, low: 2 }

export interface AddLessonResult {
  readonly library: LessonLibrary
  /**
   * `dropped` means the library was full and this lesson ranked lowest, so it was **not** filed. It is a
   * separate outcome rather than a duplicate because nothing about it is already in the library, and
   * reporting it as `added` would claim a filing that never happened.
   */
  readonly outcome: "added" | "duplicate" | "dropped"
  readonly key: string
  /** The entry dropped to stay under the cap, when adding one forced a choice. */
  readonly evicted?: string
}

/**
 * File one lesson, or report that it is already filed.
 *
 * A duplicate does not replace the existing entry, even when the new one has better confidence: the
 * library is a record of what the harness has learned, and rewriting a lesson in place would erase the
 * evidence the earlier entry cited. `outcome: "duplicate"` is what the caller records instead.
 */
export function addLesson(
  library: LessonLibrary,
  lesson: Lesson,
  options: { readonly at: string },
): AddLessonResult {
  const parsed = lessonSchema.parse(lesson)
  const key = lessonKey(parsed)
  if (library.entries.some((entry) => lessonKey(entry.lesson) === key)) {
    return { library, outcome: "duplicate", key }
  }

  // Canonicalise the instant: eviction compares recency, and `+00:00` against `Z` would sort by spelling
  // rather than by time.
  const at = new Date(options.at)
  if (Number.isNaN(at.getTime())) {
    throw new ImproveError("LIBRARY_INVALID", `${JSON.stringify(options.at)} is not an ISO instant`)
  }
  const entries = [...library.entries, { lesson: parsed, addedAt: at.toISOString() }]
  if (entries.length <= LESSON_LIBRARY_CAP) {
    return { library: { entries }, outcome: "added", key }
  }

  // Deterministic eviction: lowest confidence first, then oldest, then the key itself so two entries
  // filed in the same millisecond still resolve the same way on every machine.
  const ranked = [...entries].sort((left, right) => {
    const byLevel = LEVEL_RANK[left.lesson.confidence.level] - LEVEL_RANK[right.lesson.confidence.level]
    if (byLevel !== 0) return byLevel
    if (left.addedAt !== right.addedAt) return left.addedAt < right.addedAt ? 1 : -1
    return lessonKey(left.lesson) < lessonKey(right.lesson) ? 1 : -1
  })
  const survivors = new Set(ranked.slice(0, LESSON_LIBRARY_CAP))
  if (!survivors.has(entries[entries.length - 1] as LibraryEntry)) {
    // The lesson being filed is the weakest thing here, so the cap keeps what it already had. Saying
    // "added" would be a lie about a library that did not change.
    return { library, outcome: "dropped", key, evicted: key }
  }

  const dropped = ranked[ranked.length - 1]
  // Filing order is kept for what survived, so the rendered file still reads chronologically.
  return {
    library: { entries: entries.filter((entry) => survivors.has(entry)) },
    outcome: "added",
    key,
    ...(dropped === undefined ? {} : { evicted: lessonKey(dropped.lesson) }),
  }
}

/**
 * Render the library into the body of `LongTermMEMORY.md`.
 *
 * Ordered by confidence then by claim, never by insertion: the same library must produce the same bytes,
 * because these bytes are part of the compiled prompt and therefore part of its digest.
 */
export function renderLongTermMemory(library: LessonLibrary): string {
  const header = [
    "# Long-term memory",
    "",
    "Lessons carried forward from earlier runs. Each names the shape of a situation and an operation on",
    "the harness that addressed it; confidence says how much the evidence behind it actually shows.",
    "",
  ]
  if (library.entries.length === 0) return [...header, "_No lessons filed yet._", ""].join("\n")

  const ordered = [...library.entries].sort((left, right) => {
    const byLevel =
      LEVEL_RANK[left.lesson.confidence.level] - LEVEL_RANK[right.lesson.confidence.level]
    if (byLevel !== 0) return byLevel
    const leftKey = lessonKey(left.lesson)
    const rightKey = lessonKey(right.lesson)
    if (leftKey === rightKey) return 0
    return leftKey < rightKey ? -1 : 1
  })

  const bullets = ordered.map((entry) => {
    const { cue, lesson, evidence, confidence } = entry.lesson
    return `- **${oneLine(cue)}** -> ${oneLine(lesson)} (${confidence.level}: ${oneLine(
      confidence.why,
    )}). Evidence: ${oneLine(evidence)}`
  })
  return [...header, ...bullets, ""].join("\n")
}

/** A lesson is one bullet, so a body with newlines in it would forge extra entries. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/** Feed the library into a tree as its memory file. */
export function applyLessonLibrary(tree: HarnessTree, library: LessonLibrary): HarnessTree {
  if (library.entries.length === 0) {
    // An empty library means no file. Leaving a stale one behind would keep feeding the prompt lessons
    // the library no longer holds.
    if (!Object.hasOwn(tree, LESSON_LIBRARY_PATH)) return tree
    const { [LESSON_LIBRARY_PATH]: _removed, ...rest } = tree
    return rest
  }
  return { ...tree, [LESSON_LIBRARY_PATH]: renderLongTermMemory(library) }
}
