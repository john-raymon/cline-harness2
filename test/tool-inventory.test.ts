import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { canonicalSha256 } from "../src/domain/canonical.ts"
import type { HarnessTree } from "../src/domain/schemas.ts"
import { PolicyError } from "../src/policy/errors.ts"
import { buildToolInventory, emptyToolInventory } from "../src/policy/inventory.ts"

/**
 * The inventory is the tree's claim about its own tools, so these tests are about derivation: the same
 * tools in a different insertion order must hash identically, and one changed description must not.
 */

function tree(files: Record<string, string>): HarnessTree {
  return files
}

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof PolicyError, `expected a PolicyError, got ${String(error)}`)
    return error.code
  }
  assert.fail("expected this call to fail")
}

describe("tool inventory", () => {
  it("derives entries from tools/<name>.md, sorted by name", () => {
    const inventory = buildToolInventory(
      tree({
        "tools/write_to_file.md": "Write a file.\n",
        "tools/read_file.md": "Read a file.\n",
        "README.md": "not a tool\n",
        ".clinerules/rules.md": "not a tool either\n",
      }),
    )
    assert.deepEqual(
      inventory.tools.map((tool) => tool.name),
      ["read_file", "write_to_file"],
    )
    assert.deepEqual(inventory.tools[0]?.descriptionPath, "tools/read_file.md")
    assert.equal(inventory.tools[0]?.descriptionSha256, canonicalSha256("Read a file.\n"))
  })

  it("hashes the inventory, not the order it was written in", () => {
    const first = buildToolInventory(
      tree({ "tools/a.md": "A.\n", "tools/b.md": "B.\n" }),
    )
    const second = buildToolInventory(
      tree({ "tools/b.md": "B.\n", "tools/a.md": "A.\n" }),
    )
    assert.equal(first.hash, second.hash)
  })

  it("changes the hash when a description changes by one byte", () => {
    const before = buildToolInventory(tree({ "tools/a.md": "Read a file.\n" }))
    const after = buildToolInventory(tree({ "tools/a.md": "Read a file!\n" }))
    assert.notEqual(before.hash, after.hash)
  })

  it("treats a tree with no tools as a real, empty inventory", () => {
    const inventory = buildToolInventory(tree({ "README.md": "# hi\n" }))
    assert.deepEqual(inventory, emptyToolInventory())
    assert.equal(inventory.tools.length, 0)
    assert.equal(inventory.hash, emptyToolInventory().hash)
  })

  it("refuses anything under tools/ that is not exactly <name>.md", () => {
    assert.equal(codeOf(() => buildToolInventory(tree({ "tools/nested/a.md": "A.\n" }))), "TOOL_INVENTORY_INVALID")
    assert.equal(codeOf(() => buildToolInventory(tree({ "tools/a.txt": "A.\n" }))), "TOOL_INVENTORY_INVALID")
    assert.equal(codeOf(() => buildToolInventory(tree({ tools: "A.\n" }))), "TOOL_INVENTORY_INVALID")
  })

  it("refuses a tool name a case-insensitive file system would merge", () => {
    // `Foo` is refused by the name rule rather than folded to `foo`: materialising both would collide on
    // APFS, and a silently merged inventory is not the inventory that was written.
    assert.equal(codeOf(() => buildToolInventory(tree({ "tools/Foo.md": "A.\n" }))), "TOOL_NAME_INVALID")
    assert.equal(codeOf(() => buildToolInventory(tree({ "tools/1tool.md": "A.\n" }))), "TOOL_NAME_INVALID")
    assert.equal(codeOf(() => buildToolInventory(tree({ "tools/.md": "A.\n" }))), "TOOL_NAME_INVALID")
  })

  it("refuses a tool nobody could choose", () => {
    assert.equal(codeOf(() => buildToolInventory(tree({ "tools/a.md": "   \n" }))), "TOOL_DESCRIPTION_EMPTY")
    assert.equal(
      codeOf(() => buildToolInventory(tree({ "tools/a.md": "x".repeat(4001) }))),
      "TOOL_INVENTORY_INVALID",
    )
  })
})
