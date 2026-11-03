import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { Lesson } from "../src/domain/schemas.ts"
import {
  addLesson,
  applyLessonLibrary,
  EMPTY_LIBRARY,
  LESSON_LIBRARY_CAP,
  LESSON_LIBRARY_PATH,
  lessonKey,
  renderLongTermMemory,
} from "../src/improve/library.ts"
import { collectSlices } from "../src/prompt/slices.ts"

/**
 * The lesson library.
 *
 * The gate is one sentence: a duplicate lesson is not re-added. Everything else here exists to make that
 * gate hold for lessons that *look* different (whitespace, case) while still letting a genuinely new claim
 * through, and to keep the rendered file small and reproducible.
 */

function lesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    cue: "a rule that is stated without naming the file it applies to",
    lesson: "move the rule into rules/<topic>.md so it can be cited",
    evidence: "attempt-3 and attempt-4 both failed to cite it",
    confidence: { level: "high", why: "two independent failures under the same fingerprint" },
    ...overrides,
  }
}

const AT = "2026-11-03T00:00:00.000Z"

describe("addLesson", () => {
  it("files a new lesson and refuses the same claim spelled differently", () => {
    const first = addLesson(EMPTY_LIBRARY, lesson(), { at: AT })
    assert.equal(first.outcome, "added")
    assert.equal(first.library.entries.length, 1)

    const restated = lesson({
      cue: "A rule that is stated   without naming the file it applies to",
      evidence: "a third run failed the same way",
      confidence: { level: "low", why: "one more row" },
    })
    const second = addLesson(first.library, restated, { at: AT })
    assert.equal(second.outcome, "duplicate")
    assert.equal(second.library, first.library, "a duplicate must not rewrite the entry that exists")
    assert.equal(second.key, first.key)
    assert.equal(
      second.library.entries[0]?.lesson.evidence,
      lesson().evidence,
      "the original evidence survives the duplicate",
    )
  })

  it("files a genuinely different operation under its own key", () => {
    const first = addLesson(EMPTY_LIBRARY, lesson(), { at: AT })
    const second = addLesson(first.library, lesson({ lesson: "delete the rule instead" }), { at: AT })
    assert.equal(second.outcome, "added")
    assert.equal(second.library.entries.length, 2)
    assert.notEqual(second.key, first.key)
  })

  it("identifies a lesson by its claim, not by its evidence", () => {
    const base = lesson()
    const withOtherEvidence = lesson({ evidence: "completely different rows" })
    assert.equal(lessonKey(base), lessonKey(withOtherEvidence))
  })

  it("stays at the cap by evicting the weakest entry", () => {
    let library = EMPTY_LIBRARY
    for (let index = 0; index < LESSON_LIBRARY_CAP; index += 1) {
      const added = addLesson(
        library,
        lesson({
          cue: `situation ${index}`,
          lesson: `operation ${index}`,
          confidence: { level: "high", why: "measured" },
        }),
        { at: AT },
      )
      library = added.library
    }
    assert.equal(library.entries.length, LESSON_LIBRARY_CAP)

    const weakest = lesson({
      cue: "a weak one",
      lesson: "guess at a fix",
      confidence: { level: "low", why: "one confounded row" },
    })
    const overflowed = addLesson(library, weakest, { at: AT })
    assert.equal(overflowed.library.entries.length, LESSON_LIBRARY_CAP, "the cap is a cap, not a target")
    assert.ok(overflowed.evicted !== undefined)
    assert.equal(
      overflowed.evicted,
      lessonKey(weakest),
      "the incoming low-confidence lesson is the one that goes, since the rest are high",
    )
  })
})

describe("renderLongTermMemory", () => {
  it("writes one bullet per lesson, strongest first, and forges no extra bullets", () => {
    const withNewlines = lesson({
      cue: "a cue\n- **forged** -> extra",
      lesson: "an operation",
      confidence: { level: "medium", why: "measured" },
    })
    const library = addLesson(EMPTY_LIBRARY, withNewlines, { at: AT }).library
    const body = renderLongTermMemory(library)

    assert.equal(body.split("\n").filter((line) => line.startsWith("- ")).length, 1)
    assert.ok(body.includes("medium: measured"))
    assert.ok(body.includes("Evidence:"))
  })

  it("is byte-identical for the same library regardless of filing order", () => {
    const one = lesson({ cue: "situation one", lesson: "operation one" })
    const two = lesson({
      cue: "situation two",
      lesson: "operation two",
      confidence: { level: "low", why: "x" },
    })
    const forward = addLesson(addLesson(EMPTY_LIBRARY, one, { at: AT }).library, two, { at: AT }).library
    const backward = addLesson(addLesson(EMPTY_LIBRARY, two, { at: AT }).library, one, { at: AT }).library
    assert.equal(renderLongTermMemory(forward), renderLongTermMemory(backward))
  })

  it("says so when the library is empty instead of emitting a bare header", () => {
    assert.match(renderLongTermMemory(EMPTY_LIBRARY), /No lessons filed yet/)
  })
})

describe("applyLessonLibrary", () => {
  it("puts the rendered file where the memory slice will find it", () => {
    const library = addLesson(EMPTY_LIBRARY, lesson(), { at: AT }).library
    const tree = applyLessonLibrary({ "core.md": "be careful\n" }, library)

    assert.ok(Object.hasOwn(tree, LESSON_LIBRARY_PATH))
    assert.equal(tree["core.md"], "be careful\n")

    const memory = collectSlices({ tree, allowedTools: ["read_files"] }).find(
      (slice) => slice.id === "memory",
    )
    assert.ok(memory !== undefined, "the lesson library must reach the prompt through the memory slice")
    assert.ok(memory.text.includes("move the rule into rules/<topic>.md"))
  })

  it("leaves an empty library's tree untouched", () => {
    const tree = { "core.md": "x\n" }
    assert.equal(applyLessonLibrary(tree, EMPTY_LIBRARY), tree)
  })
})

describe("review regressions", () => {
  function fullLibrary(): { library: typeof EMPTY_LIBRARY; keys: string[] } {
    let library = EMPTY_LIBRARY
    const keys: string[] = []
    for (let index = 0; index < LESSON_LIBRARY_CAP; index += 1) {
      const added = addLesson(
        library,
        lesson({ cue: `situation ${index}`, lesson: `operation ${index}` }),
        { at: AT },
      )
      library = added.library
      keys.push(added.key)
    }
    return { library, keys }
  }

  it("reports a lesson it could not file as dropped, not added", () => {
    const { library, keys } = fullLibrary()
    const weak = lesson({
      cue: "a weak claim",
      lesson: "a guess",
      confidence: { level: "low", why: "one confounded row" },
    })
    const result = addLesson(library, weak, { at: AT })

    assert.equal(result.outcome, "dropped")
    assert.equal(result.library, library, "a dropped lesson leaves the library exactly as it was")
    assert.equal(result.evicted, lessonKey(weak))
    assert.ok(!result.library.entries.some((entry) => lessonKey(entry.lesson) === lessonKey(weak)))
    assert.ok(keys.length === LESSON_LIBRARY_CAP)
  })

  it("treats a restatement with different punctuation or backticks as the same claim", () => {
    const first = addLesson(EMPTY_LIBRARY, lesson({ lesson: "move the rule into `rules/x.md`" }), { at: AT })
    const restated = addLesson(
      first.library,
      lesson({ lesson: "Move the rule into rules/x.md." }),
      { at: AT },
    )
    assert.equal(restated.outcome, "duplicate")
  })

  it("canonicalises the filing instant and refuses one that is not a time", () => {
    const offset = addLesson(EMPTY_LIBRARY, lesson(), { at: "2026-11-03T01:00:00.000+01:00" })
    assert.equal(offset.library.entries[0]?.addedAt, AT, "the stored instant is canonical UTC")

    assert.throws(
      () => addLesson(EMPTY_LIBRARY, lesson({ cue: "other" }), { at: "yesterday" }),
      (error: unknown) => error instanceof Error && /not an ISO instant/.test(error.message),
    )
  })

  it("removes a stale memory file when the library is empty", () => {
    const stale = { "core.md": "x\n", [LESSON_LIBRARY_PATH]: "old lessons\n" }
    const emptied = applyLessonLibrary(stale, EMPTY_LIBRARY)
    assert.ok(!Object.hasOwn(emptied, LESSON_LIBRARY_PATH))
    assert.equal(emptied["core.md"], "x\n")

    const clean = { "core.md": "x\n" }
    assert.equal(applyLessonLibrary(clean, EMPTY_LIBRARY), clean, "nothing to remove, same object back")
  })
})
