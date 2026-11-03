import { canonicalSha256 } from "../domain/canonical.ts"
import type { HarnessTree } from "../domain/schemas.ts"
import { PromptError } from "./errors.ts"

/**
 * The skills mount (c6).
 *
 * B1 established that `<cwd>/.cline/skills/<name>/SKILL.md` makes a skill visible, and that the body is
 * *not* inlined: the built-in `skills` tool loads it on demand. So a skill costs one tool entry and zero
 * always-on characters, no matter how large its body is. This module makes that accounting explicit
 * instead of leaving it as a property nobody checks.
 */

export const SKILLS_ROOT = ".cline/skills"
export const SKILL_FILE = "SKILL.md"
/** The built-in tool the SDK exposes when a skill directory exists. */
export const SKILLS_TOOL_NAME = "skills"
/**
 * Lowercase, no spaces, no path separators.
 *
 * The name is a directory name and a string the operator types at the model, so a name that needs
 * trimming or case-folding is a name two harnesses can spell differently and mean the same thing.
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

export interface Skill {
  readonly name: string
  /** Tree path of the `SKILL.md` that defines it. */
  readonly path: string
  readonly body: string
  /** Every path the skill directory holds, `SKILL.md` included, sorted. */
  readonly files: readonly string[]
  /** Identity of the whole skill directory, companions included — they are bytes the model can load. */
  readonly sha256: string
  readonly chars: number
}

export interface SkillInventory {
  readonly skills: readonly Skill[]
  readonly hash: string
}

function fail(message: string): never {
  throw new PromptError("SKILL_INVALID", message)
}

/**
 * Read every skill the tree declares, and refuse anything that is not one.
 *
 * A skill is a directory holding `SKILL.md`; a directory without one is a directory the SDK ignores
 * while the operator believes a skill is mounted. Companion files (`references/`, `scripts/`) are legal
 * and part of the skill's identity — the model can load them on demand — but they are never prompt
 * text, so they cost bytes only when asked for. A file directly under `.cline/skills/` is neither, so
 * it is refused rather than guessed at.
 */
export function collectSkills(tree: HarnessTree): SkillInventory {
  const prefix = `${SKILLS_ROOT}/`
  const directories = new Map<string, { path: string; body: string }[]>()

  for (const path of Object.keys(tree).sort()) {
    if (!path.startsWith(prefix)) continue
    const segments = path.slice(prefix.length).split("/")
    const name = segments[0] ?? ""
    if (segments.length < 2) {
      fail(`${path} is a file directly under ${SKILLS_ROOT}; a skill is a directory holding ${SKILL_FILE}`)
    }
    if (!SKILL_NAME_PATTERN.test(name)) {
      fail(
        `${path} has an unusable skill name ${JSON.stringify(name)}; expected lowercase letters, ` +
          "digits, dot, dash or underscore",
      )
    }
    const files = directories.get(name) ?? []
    files.push({ path, body: tree[path] ?? "" })
    directories.set(name, files)
  }

  const skills: Skill[] = []
  for (const name of [...directories.keys()].sort()) {
    const files = (directories.get(name) ?? []).sort((left, right) =>
      left.path === right.path ? 0 : left.path < right.path ? -1 : 1,
    )
    const definition = files.find((file) => file.path === `${prefix}${name}/${SKILL_FILE}`)
    if (definition === undefined) {
      fail(
        `${prefix}${name}/ has no ${SKILL_FILE}; the SDK would ignore the directory while the harness ` +
          "reported a mounted skill",
      )
    }
    if (definition.body.trim().length === 0) {
      fail(`${definition.path} is empty; a skill with no instructions costs a tool entry and says nothing`)
    }
    skills.push({
      name,
      path: definition.path,
      body: definition.body,
      files: files.map((file) => file.path),
      sha256: canonicalSha256({
        skill: name,
        files: files.map((file) => ({ path: file.path, sha256: canonicalSha256(file.body) })),
      }),
      chars: definition.body.length,
    })
  }

  const hash = canonicalSha256({
    kind: "skills",
    version: 1,
    skills: skills.map((skill) => ({ name: skill.name, path: skill.path, sha256: skill.sha256 })),
  })
  return { skills, hash }
}

/**
 * How many tool entries the harness declares.
 *
 * A skill is not a tool entry of its own: however many skills exist, the SDK exposes the single
 * built-in `skills` tool, so the cost is one whether the tree ships one skill or forty. It is a *union*
 * with the declared inventory rather than a sum, because a tree that already describes `skills` under
 * `tools/` must not be charged twice for the same entry. Bodies are deliberately absent from this count
 * — they are bytes the model only sees after it asks.
 */
export function declaredToolEntries(
  inventory: { readonly tools: readonly { readonly name: string }[] },
  skills: SkillInventory,
): number {
  const names = new Set(inventory.tools.map((tool) => tool.name))
  if (skills.skills.length > 0) names.add(SKILLS_TOOL_NAME)
  return names.size
}

export const DEFAULT_TOOL_ENTRY_BUDGET = 64

export function assertToolEntryBudget(entries: number, budget: number = DEFAULT_TOOL_ENTRY_BUDGET): number {
  if (!Number.isSafeInteger(entries) || entries < 0) {
    throw new PromptError("TOOL_ENTRY_BUDGET_EXCEEDED", `tool entry count must be a non-negative integer, got ${String(entries)}`)
  }
  if (entries > budget) {
    throw new PromptError(
      "TOOL_ENTRY_BUDGET_EXCEEDED",
      `the harness declares ${entries} tool entries, over the ${budget}-entry budget; every entry is ` +
        "always-on context the model pays for on every request",
    )
  }
  return entries
}
