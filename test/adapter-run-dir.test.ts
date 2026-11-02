import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises"
import { afterEach, describe, it } from "node:test"
import os from "node:os"
import path from "node:path"

import type { HarnessTree } from "../src/domain/schemas.ts"
import { AdapterError } from "../src/adapter/errors.ts"
import {
  HARNESS_DIR_NAME,
  RUN_ID_PATTERN,
  newRunId,
  prepareRunDir,
} from "../src/adapter/run-dir.ts"
import { readTree } from "../src/harness/tree-store.ts"

const scratchRoots: string[] = []

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness2-rundir-"))
  scratchRoots.push(root)
  return root
}

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function codeOf(operation: Promise<unknown>): Promise<string> {
  try {
    await operation
  } catch (error) {
    assert.ok(error instanceof AdapterError, `expected AdapterError, got ${String(error)}`)
    return error.code
  }
  assert.fail("expected a rejection")
}

const TREE: HarnessTree = {
  "EXPERIENCE.md": "# lessons\n",
  ".clinerules/rules.md": "rules\n",
}

describe("new run ids", () => {
  it("is a sortable timestamp plus a random suffix", () => {
    assert.equal(
      newRunId(new Date("2026-11-02T08:05:12.345Z"), () => "a1b2c3"),
      "20261102T080512Z-a1b2c3",
    )
  })

  it("always produces a safe path component, and never the same one twice", () => {
    const ids = new Set<string>()
    for (let index = 0; index < 50; index += 1) {
      const id = newRunId()
      assert.match(id, RUN_ID_PATTERN)
      assert.notEqual(id, ".")
      assert.notEqual(id, "..")
      ids.add(id)
    }
    assert.equal(ids.size, 50)
  })

  it("refuses an injected suffix that would not be a safe path component", async () => {
    // A random source that returned a separator would otherwise escape the run root.
    assert.equal(
      await codeOf(Promise.resolve().then(() => newRunId(new Date(), () => "a/b"))),
      "RUN_ROOT_UNUSABLE",
    )
  })
})

describe("prepareRunDir", () => {
  it("creates the run root when it is missing and materialises the tree beneath it", async () => {
    const root = await scratch()
    const rootDir = path.join(root, "nested", "runs")
    const prepared = await prepareRunDir({ rootDir, runId: "run-1", tree: TREE })

    assert.equal(prepared.runDir, path.join(rootDir, "run-1"))
    assert.equal(prepared.harnessDir, path.join(rootDir, "run-1", HARNESS_DIR_NAME))
    assert.deepEqual(prepared.files, Object.keys(TREE).sort())
    assert.deepEqual(await readTree({ dir: prepared.harnessDir }), TREE)
  })

  it("keeps two runs in the same root apart", async () => {
    const root = await scratch()
    const first = await prepareRunDir({ rootDir: root, runId: "run-a", tree: TREE })
    const second = await prepareRunDir({ rootDir: root, runId: "run-b", tree: TREE })
    assert.notEqual(first.harnessDir, second.harnessDir)
    assert.deepEqual(await readTree({ dir: first.harnessDir }), TREE)
    assert.deepEqual(await readTree({ dir: second.harnessDir }), TREE)
  })

  it("rejects run ids that are not a single safe path component", async () => {
    const root = await scratch()
    for (const runId of ["../escape", "a/b", "", ".", "..", "x".repeat(65), "a b"]) {
      assert.equal(
        await codeOf(prepareRunDir({ rootDir: root, runId, tree: TREE })),
        "RUN_ROOT_UNUSABLE",
        `run id ${JSON.stringify(runId)} should be rejected`,
      )
    }
  })

  it("refuses a symlinked run root instead of writing through the link", async () => {
    const root = await scratch()
    const real = path.join(root, "real")
    await mkdir(real)
    const link = path.join(root, "link")
    await symlink(real, link)
    assert.equal(
      await codeOf(prepareRunDir({ rootDir: link, runId: "run-1", tree: TREE })),
      "RUN_ROOT_UNUSABLE",
    )
  })

  it("refuses a run root that is a file", async () => {
    const root = await scratch()
    const file = path.join(root, "not-a-dir")
    await writeFile(file, "x", "utf8")
    assert.equal(
      await codeOf(prepareRunDir({ rootDir: file, runId: "run-1", tree: TREE })),
      "RUN_ROOT_UNUSABLE",
    )
  })

  it("never reuses an existing run directory, and does not touch its contents", async () => {
    const root = await scratch()
    const runDir = path.join(root, "run-1")
    await mkdir(runDir)
    const marker = path.join(runDir, "keep-me.txt")
    await writeFile(marker, "stale run\n", "utf8")

    assert.equal(
      await codeOf(prepareRunDir({ rootDir: root, runId: "run-1", tree: TREE })),
      "RUN_DIR_EXISTS",
    )
    assert.equal((await stat(marker)).isFile(), true)
  })

  it("rolls the run directory back when the tree cannot be materialised", async () => {
    const root = await scratch()
    const runDir = path.join(root, "run-1")
    const escaped = { "../escape.md": "x" } as unknown as HarnessTree

    assert.equal(
      await codeOf(prepareRunDir({ rootDir: root, runId: "run-1", tree: escaped })),
      "HARNESS_MATERIALISE_FAILED",
    )
    // Nothing of ours is left behind: the next attempt with the same id must be free to proceed.
    await assert.rejects(stat(runDir), { code: "ENOENT" })
    const retried = await prepareRunDir({ rootDir: root, runId: "run-1", tree: TREE })
    assert.deepEqual(await readTree({ dir: retried.harnessDir }), TREE)
  })
})
