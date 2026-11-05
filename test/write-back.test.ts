import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { isWriteBackPath, writeBackHarness } from "../src/run/write-back.ts"

/**
 * Writing an improved harness back into a repository.
 *
 * The gate is "the improvement lands where the next session will read it, and nowhere else". That means four
 * things at once: a changed file is written, an unchanged one is left alone, a symlinked rules file is written
 * *through* the link into the config repository, and a link that points outside the workspace is refused.
 */

async function repo(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "harness2-wb-"))
}

describe("writeBackHarness", () => {
  it("updates a changed file and creates the lesson library, leaving the rest alone", async () => {
    const dir = await repo()
    await mkdir(path.join(dir, ".clinerules"), { recursive: true })
    await writeFile(path.join(dir, ".clinerules/core.md"), "old rule\n", "utf8")
    await writeFile(path.join(dir, "systemprompt.md"), "same\n", "utf8")

    const result = await writeBackHarness({
      repo: dir,
      captured: {
        ".clinerules/core.md": "old rule\n",
        "systemprompt.md": "same\n",
        "tools/read.md": "a tool\n",
      },
      final: {
        ".clinerules/core.md": "new rule\n",
        "systemprompt.md": "same\n",
        "tools/read.md": "a tool\n",
        "LongTermMEMORY.md": "# Long-term memory\n",
      },
    })

    assert.deepEqual(
      result.written.map((file) => [file.path, file.kind]),
      [
        [".clinerules/core.md", "updated"],
        ["LongTermMEMORY.md", "created"],
      ],
    )
    assert.deepEqual(result.unchanged, ["systemprompt.md"])
    assert.deepEqual(
      result.skipped.map((skip) => skip.path),
      ["tools/read.md"],
      "a tool description is not harness text this module writes",
    )
    assert.equal(await readFile(path.join(dir, ".clinerules/core.md"), "utf8"), "new rule\n")
    assert.equal(await readFile(path.join(dir, "LongTermMEMORY.md"), "utf8"), "# Long-term memory\n")
  })

  it("never writes the generated project-rules.md that sync-rules.mjs owns", async () => {
    const dir = await repo()
    await mkdir(path.join(dir, ".clinerules"), { recursive: true })
    await writeFile(path.join(dir, ".clinerules/project-rules.md"), "AUTO-GENERATED: from folder\n", "utf8")
    await writeFile(path.join(dir, ".clinerules/core.md"), "old rule\n", "utf8")

    const result = await writeBackHarness({
      repo: dir,
      captured: {
        ".clinerules/project-rules.md": "AUTO-GENERATED: from folder\n",
        ".clinerules/core.md": "old rule\n",
      },
      final: {
        // A run "improving" the generated copy must not reach the disk: the next sync would drop the edit, and
        // a rule that exists only here exists in no folder file at all.
        ".clinerules/project-rules.md": "AUTO-GENERATED: from folder\nplus a rule no folder file has\n",
        ".clinerules/core.md": "new rule\n",
      },
    })

    assert.deepEqual(
      result.written.map((file) => file.path),
      [".clinerules/core.md"],
      "every other .clinerules file is still written back",
    )
    const generated = result.skipped.find((skip) => skip.path === ".clinerules/project-rules.md")
    assert.ok(generated !== undefined, "the generated copy is reported as skipped, not silently dropped")
    assert.match(generated.reason, /sync-rules\.mjs/)
    assert.equal(
      await readFile(path.join(dir, ".clinerules/project-rules.md"), "utf8"),
      "AUTO-GENERATED: from folder\n",
      "the file on disk is untouched",
    )
    assert.equal(isWriteBackPath(".clinerules/project-rules.md"), false)
    assert.equal(isWriteBackPath(".clinerules/core.md"), true)
  })

  it("writes through a symlink into the config repository", async () => {
    const dir = await repo()
    const ssot = await repo()
    await mkdir(path.join(ssot, "rules"), { recursive: true })
    await writeFile(path.join(ssot, "rules/core.md"), "config rule\n", "utf8")
    await mkdir(path.join(dir, ".clinerules"), { recursive: true })
    await symlink(path.join(ssot, "rules/core.md"), path.join(dir, ".clinerules/core.md"))

    const result = await writeBackHarness({
      repo: dir,
      ssotRoot: ssot,
      captured: { ".clinerules/core.md": "config rule\n" },
      final: { ".clinerules/core.md": "improved config rule\n" },
    })

    assert.equal(result.written.length, 1)
    assert.equal(result.written[0]?.throughSymlink, true)
    assert.equal(
      await readFile(path.join(ssot, "rules/core.md"), "utf8"),
      "improved config rule\n",
      "the linked config file is the one that changed, which is the point of the arrangement",
    )
  })

  it("refuses a symlink that resolves outside the workspace and the config root", async () => {
    const dir = await repo()
    const outside = await repo()
    await writeFile(path.join(outside, "secret.md"), "untouched\n", "utf8")
    await mkdir(path.join(dir, ".clinerules"), { recursive: true })
    await symlink(path.join(outside, "secret.md"), path.join(dir, ".clinerules/core.md"))

    const result = await writeBackHarness({
      repo: dir,
      captured: { ".clinerules/core.md": "untouched\n" },
      final: { ".clinerules/core.md": "overwritten\n" },
    })

    assert.equal(result.written.length, 0)
    assert.match(result.skipped[0]?.reason ?? "", /resolves outside/)
    assert.equal(await readFile(path.join(outside, "secret.md"), "utf8"), "untouched\n")
  })

  it("never empties a file and never invents one the capture did not have", async () => {
    const dir = await repo()
    await mkdir(path.join(dir, ".clinerules"), { recursive: true })
    await writeFile(path.join(dir, ".clinerules/core.md"), "a rule\n", "utf8")

    const result = await writeBackHarness({
      repo: dir,
      captured: { ".clinerules/core.md": "a rule\n" },
      final: { ".clinerules/core.md": "", ".clinerules/extra.md": "brand new\n" },
    })

    assert.equal(result.written.length, 0)
    assert.equal(await readFile(path.join(dir, ".clinerules/core.md"), "utf8"), "a rule\n")
    assert.match(
      result.skipped.map((skip) => skip.reason).join("\n"),
      /never empties a file/,
    )
    assert.match(result.skipped.map((skip) => skip.reason).join("\n"), /never contained this file/)
  })

  it("reports no change when the harness already matches", async () => {
    const dir = await repo()
    const tree = { ".clinerules/core.md": "same\n" }
    const result = await writeBackHarness({ repo: dir, captured: tree, final: tree })
    assert.equal(result.changed, false)
    assert.deepEqual(result.unchanged, [".clinerules/core.md"])
  })

  it("refuses a write through a *directory* symlink that leaves the workspace", async () => {
    const dir = await repo()
    const outside = await repo()
    await symlink(outside, path.join(dir, ".clinerules"))

    const result = await writeBackHarness({
      repo: dir,
      captured: { ".clinerules/core.md": "old\n" },
      final: { ".clinerules/core.md": "new\n" },
    })

    assert.equal(result.written.length, 0, "the write would have landed in a directory outside the repo")
    assert.match(result.skipped[0]?.reason ?? "", /resolves outside/)
    await assert.rejects(readFile(path.join(outside, "core.md"), "utf8"), /ENOENT/)
  })

  it("refuses a dangling leaf symlink instead of creating its destination", async () => {
    const dir = await repo()
    const outside = await repo()
    await mkdir(path.join(dir, ".clinerules"), { recursive: true })
    await symlink(path.join(outside, "nowhere.md"), path.join(dir, ".clinerules/core.md"))

    const result = await writeBackHarness({
      repo: dir,
      captured: { ".clinerules/core.md": "old\n" },
      final: { ".clinerules/core.md": "new\n" },
    })

    assert.equal(result.written.length, 0)
    assert.match(result.skipped[0]?.reason ?? "", /resolves outside/)
    await assert.rejects(readFile(path.join(outside, "nowhere.md"), "utf8"), /ENOENT/)
  })

  it("knows which paths are harness text", () => {
    assert.equal(isWriteBackPath(".clinerules/rules.md"), true)
    assert.equal(isWriteBackPath("EXPERIENCE.md"), true)
    assert.equal(isWriteBackPath("LongTermMEMORY.md"), true)
    assert.equal(isWriteBackPath("systemprompt.md"), true)
    assert.equal(isWriteBackPath("tools/run_commands.md"), false)
    assert.equal(isWriteBackPath(".cline/skills/x/SKILL.md"), false)
    assert.equal(isWriteBackPath("src/index.ts"), false)
  })
})
