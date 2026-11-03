import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { HarnessTree } from "../src/domain/schemas.ts"
import { ALWAYS_ON_BUDGET_CHARS } from "../src/prompt/budget.ts"
import { compilePrompt } from "../src/prompt/compile.ts"
import { PromptError } from "../src/prompt/errors.ts"
import {
  assertToolEntryBudget,
  collectSkills,
  declaredToolEntries,
  DEFAULT_TOOL_ENTRY_BUDGET,
  SKILLS_TOOL_NAME,
} from "../src/prompt/skills.ts"
import { buildToolInventory } from "../src/policy/inventory.ts"

const MARKER = "SKILL-BODY-MARKER-9f3c"

function skillTree(count = 1, chars = 120): HarnessTree {
  const tree: HarnessTree = {}
  for (let index = 0; index < count; index += 1) {
    tree[`.cline/skills/skill-${String(index)}/SKILL.md`] = `# skill ${String(index)}\n${MARKER}\n${"x".repeat(chars)}\n`
  }
  return tree
}

function codeOf(operation: () => unknown): string {
  try {
    operation()
  } catch (error) {
    assert.ok(error instanceof PromptError, `expected PromptError, got ${String(error)}`)
    return error.code
  }
  assert.fail("expected a rejection")
}

describe("skill inventory", () => {
  it("accepts companion files and folds them into the skill's identity", () => {
    const base: HarnessTree = {
      ".cline/skills/a/SKILL.md": "# a\nbody\n",
      ".cline/skills/a/references/guide.md": "reference\n",
    }
    const edited: HarnessTree = {
      ...base,
      ".cline/skills/a/references/guide.md": "reference, edited\n",
    }
    const inventory = collectSkills(base)
    assert.equal(inventory.skills.length, 1)
    assert.deepEqual(inventory.skills[0]?.files, [
      ".cline/skills/a/SKILL.md",
      ".cline/skills/a/references/guide.md",
    ])
    // The reference never reaches the prompt, but it changes the skill the harness mounts.
    assert.notEqual(collectSkills(edited).hash, inventory.hash)
    // A directory with companions but no SKILL.md is still not a skill.
    assert.equal(
      codeOf(() => collectSkills({ ".cline/skills/a/references/guide.md": "reference\n" })),
      "SKILL_INVALID",
    )
  })

  it("reads one skill per .cline/skills/<name>/SKILL.md", () => {
    const inventory = collectSkills(skillTree(2))
    assert.deepEqual(
      inventory.skills.map((skill) => skill.name),
      ["skill-0", "skill-1"],
    )
    assert.equal(inventory.skills[0]?.path, ".cline/skills/skill-0/SKILL.md")
    assert.equal(inventory.skills[0]?.body.includes(MARKER), true)
  })

  it("treats a tree with no skills directory as empty rather than broken", () => {
    const inventory = collectSkills({ "systemprompt.md": "be brief\n" })
    assert.deepEqual(inventory.skills, [])
    assert.equal(typeof inventory.hash, "string")
  })

  it("refuses a directory that is not exactly one SKILL.md", () => {
    assert.equal(codeOf(() => collectSkills({ ".cline/skills/a/b/SKILL.md": "nested\n" })), "SKILL_INVALID")
    assert.equal(codeOf(() => collectSkills({ ".cline/skills/a/NOTES.md": "stray\n" })), "SKILL_INVALID")
  })

  it("refuses a name the operator could not type consistently", () => {
    for (const name of ["Bad Name", "Upper", "-leading", ".hidden", "a".repeat(65)]) {
      assert.equal(
        codeOf(() => collectSkills({ [`.cline/skills/${name}/SKILL.md`]: "body\n" })),
        "SKILL_INVALID",
        `${name} should be refused`,
      )
    }
  })

  it("refuses an empty skill body", () => {
    assert.equal(
      codeOf(() => collectSkills({ ".cline/skills/blank/SKILL.md": "   \n\t\n" })),
      "SKILL_INVALID",
    )
  })

  it("changes its hash when a body changes", () => {
    const before = collectSkills(skillTree(1))
    const after = collectSkills({ ...skillTree(1), ".cline/skills/skill-0/SKILL.md": "# edited\n" })
    assert.notEqual(after.hash, before.hash)
  })
})

describe("the tool-entry budget", () => {
  const inventory = buildToolInventory({ "tools/run_commands.md": "Run shell commands.\n" })

  it("counts a skill as exactly one entry, however many exist", () => {
    assert.equal(declaredToolEntries(inventory, collectSkills({})), 1)
    assert.equal(declaredToolEntries(inventory, collectSkills(skillTree(1))), 2)
    assert.equal(declaredToolEntries(inventory, collectSkills(skillTree(12))), 2)
  })

  it("counts the built-in once even when the tree also declares it", () => {
    const declared = buildToolInventory({ "tools/skills.md": "Load a skill.\n" })
    assert.equal(declaredToolEntries(declared, collectSkills(skillTree(2))), 1)
  })

  it("refuses a harness whose declared entries plus a skill exceed the budget", () => {
    const many: HarnessTree = {}
    for (let index = 0; index < DEFAULT_TOOL_ENTRY_BUDGET; index += 1) {
      many[`tools/tool_${String(index)}.md`] = "A tool.\n"
    }
    const withoutSkill = buildToolInventory(many)
    assert.equal(declaredToolEntries(withoutSkill, collectSkills({})), DEFAULT_TOOL_ENTRY_BUDGET)
    assert.equal(codeOf(() => assertToolEntryBudget(declaredToolEntries(withoutSkill, collectSkills(skillTree(1))))), "TOOL_ENTRY_BUDGET_EXCEEDED")
  })

  it("names the built-in tool the entry buys", () => {
    assert.equal(SKILLS_TOOL_NAME, "skills")
  })

  it("accepts the budget and refuses one over it", () => {
    assert.equal(assertToolEntryBudget(DEFAULT_TOOL_ENTRY_BUDGET), DEFAULT_TOOL_ENTRY_BUDGET)
    assert.equal(codeOf(() => assertToolEntryBudget(DEFAULT_TOOL_ENTRY_BUDGET + 1)), "TOOL_ENTRY_BUDGET_EXCEEDED")
  })
})

describe("skills cost identity, not bytes", () => {
  it("keeps the body out of the prompt and out of the character count", () => {
    const withoutSkills = compilePrompt({ tree: { "systemprompt.md": "be brief\n" }, task: "Say ok" })
    const withSkills = compilePrompt({
      tree: { ...skillTree(3, 30_000), "systemprompt.md": "be brief\n" },
      task: "Say ok",
    })

    assert.equal(withSkills.systemPrompt.includes(MARKER), false)
    assert.equal(withSkills.alwaysOnChars, withoutSkills.alwaysOnChars)
    assert.equal(withSkills.systemPrompt, withoutSkills.systemPrompt)
    assert.equal(withSkills.slices.some((slice) => slice.id === "skills"), true)
    assert.equal(withSkills.slices.find((slice) => slice.id === "skills")?.chars, 0)
    // The same bytes in a rule file would have blown the always-on budget instead.
    assert.equal(
      codeOf(() =>
        compilePrompt({ tree: { "systemprompt.md": "x".repeat(ALWAYS_ON_BUDGET_CHARS) }, task: "Say ok" }),
      ),
      "PROMPT_TOO_LARGE",
    )
  })

  it("names the skill paths in the slice, so the fingerprint records what was mounted", () => {
    const prompt = compilePrompt({ tree: skillTree(2), task: "Say ok" })
    const slice = prompt.slices.find((entry) => entry.id === "skills")
    assert.deepEqual(slice?.paths, [
      ".cline/skills/skill-0/SKILL.md",
      ".cline/skills/skill-1/SKILL.md",
    ])
  })
})
