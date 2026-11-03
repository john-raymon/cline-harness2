import { lessonSchema, type Lesson } from "../domain/schemas.ts"
import type { OracleReply, Reflector } from "../oracle/client.ts"
import type { RawContextSource } from "../oracle/context.ts"
import type { ImproveErrorCode } from "./errors.ts"

/**
 * Turning failures into a lesson.
 *
 * A reflection is only worth keeping if it is transferable: `cue` names the *shape* of the situation
 * rather than this task's facts, `lesson` is an operation on a harness that names a component, and
 * `evidence` cites the rows it rests on. The confidence carries its reason because a bare "high" is a
 * claim with nothing behind it.
 *
 * Four labelled lines is a low bar for a model and a high bar for a parser: anything that cannot fill
 * them is refused, not interpreted.
 */

export const DEFAULT_REFLECTOR_ASK =
  "Extract at most one transferable lesson from these failures: the shape of the situation, the " +
  "operation on a harness that addresses it, and the rows it rests on."

const HORIZONTAL = "[^\\S\\r\\n]*"

const FIELD_LINES: Readonly<Record<"cue" | "lesson" | "evidence" | "confidence", RegExp>> = {
  // `[^\S\r\n]*` rather than `\s*`: in multiline mode `\s` matches a newline, so `CUE:` followed by an
  // empty line would capture the *next* line and one line could satisfy two fields at once.
  cue: new RegExp(`^CUE:${HORIZONTAL}(.+?)${HORIZONTAL}$`, "gm"),
  lesson: new RegExp(`^LESSON:${HORIZONTAL}(.+?)${HORIZONTAL}$`, "gm"),
  evidence: new RegExp(`^EVIDENCE:${HORIZONTAL}(.+?)${HORIZONTAL}$`, "gm"),
  confidence: new RegExp(`^CONFIDENCE:${HORIZONTAL}(.+?)${HORIZONTAL}$`, "gm"),
}

const LEVELS = ["high", "medium", "low"] as const
const LEVEL_PREFIX = /^(high|medium|low)\b[\s,;:.–—-]*(.*)$/i

export interface ReflectInput {
  readonly reflector: Reflector
  /** The failure rows, as raw files. Reflecting on nothing is refused rather than guessed at. */
  readonly failures: readonly RawContextSource[]
  readonly ask?: string
  readonly timeoutMs?: number
}

export type ReflectionResult =
  | { readonly status: "reflected"; readonly reply: OracleReply; readonly lesson: Lesson }
  | {
      readonly status: "refused"
      readonly code: ImproveErrorCode
      readonly reason: string
      readonly reply?: OracleReply
    }

export type ParsedReflection =
  | { readonly ok: true; readonly lesson: Lesson }
  | { readonly ok: false; readonly code: ImproveErrorCode; readonly reason: string }

/**
 * Parse the four labelled lines into a `Lesson`.
 *
 * A refusal carries its own code rather than a free-text message that the caller has to interpret: the
 * difference between "there was nothing to read" and "there was something, but it was short" is what a
 * run records, and deriving it from the wording of an error would break the moment the wording changed.
 */
export function parseReflection(text: string): ParsedReflection {
  const found: Record<string, string> = {}
  const repeated: string[] = []
  for (const [field, pattern] of Object.entries(FIELD_LINES)) {
    const values = [...text.matchAll(pattern)]
      .map((match) => (match[1] ?? "").trim())
      .filter((value) => value.length > 0)
    const first = values.at(0)
    if (first === undefined) continue
    if (values.length > 1) repeated.push(field.toUpperCase())
    found[field] = first
  }

  if (repeated.length > 0) {
    return {
      ok: false,
      code: "REFLECTION_INCOMPLETE",
      reason: `the reply states ${repeated.join(", ")} more than once; at most one lesson is allowed`,
    }
  }

  const fields = Object.keys(FIELD_LINES)
  const missing = fields.filter((field) => found[field] === undefined)
  if (missing.length === fields.length) {
    return {
      ok: false,
      code: "REFLECTION_UNPARSEABLE",
      reason: `the reply contains none of the four lesson lines (${fields.join(", ")})`,
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      code: "REFLECTION_INCOMPLETE",
      reason: `the reply is missing ${missing.map((field) => field.toUpperCase()).join(", ")}`,
    }
  }

  const confidence = LEVEL_PREFIX.exec(found["confidence"] ?? "")
  if (confidence === null) {
    return {
      ok: false,
      code: "REFLECTION_INCOMPLETE",
      reason: `CONFIDENCE must start with one of ${LEVELS.join(" | ")}; got ${JSON.stringify(
        found["confidence"],
      )}`,
    }
  }
  const level = (confidence[1] ?? "").toLowerCase()
  const why = (confidence[2] ?? "").trim()
  if (why.length === 0) {
    return {
      ok: false,
      code: "REFLECTION_INCOMPLETE",
      reason: "CONFIDENCE must carry its reason; a bare level is a claim with nothing behind it",
    }
  }

  const parsed = lessonSchema.safeParse({
    cue: found["cue"],
    lesson: found["lesson"],
    evidence: found["evidence"],
    confidence: { level, why },
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ok: false,
      code: "REFLECTION_INCOMPLETE",
      reason: issue === undefined ? "no issue reported" : `${issue.path.join(".")}: ${issue.message}`,
    }
  }
  return { ok: true, lesson: parsed.data }
}

export async function reflect(input: ReflectInput): Promise<ReflectionResult> {
  if (input.failures.length === 0) {
    return {
      status: "refused",
      code: "REFLECTION_INCOMPLETE",
      reason: "there are no failure rows to reflect on; a lesson invented without evidence is a guess",
    }
  }

  const reply = await input.reflector.reflect({
    ask: input.ask === undefined || input.ask.trim().length === 0 ? DEFAULT_REFLECTOR_ASK : input.ask,
    context: input.failures,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  })

  const parsed = parseReflection(reply.text)
  if (!parsed.ok) {
    return { status: "refused", code: parsed.code, reply, reason: parsed.reason }
  }
  return { status: "reflected", reply, lesson: parsed.lesson }
}
