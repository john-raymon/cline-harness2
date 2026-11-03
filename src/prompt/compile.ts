import { canonicalSha256 } from "../domain/canonical.ts"
import type { HarnessTree } from "../domain/schemas.ts"
import { ALWAYS_ON_BUDGET_CHARS, assertAlwaysOnBudget } from "./budget.ts"
import { PromptError } from "./errors.ts"
import { collectSlices, type SliceId } from "./slices.ts"
import { collectSkills, type Skill } from "./skills.ts"

/**
 * The prompt a session is started with, compiled from the harness tree.
 *
 * Chunk 5 shipped a constant producer so a session could be proven to start; it is gone. Everything
 * standing in the system prompt now comes from `e_0`'s tree, so `compiledPromptHash` is a statement
 * about the harness rather than about this file.
 */

/** Bumped when the *text* changes shape, because `sha256` hashes it. */
export const PROMPT_VERSION = 2
/** Bumped when the *hash envelope* changes shape, because `compiledPromptHash` identifies a harness. */
export const COMPILED_PROMPT_VERSION = 1

export const PROMPT_SOURCES = ["compiled"] as const
export type PromptSource = (typeof PROMPT_SOURCES)[number]

export interface CompiledSlice {
  readonly id: SliceId
  readonly paths: readonly string[]
  readonly chars: number
  readonly sha256: string
}

export interface CompiledPrompt {
  readonly source: PromptSource
  readonly systemPrompt: string
  readonly taskPrompt: string
  /** Hash of the literal text, task included. Two sessions differ when their tasks differ. */
  readonly sha256: string
  /**
   * Hash of what the harness contributed, task excluded.
   *
   * A fingerprint compares harnesses, not tasks: the same `e_0` with a different task is the same
   * harness, and mixing the task in would make every probe look like a fresh baseline. `sha256` keeps
   * the task-bearing identity for the ledger, which does want to tell two turns apart.
   */
  readonly compiledPromptHash: string
  readonly slices: readonly CompiledSlice[]
  readonly alwaysOnChars: number
}

/**
 * Hash over the labelled envelope, not just the concatenation.
 *
 * An empty task under a rule-only prompt is a different prompt from the same bytes split the other
 * way, and the ledger compares these hashes.
 */
export function promptSha256(input: {
  source: PromptSource
  systemPrompt: string
  taskPrompt: string
}): string {
  return canonicalSha256({
    version: PROMPT_VERSION,
    source: input.source,
    systemPrompt: input.systemPrompt,
    taskPrompt: input.taskPrompt,
  })
}

/**
 * Identity of the compiled harness.
 *
 * Each slice contributes its id, the paths it read, and the digest of the text it rendered, so the
 * hash moves when a body changes, when a file appears or disappears, and when a whole slice appears —
 * and does not move for a tree key that no slice reads, or for a different object key order.
 */
export function compiledPromptHashOf(slices: readonly CompiledSlice[]): string {
  return canonicalSha256({
    version: COMPILED_PROMPT_VERSION,
    slices: slices.map((slice) => ({
      id: slice.id,
      paths: slice.paths,
      sha256: slice.sha256,
    })),
  })
}

export interface CompilePromptInput {
  readonly tree: HarnessTree
  readonly task: string
  /** Tools the policy permits; rendered into the core slice and hashed with it. */
  readonly allowedTools?: readonly string[]
  readonly budget?: number
  /**
   * Skills already collected by the caller.
   *
   * Passing them keeps one collection per session; omitting them makes the compiler collect its own, so
   * a bare `compilePrompt({ tree, task })` still describes the harness it is given.
   */
  readonly skills?: readonly Skill[]
}

export function compilePrompt(input: CompilePromptInput): CompiledPrompt {
  if (input.task.trim().length === 0) {
    throw new PromptError(
      "PROMPT_TASK_INVALID",
      "the task prompt is empty; a session started with it could only produce a meaningless turn",
    )
  }

  const rendered = collectSlices({
    tree: input.tree,
    allowedTools: input.allowedTools ?? [],
    skills: input.skills ?? collectSkills(input.tree).skills,
  })
  // No separator: every rendered block is newline-terminated, so the join is exact and
  // `alwaysOnChars` stays equal to `systemPrompt.length` instead of drifting by a join cost.
  const systemPrompt = rendered.map((slice) => slice.text).join("")
  const alwaysOnChars = assertAlwaysOnBudget(
    rendered,
    systemPrompt,
    input.budget ?? ALWAYS_ON_BUDGET_CHARS,
  )
  const slices: readonly CompiledSlice[] = rendered.map((slice) => ({
    id: slice.id,
    paths: slice.paths,
    chars: slice.chars,
    sha256: slice.sha256,
  }))
  const source: PromptSource = "compiled"

  return {
    source,
    systemPrompt,
    taskPrompt: input.task,
    sha256: promptSha256({ source, systemPrompt, taskPrompt: input.task }),
    compiledPromptHash: compiledPromptHashOf(slices),
    slices,
    alwaysOnChars,
  }
}
