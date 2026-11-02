import assert from "node:assert/strict"
import fsPromises from "node:fs/promises"
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { afterEach, describe, it } from "node:test"
import os from "node:os"
import path from "node:path"

import { canonicalSha256 } from "../src/domain/canonical.ts"
import {
  TREE_LIMITS,
  applyTreePatch,
  diffTrees,
  treePatchSchema,
} from "../src/domain/schemas.ts"
import { TreeStoreError, materialiseTree, readTree } from "../src/harness/tree-store.ts"

const scratchRoots: string[] = []

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness2-tree-"))
  scratchRoots.push(root)
  return root
}

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** The rejection code, asserted to be a `TreeStoreError` first. */
async function codeOf(operation: Promise<unknown>): Promise<string> {
  try {
    await operation
  } catch (error) {
    assert.ok(error instanceof TreeStoreError, `expected TreeStoreError, got ${String(error)}`)
    return error.code
  }
  assert.fail("expected a rejection")
}

describe("materialise and read back (V1)", () => {
  it("round-trips a tree byte for byte, BOM and CRLF included", async () => {
    const parent = await scratch()
    const tree = {
      "systemprompt.md": "line one\r\nline two\r\n",
      "guardrails.md": "",
      "bom.md": "\uFEFFleading bom kept",
      "no-final-newline.md": "trailing",
      "caf\u00e9.md": "nfc name",
      ".env": "SECRET=1",
      "skills/pdf-tables/SKILL.md": "# skill\n",
      "skills/pdf-tables/scripts/pack.ts": "export const x = 1\n",
      "sub_agents/auditor/AGENT.md": "audit\n",
    }

    const { dir, files } = await materialiseTree({ dir: path.join(parent, "run"), tree })
    assert.deepEqual(files, Object.keys(tree).sort())

    const back = await readTree({ dir })
    assert.deepEqual(back, tree)
    assert.equal(canonicalSha256(back), canonicalSha256(tree), "hashes must agree after a round trip")
  })

  it("returns an empty tree for an empty root", async () => {
    const parent = await scratch()
    const dir = path.join(parent, "empty")
    await mkdir(dir)
    assert.deepEqual(await readTree({ dir }), {})
  })
})

describe("preflight writes nothing (V2, V3, V4)", () => {
  it("rejects an impossible tree before creating the directory", async () => {
    const parent = await scratch()
    const dir = path.join(parent, "run")

    assert.equal(
      await codeOf(materialiseTree({ dir, tree: { a: "x", "a/b": "y" } })),
      "NOT_MATERIALISABLE",
    )
    assert.equal(
      await codeOf(
        materialiseTree({ dir, tree: { "SystemPrompt.md": "x", "systemprompt.md": "y" } }),
      ),
      "NOT_MATERIALISABLE",
    )
    assert.equal(
      await codeOf(materialiseTree({ dir, tree: { "A/x.md": "x", "a/y.md": "y" } })),
      "NOT_MATERIALISABLE",
    )
    await assert.rejects(stat(dir), "zero mutations: the directory must never have been created")
  })

  it("rejects an unopenable name or an unpaired surrogate before touching the disk", async () => {
    const parent = await scratch()
    const dir = path.join(parent, "run")

    for (const tree of [
      { "note:stream": "x" },
      { "a?.md": "x" },
      { "COM\u00b9.txt": "x" },
      { "a\ud800b.md": "x" },
      { "a.md": "bad\ud800body" },
    ]) {
      assert.equal(await codeOf(materialiseTree({ dir, tree })), "INVALID_PATH", JSON.stringify(tree))
    }
    await assert.rejects(stat(dir))
  })

  it("rejects a tree over the shared limits before writing", async () => {
    const parent = await scratch()
    const dir = path.join(parent, "run")
    assert.equal(
      await codeOf(
        materialiseTree({ dir, tree: { "big.md": "x".repeat(TREE_LIMITS.maxFileBytes + 1) } }),
      ),
      "NOT_MATERIALISABLE",
    )
    await assert.rejects(stat(dir))
  })
})

describe("directory ownership (V5)", () => {
  it("refuses an existing directory and leaves the operator's files alone", async () => {
    const parent = await scratch()
    const dir = path.join(parent, "taken")
    await mkdir(dir)
    await writeFile(path.join(dir, "mine.md"), "operator file")

    assert.equal(await codeOf(materialiseTree({ dir, tree: { "a.md": "x" } })), "DIR_EXISTS")
    assert.equal(await readFile(path.join(dir, "mine.md"), "utf8"), "operator file")
  })
})

describe("symlinks (V6)", () => {
  it("refuses a symlinked root for both write and read", async () => {
    const parent = await scratch()
    const real = path.join(parent, "real")
    await mkdir(real)
    const link = path.join(parent, "link")
    await symlink(real, link)

    assert.equal(await codeOf(materialiseTree({ dir: link, tree: { "a.md": "x" } })), "SYMLINK_FORBIDDEN")
    assert.equal(await codeOf(readTree({ dir: link })), "SYMLINK_FORBIDDEN")
  })

  it("refuses a symlinked entry instead of reporting it as a deletion", async () => {
    const parent = await scratch()
    const workspace = path.join(parent, "workspace")
    await mkdir(workspace)
    const outside = path.join(parent, "outside.md")
    await writeFile(outside, "reachable only through the link")
    await symlink(outside, path.join(workspace, "guardrails.md"))

    assert.equal(await codeOf(readTree({ dir: workspace })), "SYMLINK_FORBIDDEN")
  })
})

describe("encoding and limits on read (V7, V8)", () => {
  it("refuses bytes that are not UTF-8 rather than replacing them", async () => {
    const parent = await scratch()
    const dir = path.join(parent, "ws")
    await mkdir(dir)
    await writeFile(path.join(dir, "bad.md"), Buffer.from([0xff, 0xfe, 0x00, 0x41]))

    assert.equal(await codeOf(readTree({ dir })), "NOT_UTF8")
  })

  it("refuses a file over the per-file cap on read, at the boundary", async () => {
    const parent = await scratch()
    const dir = path.join(parent, "ws")
    await mkdir(dir)
    await writeFile(path.join(dir, "at-limit.md"), "x".repeat(TREE_LIMITS.maxFileBytes))
    await writeFile(path.join(dir, "over.md"), "x".repeat(TREE_LIMITS.maxFileBytes + 1))

    assert.equal(await codeOf(readTree({ dir })), "TOO_LARGE")

    await rm(path.join(dir, "over.md"))
    const back = await readTree({ dir })
    assert.equal(back["at-limit.md"]?.length, TREE_LIMITS.maxFileBytes, "the boundary itself is legal")
  })

  it("refuses more files than the file cap", async () => {
    const parent = await scratch()
    const dir = path.join(parent, "ws")
    await mkdir(dir)
    for (let index = 0; index <= TREE_LIMITS.maxFiles; index += 1) {
      await writeFile(path.join(dir, `f${index}.md`), "")
    }
    assert.equal(await codeOf(readTree({ dir })), "TOO_MANY_FILES")
  })

  it("refuses an empty subdirectory, which a tree cannot represent", async () => {
    const parent = await scratch()
    const dir = path.join(parent, "ws")
    await mkdir(path.join(dir, "hollow"), { recursive: true })
    assert.equal(await codeOf(readTree({ dir })), "UNSUPPORTED_ENTRY")
  })

  it("distinguishes a missing root from an empty one", async () => {
    const parent = await scratch()
    assert.equal(await codeOf(readTree({ dir: path.join(parent, "nope") })), "MISSING_ROOT")

    const file = path.join(parent, "a-file")
    await writeFile(file, "x")
    assert.equal(await codeOf(readTree({ dir: file })), "NOT_A_DIRECTORY")
  })
})

describe("hardlinks and inherited keys on disk (blocker regression)", () => {
  it("refuses a hardlinked file instead of copying bytes from outside the workspace", async () => {
    const parent = await scratch()
    const dir = path.join(parent, "ws")
    await mkdir(dir)
    const outside = path.join(parent, "id_rsa")
    await writeFile(outside, "private key material")
    await link(outside, path.join(dir, "innocent.md"))

    assert.equal(await codeOf(readTree({ dir })), "HARDLINK_FORBIDDEN")
  })

  it("round-trips a file literally named toString", async () => {
    const parent = await scratch()
    const tree = { "toString": "not a function", "notes.md": "x" }
    const { dir } = await materialiseTree({ dir: path.join(parent, "run"), tree })

    const back = await readTree({ dir })
    assert.deepEqual(back, tree)
    assert.deepEqual(diffTrees(tree, back), { added: [], modified: [], removed: [] })
  })
})

describe("rollback (V11)", () => {
  it("waits for in-flight writes before removing the directory it created", async () => {
    const parent = await scratch()
    const dir = path.join(parent, "run")
    const originalWrite = fsPromises.writeFile
    const originalRm = fsPromises.rm
    const events: string[] = []
    let calls = 0

    fsPromises.writeFile = (async (...args: Parameters<typeof fsPromises.writeFile>) => {
      calls += 1
      if (calls === 1) throw new Error("injected write failure")
      // The sibling write is still in flight when the failure is raised; cleanup must wait for it.
      await new Promise((resolve) => setTimeout(resolve, 25))
      const result = await originalWrite(...args)
      events.push("write-finished")
      return result
    }) as typeof fsPromises.writeFile

    fsPromises.rm = (async (...args: Parameters<typeof fsPromises.rm>) => {
      events.push("cleanup")
      return originalRm(...args)
    }) as typeof fsPromises.rm

    syncBuiltinESMExports()
    try {
      await assert.rejects(
        materialiseTree({ dir, tree: { "a.md": "x", "b.md": "y" } }),
        (error: unknown) => {
          assert.ok(error instanceof TreeStoreError)
          assert.equal(error.code, "WRITE_FAILED")
          assert.match(error.message, /could not write/)
          assert.equal(error.cleanupError, undefined, "cleanup succeeded, so nothing to report")
          const inner = error.cause
          assert.ok(inner instanceof TreeStoreError, "the write failure is the cause")
          assert.match(String((inner.cause as Error).message), /injected write failure/)
          return true
        },
      )
    } finally {
      fsPromises.writeFile = originalWrite
      fsPromises.rm = originalRm
      syncBuiltinESMExports()
    }

    assert.deepEqual(events, ["write-finished", "cleanup"], "cleanup must not race a live writer")
    await assert.rejects(stat(dir), "the owned directory must not survive a failed write")
  })

  it("keeps the write failure as the cause when cleanup itself fails", async () => {
    const parent = await scratch()
    const dir = path.join(parent, "run")
    const originalWrite = fsPromises.writeFile
    const originalRm = fsPromises.rm
    fsPromises.writeFile = (async () => {
      throw new Error("injected write failure")
    }) as typeof fsPromises.writeFile
    fsPromises.rm = (async () => {
      throw new Error("injected cleanup failure")
    }) as typeof fsPromises.rm
    syncBuiltinESMExports()
    try {
      await assert.rejects(materialiseTree({ dir, tree: { "a.md": "x" } }), (error: unknown) => {
        assert.ok(error instanceof TreeStoreError)
        assert.equal(error.code, "WRITE_FAILED", "the primary failure is not replaced")
        assert.match(String((error.cause as TreeStoreError).message), /could not write a\.md/)
        assert.match(String(error.cleanupError), /injected cleanup failure/)
        return true
      })
    } finally {
      fsPromises.writeFile = originalWrite
      fsPromises.rm = originalRm
      syncBuiltinESMExports()
    }
  })
})

describe("candidates are independent (V9, V10)", () => {
  it("lets two candidates disagree about whether a path is a file or a directory", async () => {
    const parent = await scratch()
    const flat = await materialiseTree({ dir: path.join(parent, "c0"), tree: { a: "file" } })
    const nested = await materialiseTree({ dir: path.join(parent, "c1"), tree: { "a/b.md": "nested" } })

    assert.deepEqual(await readTree({ dir: flat.dir }), { a: "file" })
    assert.deepEqual(await readTree({ dir: nested.dir }), { "a/b.md": "nested" })
  })

  it("deletes by materialising the patched tree, never by editing the old directory", async () => {
    const parent = await scratch()
    const base = { "keep.md": "a", "drop.md": "b" }
    const before = await materialiseTree({ dir: path.join(parent, "e0"), tree: base })

    const next = applyTreePatch(base, treePatchSchema.parse({ "drop.md": null }))
    const after = await materialiseTree({ dir: path.join(parent, "e1"), tree: next })

    assert.deepEqual(await readTree({ dir: after.dir }), { "keep.md": "a" })
    assert.deepEqual(await readTree({ dir: before.dir }), base, "the previous candidate is untouched")
    assert.deepEqual(diffTrees(base, next), { added: [], modified: [], removed: ["drop.md"] })
  })
})
