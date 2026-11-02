import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fsPromises from "node:fs/promises"
import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { afterEach, describe, it } from "node:test"
import os from "node:os"
import path from "node:path"

import {
  MAX_SYMLINK_HOPS,
  captureBaseline,
  type BaselineCapture,
} from "../src/baseline/capture.ts"
import {
  DEFAULT_COMPONENTS,
  validateComponents,
  type ComponentSpec,
} from "../src/baseline/components.ts"
import { BaselineError } from "../src/baseline/errors.ts"
import { ssotRulesHashOf } from "../src/baseline/fingerprint.ts"
import { sha256Hex } from "../src/domain/canonical.ts"
import { materialiseTree, readTree } from "../src/harness/tree-store.ts"

const scratchRoots: string[] = []

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness2-baseline-"))
  scratchRoots.push(root)
  return root
}

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

function runGit(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
      },
      (error) => (error === null ? resolve() : reject(error)),
    )
  })
}

/** A repository with one commit and no content of its own. */
async function initRepo(): Promise<string> {
  const dir = await scratch()
  await runGit(dir, ["init", "-q"])
  await runGit(dir, ["commit", "-q", "--allow-empty", "-m", "init"])
  return dir
}

async function put(root: string, relative: string, body: string): Promise<string> {
  const absolute = path.join(root, relative)
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, body)
  return absolute
}

/** An SSOT tree shaped like `cline-config`. */
async function initSsot(): Promise<string> {
  const ssot = await scratch()
  await put(ssot, ".clinerules/folder-demo.md", "canonical rules\n")
  await put(ssot, "notes.md", "not a rules file\n")
  return ssot
}

async function codeOf(operation: Promise<unknown>): Promise<string> {
  try {
    await operation
  } catch (error) {
    assert.ok(error instanceof BaselineError, `expected BaselineError, got ${String(error)}`)
    return error.code
  }
  assert.fail("expected a rejection")
}

const CLINERULES_ONLY: readonly ComponentSpec[] = [
  { id: "clinerules", path: ".clinerules", kind: "directory" },
  { id: "experience", path: "EXPERIENCE.md", kind: "file" },
]

async function capture(repoDir: string, ssotRoot: string, components = CLINERULES_ONLY): Promise<BaselineCapture> {
  return captureBaseline({ repoDir, ssotRoot, components })
}

describe("component manifest (pre-flight)", () => {
  it("accepts the default manifest and defaults every component to optional", () => {
    const validated = validateComponents(DEFAULT_COMPONENTS)
    assert.deepEqual(
      validated.map((component) => component.id),
      ["clinerules", "experience", "skills"],
    )
    assert.ok(validated.every((component) => component.required === false))
  })

  it("refuses duplicate ids, duplicate paths and overlapping paths", () => {
    assert.throws(
      () =>
        validateComponents([
          { id: "a", path: "a", kind: "directory" },
          { id: "a", path: "b", kind: "directory" },
        ]),
      /declared twice/,
    )
    assert.throws(
      () =>
        validateComponents([
          { id: "a", path: "same", kind: "directory" },
          { id: "b", path: "same", kind: "directory" },
        ]),
      /declared twice/,
    )
    assert.throws(
      () =>
        validateComponents([
          { id: "a", path: "top", kind: "directory" },
          { id: "b", path: "top/nested", kind: "directory" },
        ]),
      /overlap/,
    )
  })

  it("refuses a component that points into .git or node_modules", () => {
    for (const forbidden of [".git", "node_modules", "NODE_MODULES"]) {
      assert.throws(
        () => validateComponents([{ id: "x", path: forbidden, kind: "directory" }]),
        /never-captured directory/,
      )
    }
  })

  it("refuses a canonical destination outside its component and duplicate destinations", () => {
    assert.throws(
      () =>
        validateComponents([
          {
            id: "rules",
            path: ".clinerules",
            kind: "directory",
            canonicalSources: [
              { destination: "EXPERIENCE.md", source: { root: "ssot", path: ".clinerules/x.md" } },
            ],
          },
        ]),
      /not inside/,
    )
    assert.throws(
      () =>
        validateComponents([
          {
            id: "rules",
            path: ".clinerules",
            kind: "directory",
            canonicalSources: [
              { destination: ".clinerules/x.md", source: { root: "ssot", path: ".clinerules/a.md" } },
              { destination: ".clinerules/x.md", source: { root: "ssot", path: ".clinerules/b.md" } },
            ],
          },
        ]),
      /declared more than once/,
    )
  })
})

describe("capturing a repository it does not own", () => {
  it("captures declared components and records their provenance", async () => {
    const repo = await initRepo()
    await put(repo, ".clinerules/project-rules.md", "rules\n")
    await put(repo, "EXPERIENCE.md", "- lesson\n")
    const ssot = await initSsot()

    const result = await capture(repo, ssot)

    assert.deepEqual(result.tree, {
      ".clinerules/project-rules.md": "rules\n",
      "EXPERIENCE.md": "- lesson\n",
    })
    assert.deepEqual(
      result.files.map((file) => [file.relPath, file.origin.kind]),
      [
        [".clinerules/project-rules.md", "regular"],
        ["EXPERIENCE.md", "regular"],
      ],
    )
    // The bytes on disk are what gets hashed, so the record can be checked without re-reading.
    assert.equal(result.files[0]?.sha256, sha256Hex("rules\n"))
    assert.deepEqual(
      result.components.map((component) => [component.id, component.present, component.files]),
      [
        ["clinerules", true, 1],
        ["experience", true, 1],
      ],
    )
    assert.deepEqual(result.excluded, [])
    assert.equal(result.version, 1)
  })

  it("reports an absent optional component instead of failing", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()

    const result = await captureBaseline({ repoDir: repo, ssotRoot: ssot })

    const skills = result.components.find((component) => component.id === "skills")
    assert.deepEqual(skills, {
      id: "skills",
      path: ".cline/skills",
      kind: "directory",
      required: false,
      present: false,
      files: 0,
    })
    assert.deepEqual(result.tree, {})
  })

  it("captures a git-excluded file that git itself does not track", async () => {
    const repo = await initRepo()
    await put(repo, ".clinerules/project-rules.md", "rules\n")
    await put(repo, ".git/info/exclude", ".clinerules/\n")
    const ssot = await initSsot()

    const result = await capture(repo, ssot)

    assert.deepEqual(result.tree, { ".clinerules/project-rules.md": "rules\n" })
    // Tracked worktree is clean: the file exists only on disk, which is exactly why capture walks it.
    assert.deepEqual(result.git.dirty, [])
    assert.equal(result.fingerprint.isDirty, false)
  })

  it("keeps a BOM and CRLF intact through capture", async () => {
    const repo = await initRepo()
    const body = "\uFEFFline one\r\nline two\r\n"
    await put(repo, ".clinerules/bom.md", body)
    const ssot = await initSsot()

    const result = await capture(repo, ssot)

    assert.equal(result.tree[".clinerules/bom.md"], body)
  })

  it("produces a tree that materialises as regular files and reads back unchanged", async () => {
    const repo = await initRepo()
    await put(repo, ".clinerules/project-rules.md", "rules\n")
    const ssot = await initSsot()
    const linkPath = path.join(repo, ".clinerules/linked.md")
    await symlink(path.join(ssot, ".clinerules/folder-demo.md"), linkPath)

    const result = await capture(repo, ssot)
    const parent = await scratch()
    const { dir } = await materialiseTree({ dir: path.join(parent, "run"), tree: result.tree })

    assert.deepEqual(await readTree({ dir }), result.tree)
    assert.equal((await fsPromises.lstat(path.join(dir, ".clinerules/linked.md"))).isFile(), true)
    assert.equal(
      (await fsPromises.lstat(path.join(dir, ".clinerules/linked.md"))).isSymbolicLink(),
      false,
      "the link was flattened into a body, which is what the tree contract promises",
    )
  })
})

describe("symlink resolution", () => {
  it("reads through a link to the canonical SSOT rule file and records the association", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await symlink(path.join(ssot, ".clinerules/folder-demo.md"), path.join(repo, ".clinerules/x.md"))

    const result = await capture(repo, ssot)

    assert.equal(result.tree[".clinerules/x.md"], "canonical rules\n")
    const record = result.files.find((file) => file.relPath === ".clinerules/x.md")
    assert.deepEqual(record?.origin, {
      kind: "symlink",
      hops: 1,
      resolved: { root: "ssot", rootRelPath: ".clinerules/folder-demo.md" },
    })
    assert.equal(
      result.fingerprint.ssotRulesHash,
      ssotRulesHashOf([
        {
          destination: ".clinerules/x.md",
          sourceRoot: "ssot",
          sourcePath: ".clinerules/folder-demo.md",
          sourceSha256: sha256Hex("canonical rules\n"),
        },
      ]),
      "the SSOT provenance is part of the fingerprint, not an unhashed annotation",
    )
  })

  it("refuses a link that leaves both authorised roots", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    const outside = await scratch()
    await put(outside, "secret.md", "not yours\n")
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await symlink(path.join(outside, "secret.md"), path.join(repo, ".clinerules/escape.md"))

    assert.equal(await codeOf(capture(repo, ssot)), "SYMLINK_OUTSIDE_ROOTS")
  })

  it("does not confuse an SSOT sibling directory with the SSOT itself", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    const sibling = `${ssot}-evil`
    scratchRoots.push(sibling)
    await put(sibling, ".clinerules/folder-demo.md", "evil twin\n")
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await symlink(
      path.join(sibling, ".clinerules/folder-demo.md"),
      path.join(repo, ".clinerules/x.md"),
    )

    assert.equal(await codeOf(capture(repo, ssot)), "SYMLINK_OUTSIDE_ROOTS")
  })

  it("refuses a dangling link and a link to a directory", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await symlink(path.join(repo, ".clinerules/missing.md"), path.join(repo, ".clinerules/dangling.md"))
    assert.equal(await codeOf(capture(repo, ssot)), "SYMLINK_UNRESOLVED")

    await rm(path.join(repo, ".clinerules/dangling.md"))
    await mkdir(path.join(repo, ".clinerules/dir"))
    await put(repo, ".clinerules/dir/inside.md", "inside\n")
    await symlink(path.join(repo, ".clinerules/dir"), path.join(repo, ".clinerules/to-dir"))
    assert.equal(await codeOf(capture(repo, ssot)), "UNSUPPORTED_ENTRY")
  })

  it("detects a cycle instead of reporting ELOOP", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await symlink(path.join(repo, ".clinerules/b.md"), path.join(repo, ".clinerules/a.md"))
    await symlink(path.join(repo, ".clinerules/a.md"), path.join(repo, ".clinerules/b.md"))

    assert.equal(await codeOf(capture(repo, ssot)), "SYMLINK_CYCLE")
  })

  it("counts hops: exactly MAX is fine, one more is refused", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await put(repo, ".clinerules/f0.md", "leaf\n")
    for (let index = 1; index <= MAX_SYMLINK_HOPS; index += 1) {
      await symlink(`f${index - 1}.md`, path.join(repo, `.clinerules/f${index}.md`))
    }

    const accepted = await capture(repo, ssot)
    assert.equal(accepted.tree[`.clinerules/f${MAX_SYMLINK_HOPS}.md`], "leaf\n")
    assert.equal(
      accepted.files.find((file) => file.relPath.endsWith(`f${MAX_SYMLINK_HOPS}.md`))?.origin.kind,
      "symlink",
    )

    await symlink(`f${MAX_SYMLINK_HOPS}.md`, path.join(repo, `.clinerules/f${MAX_SYMLINK_HOPS + 1}.md`))
    assert.equal(await codeOf(capture(repo, ssot)), "SYMLINK_TOO_DEEP")
  })

  it("refuses a link into node_modules or .git", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await put(repo, "node_modules/pkg/index.md", "dependency\n")
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await symlink("../node_modules/pkg/index.md", path.join(repo, ".clinerules/dep.md"))

    assert.equal(await codeOf(capture(repo, ssot)), "LINK_INTO_EXCLUDED")
  })

  it("authorises a symlinked ancestor, not just the leaf", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    const outside = await scratch()
    await put(outside, "skills/pdf/SKILL.md", "# skill\n")
    await symlink(path.join(outside, "skills"), path.join(repo, ".cline"))

    const components: readonly ComponentSpec[] = [
      { id: "skills", path: ".cline/skills", kind: "directory" },
    ]
    assert.equal(await codeOf(capture(repo, ssot, components)), "SYMLINK_OUTSIDE_ROOTS")
  })
})

describe("declared canonical sources", () => {
  const declared: readonly ComponentSpec[] = [
    {
      id: "clinerules",
      path: ".clinerules",
      kind: "directory",
      canonicalSources: [
        {
          destination: ".clinerules/x.md",
          source: { root: "ssot", path: ".clinerules/folder-demo.md" },
        },
      ],
    },
  ]

  it("records an identical canonical link for a symlinked rule file", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await symlink(path.join(ssot, ".clinerules/folder-demo.md"), path.join(repo, ".clinerules/x.md"))

    const result = await capture(repo, ssot, declared)
    const record = result.files.find((file) => file.relPath === ".clinerules/x.md")

    assert.deepEqual(record?.canonical, {
      root: "ssot",
      rootRelPath: ".clinerules/folder-demo.md",
      sha256: sha256Hex("canonical rules\n"),
      identical: true,
    })
  })

  it("records a drifted generated copy without failing", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await writeFile(path.join(repo, ".clinerules/x.md"), "generated, header added\n")

    const result = await capture(repo, ssot, declared)
    const record = result.files.find((file) => file.relPath === ".clinerules/x.md")

    assert.equal(result.tree[".clinerules/x.md"], "generated, header added\n")
    assert.equal(record?.canonical?.identical, false, "the drift is visible, not silently normalised")
    assert.equal(record?.canonical?.sha256, sha256Hex("canonical rules\n"))
  })

  it("refuses a declared source that does not exist", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await writeFile(path.join(repo, ".clinerules/x.md"), "x\n")

    const missing: readonly ComponentSpec[] = [
      {
        id: "clinerules",
        path: ".clinerules",
        kind: "directory",
        canonicalSources: [
          { destination: ".clinerules/x.md", source: { root: "ssot", path: ".clinerules/nope.md" } },
        ],
      },
    ]
    assert.equal(await codeOf(capture(repo, ssot, missing)), "CANONICAL_SOURCE_MISSING")
  })

  it("refuses a link that resolves to a different SSOT file than declared", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await put(ssot, ".clinerules/other.md", "another file\n")
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await symlink(path.join(ssot, ".clinerules/other.md"), path.join(repo, ".clinerules/x.md"))

    assert.equal(await codeOf(capture(repo, ssot, declared)), "CANONICAL_SOURCE_MISMATCH")
  })
})

describe("hardening: what capture refuses or reports", () => {
  it("refuses an executable file rather than losing its mode", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    const script = await put(repo, ".clinerules/run.sh", "#!/bin/sh\necho hi\n")
    await chmod(script, 0o755)

    assert.equal(await codeOf(capture(repo, ssot)), "EXECUTABLE_FORBIDDEN")
  })

  it("refuses a FIFO without blocking on it", async () => {
    if (process.platform === "win32") return
    const repo = await initRepo()
    const ssot = await initSsot()
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await new Promise<void>((resolve, reject) => {
      execFile("mkfifo", [path.join(repo, ".clinerules/pipe")], (error) =>
        error === null ? resolve() : reject(error),
      )
    })

    assert.equal(await codeOf(capture(repo, ssot)), "UNSUPPORTED_ENTRY")
  })

  it("reports every skipped entry instead of dropping it", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await put(repo, ".clinerules/rules.md", "rules\n")
    await put(repo, ".clinerules/.DS_Store", "junk\n")
    await put(repo, ".clinerules/.tmp/scratch.md", "scratch\n")
    await mkdir(path.join(repo, ".clinerules/empty"), { recursive: true })

    const result = await capture(repo, ssot)

    assert.deepEqual(result.tree, { ".clinerules/rules.md": "rules\n" })
    assert.deepEqual(result.excluded, [
      { relPath: ".clinerules/.DS_Store", reason: "ignored-name" },
      { relPath: ".clinerules/.tmp", reason: "pruned-directory" },
      { relPath: ".clinerules/empty", reason: "empty-directory" },
    ])
  })

  it("never lists a path under node_modules or .git", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await put(repo, ".clinerules/rules.md", "rules\n")
    // Booby traps: walking either subtree would cycle, hang or blow the size cap.
    await mkdir(path.join(repo, ".clinerules/node_modules/pkg"), { recursive: true })
    await writeFile(
      path.join(repo, ".clinerules/node_modules/pkg/big.md"),
      "x".repeat(2 * 1024 * 1024),
    )
    await symlink("loop", path.join(repo, ".clinerules/node_modules/loop"))
    await mkdir(path.join(repo, ".clinerules/.git/objects"), { recursive: true })
    await writeFile(path.join(repo, ".clinerules/.git/objects/junk"), "junk\n")

    const originalReaddir = fsPromises.readdir
    const listed: string[] = []
    fsPromises.readdir = (async (...args: Parameters<typeof fsPromises.readdir>) => {
      listed.push(String(args[0]))
      return originalReaddir(...args)
    }) as typeof fsPromises.readdir
    syncBuiltinESMExports()

    let result: BaselineCapture
    try {
      result = await capture(repo, ssot)
    } finally {
      fsPromises.readdir = originalReaddir
      syncBuiltinESMExports()
    }

    assert.deepEqual(result.tree, { ".clinerules/rules.md": "rules\n" })
    assert.deepEqual(
      listed.filter((entry) => entry.includes("node_modules") || entry.includes(".git")),
      [],
      "not one listing call may reach a pruned subtree",
    )
    assert.deepEqual(result.excluded, [
      { relPath: ".clinerules/.git", reason: "pruned-directory" },
      { relPath: ".clinerules/node_modules", reason: "pruned-directory" },
    ])
  })

  it("refuses a file past the per-file cap", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await writeFile(path.join(repo, ".clinerules/big.md"), "x".repeat(1_048_577))

    assert.equal(await codeOf(capture(repo, ssot)), "TOO_LARGE")
  })

  it("refuses more files than the tree may hold", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    for (let start = 0; start < 1025; start += 100) {
      const size = Math.min(100, 1025 - start)
      await Promise.all(
        Array.from({ length: size }, (_, offset) =>
          writeFile(path.join(repo, `.clinerules/f${start + offset}.md`), "x"),
        ),
      )
    }

    assert.equal(await codeOf(capture(repo, ssot)), "TOO_MANY_FILES")
  })
})

describe("git metadata", () => {
  it("records the commit, the tracked dirt and the lockfile digest", async () => {
    const repo = await initRepo()
    await put(repo, "tracked.md", "v1\n")
    await runGit(repo, ["add", "tracked.md"])
    await runGit(repo, ["commit", "-q", "-m", "add"])
    await writeFile(path.join(repo, "tracked.md"), "v2\n")
    await put(repo, ".clinerules/rules.md", "rules\n")
    await writeFile(path.join(repo, "pnpm-lock.yaml"), "lockfile\n")
    const ssot = await initSsot()

    const result = await capture(repo, ssot)

    assert.match(result.git.baseSha, /^[0-9a-f]{40}$/)
    assert.deepEqual(result.git.dirty, ["tracked.md"])
    assert.equal(result.fingerprint.isDirty, true)
    assert.equal(result.git.dependencyLockHash, sha256Hex("lockfile\n"))
    assert.equal(result.git.toplevelMatches, true)
    assert.equal(result.fingerprint.baseSha, result.git.baseSha)
  })

  it("distinguishes an absent lockfile from an empty one", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()

    const absent = await capture(repo, ssot)
    assert.equal(absent.git.dependencyLockHash, null)

    await writeFile(path.join(repo, "pnpm-lock.yaml"), "")
    const empty = await capture(repo, ssot)
    assert.equal(empty.git.dependencyLockHash, sha256Hex(""))
    assert.notEqual(absent.fingerprint.dependencyLockHash, empty.fingerprint.dependencyLockHash)
  })

  it("refuses a directory that is not a repository", async () => {
    const plain = await scratch()
    const ssot = await initSsot()
    assert.equal(await codeOf(capture(plain, ssot)), "NOT_A_REPO")
  })

  it("refuses a repository with no commit", async () => {
    const repo = await scratch()
    await runGit(repo, ["init", "-q"])
    const ssot = await initSsot()
    assert.equal(await codeOf(capture(repo, ssot)), "UNBORN_HEAD")
  })

  it("refuses a subdirectory of a repository", async () => {
    const repo = await initRepo()
    await mkdir(path.join(repo, "packages/app"), { recursive: true })
    const ssot = await initSsot()
    assert.equal(await codeOf(capture(path.join(repo, "packages/app"), ssot)), "NOT_A_REPO_ROOT")
  })

  it("ignores a poisoned GIT_DIR in the caller's environment", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await put(repo, ".clinerules/rules.md", "rules\n")

    const original = process.env.GIT_DIR
    process.env.GIT_DIR = "/nonexistent-repository"
    let result: BaselineCapture
    try {
      result = await capture(repo, ssot)
    } finally {
      if (original === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = original
    }

    assert.deepEqual(result.tree, { ".clinerules/rules.md": "rules\n" })
  })
})

describe("baseline fingerprint", () => {
  it("comes out identical for two captures of one unchanged repository", async () => {
    const repo = await initRepo()
    await put(repo, ".clinerules/rules.md", "rules\n")
    const ssot = await initSsot()

    const first = await capture(repo, ssot)
    const second = await capture(repo, ssot)

    assert.equal(first.baselineSha, second.baselineSha)
    assert.deepEqual(first.fingerprint, second.fingerprint)
  })

  it("changes treeSha and baselineSha when a single byte changes", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await put(repo, ".clinerules/rules.md", "rules\n")
    const before = await capture(repo, ssot)

    await writeFile(path.join(repo, ".clinerules/rules.md"), "rulez\n")
    const after = await capture(repo, ssot)

    assert.notEqual(before.fingerprint.treeSha, after.fingerprint.treeSha)
    assert.notEqual(before.baselineSha, after.baselineSha)
    assert.equal(before.fingerprint.baseSha, after.fingerprint.baseSha, "same commit throughout")
  })

  it("hashes nothing absolute, so a relocated copy agrees", async () => {
    const ssot = await initSsot()
    const first = await initRepo()
    const second = await initRepo()
    for (const repo of [first, second]) {
      await put(repo, ".clinerules/rules.md", "same\n")
      await symlink(path.join(ssot, ".clinerules/folder-demo.md"), path.join(repo, ".clinerules/x.md"))
    }

    const a = await capture(first, ssot)
    const b = await capture(second, ssot)

    assert.equal(a.fingerprint.treeSha, b.fingerprint.treeSha)
    assert.equal(a.fingerprint.manifestSha, b.fingerprint.manifestSha)
    assert.equal(a.fingerprint.ssotRulesHash, b.fingerprint.ssotRulesHash)
  })

  it("uses a versioned envelope and ignores association order", async () => {
    const first = {
      destination: ".clinerules/a.md",
      sourceRoot: "ssot" as const,
      sourcePath: ".clinerules/a.md",
      sourceSha256: sha256Hex("a\n"),
    }
    const second = {
      destination: ".clinerules/b.md",
      sourceRoot: "ssot" as const,
      sourcePath: ".clinerules/b.md",
      sourceSha256: sha256Hex("b\n"),
    }

    const none = ssotRulesHashOf([])
    const one = ssotRulesHashOf([first])

    assert.notEqual(none, one)
    assert.equal(none, ssotRulesHashOf([]), "empty must be stable")
    assert.equal(ssotRulesHashOf([first, second]), ssotRulesHashOf([second, first]))
  })

  it("changes manifestSha and treeSha when a component appears", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await put(repo, ".clinerules/rules.md", "rules\n")
    const withoutSkills = await captureBaseline({ repoDir: repo, ssotRoot: ssot })

    await put(repo, ".cline/skills/pdf/SKILL.md", "# skill\n")
    const withSkills = await captureBaseline({ repoDir: repo, ssotRoot: ssot })

    assert.notEqual(withoutSkills.fingerprint.manifestSha, withSkills.fingerprint.manifestSha)
    assert.notEqual(withoutSkills.fingerprint.treeSha, withSkills.fingerprint.treeSha)
    assert.equal(
      withSkills.components.find((component) => component.id === "skills")?.present,
      true,
    )
  })
})

describe("review regressions (Chunk 4 code review)", () => {
  it("refuses an excluded directory at any depth in a component path", () => {
    for (const path of [".clinerules/node_modules/leak.md", ".clinerules/.git/config", ".tmp/x"]) {
      assert.throws(
        () => validateComponents([{ id: "x", path, kind: "file" }]),
        /never-captured directory/,
      )
    }
  })

  it("refuses a link into an excluded directory inside the SSOT", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await put(ssot, ".clinerules/node_modules/pkg/x.md", "dependency\n")
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await symlink(
      path.join(ssot, ".clinerules/node_modules/pkg/x.md"),
      path.join(repo, ".clinerules/x.md"),
    )

    assert.equal(await codeOf(capture(repo, ssot)), "LINK_INTO_EXCLUDED")
  })

  it("refuses a declared source that is itself a symlink", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await put(ssot, ".clinerules/real-rules.md", "real\n")
    await rm(path.join(ssot, ".clinerules/folder-demo.md"))
    await symlink(
      path.join(ssot, ".clinerules/real-rules.md"),
      path.join(ssot, ".clinerules/folder-demo.md"),
    )
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await symlink(path.join(ssot, ".clinerules/real-rules.md"), path.join(repo, ".clinerules/x.md"))

    const declared: readonly ComponentSpec[] = [
      {
        id: "clinerules",
        path: ".clinerules",
        kind: "directory",
        canonicalSources: [
          {
            destination: ".clinerules/x.md",
            source: { root: "ssot", path: ".clinerules/folder-demo.md" },
          },
        ],
      },
    ]
    // The declaration names a link; following it would authorise a file nobody wrote down.
    assert.equal(await codeOf(capture(repo, ssot, declared)), "CANONICAL_SOURCE_MISSING")
  })

  it("resolves `..` after a symlinked directory the way the kernel does", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await put(repo, "real/rules.md", "kernel truth\n")
    await put(repo, "rules.md", "lexical lie\n")
    await mkdir(path.join(repo, "real/subdir"), { recursive: true })
    await symlink(path.join(repo, "real/subdir"), path.join(repo, "alias"))
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    // Lexically this collapses to `rules.md`; the kernel walks alias -> real/subdir, so `..` is `real`.
    await symlink("../alias/../rules.md", path.join(repo, ".clinerules/x.md"))

    const result = await capture(repo, ssot)

    assert.equal(
      result.tree[".clinerules/x.md"],
      "kernel truth\n",
      "path.resolve would have captured the wrong file",
    )
  })

  it("keeps symlink provenance for a component declared as a single file", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await symlink(path.join(ssot, ".clinerules/folder-demo.md"), path.join(repo, "EXPERIENCE.md"))

    const components: readonly ComponentSpec[] = [
      { id: "experience", path: "EXPERIENCE.md", kind: "file" },
    ]
    const result = await capture(repo, ssot, components)

    assert.deepEqual(result.files[0]?.origin, {
      kind: "symlink",
      hops: 1,
      resolved: { root: "ssot", rootRelPath: ".clinerules/folder-demo.md" },
    })
  })

  it("captures a whole rules directory linked into the SSOT and hashes the association", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await symlink(path.join(ssot, ".clinerules"), path.join(repo, ".clinerules"))

    const result = await capture(repo, ssot)

    assert.deepEqual(result.tree, { ".clinerules/folder-demo.md": "canonical rules\n" })
    assert.deepEqual(result.files[0]?.origin, { kind: "regular", root: "ssot" })
    assert.equal(
      result.fingerprint.ssotRulesHash,
      ssotRulesHashOf([
        {
          destination: ".clinerules/folder-demo.md",
          sourceRoot: "ssot",
          sourcePath: ".clinerules/folder-demo.md",
          sourceSha256: sha256Hex("canonical rules\n"),
        },
      ]),
    )
  })

  it("accepts a declared source outside the SSOT rules subtree", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await put(ssot, "rules/other.md", "other rules\n")
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await symlink(path.join(ssot, "rules/other.md"), path.join(repo, ".clinerules/x.md"))

    const declared: readonly ComponentSpec[] = [
      {
        id: "clinerules",
        path: ".clinerules",
        kind: "directory",
        canonicalSources: [
          { destination: ".clinerules/x.md", source: { root: "ssot", path: "rules/other.md" } },
        ],
      },
    ]
    const result = await capture(repo, ssot, declared)

    assert.equal(result.files[0]?.canonical?.rootRelPath, "rules/other.md")
    assert.equal(result.files[0]?.canonical?.identical, true)
  })

/** Run a capture while atomically replacing the first file whose path ends with `suffix`. */
async function captureWithReplacement(
  repo: string,
  ssot: string,
  suffix: string,
  components?: readonly ComponentSpec[],
): Promise<string> {
  const originalOpen = fsPromises.open
  let armed = true
  fsPromises.open = (async (...args: Parameters<typeof fsPromises.open>) => {
    const target = String(args[0])
    if (armed && target.endsWith(suffix)) {
      armed = false
      // Atomic replacement with a new inode, so only the descriptor identity can catch it.
      await writeFile(`${target}.next`, "replaced\n")
      await rename(`${target}.next`, target)
    }
    return originalOpen(...args)
  }) as typeof fsPromises.open
  syncBuiltinESMExports()

  try {
    return await codeOf(capture(repo, ssot, components))
  } finally {
    fsPromises.open = originalOpen
    syncBuiltinESMExports()
  }
}

describe("consistency of every hashed source", () => {
  it("raises SOURCE_CHANGED for a regular component file", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await writeFile(path.join(repo, ".clinerules/a.md"), "original\n")

    assert.equal(await captureWithReplacement(repo, ssot, "/.clinerules/a.md"), "SOURCE_CHANGED")
  })

  it("raises SOURCE_CHANGED for the target of a symlinked rule file", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await symlink(path.join(ssot, ".clinerules/folder-demo.md"), path.join(repo, ".clinerules/x.md"))

    assert.equal(await captureWithReplacement(repo, ssot, "/folder-demo.md"), "SOURCE_CHANGED")
  })

  it("raises SOURCE_CHANGED for a declared canonical source", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await writeFile(path.join(repo, ".clinerules/x.md"), "generated\n")
    const declared: readonly ComponentSpec[] = [
      {
        id: "clinerules",
        path: ".clinerules",
        kind: "directory",
        canonicalSources: [
          {
            destination: ".clinerules/x.md",
            source: { root: "ssot", path: ".clinerules/folder-demo.md" },
          },
        ],
      },
    ]

    assert.equal(await captureWithReplacement(repo, ssot, "/folder-demo.md", declared), "SOURCE_CHANGED")
  })

  it("raises SOURCE_CHANGED for the lockfile", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await writeFile(path.join(repo, "pnpm-lock.yaml"), "lockfile v1\n")

    assert.equal(await captureWithReplacement(repo, ssot, "/pnpm-lock.yaml"), "SOURCE_CHANGED")
  })
})
})

describe("filesystem fidelity of component resolution", () => {
  it("captures a file component reached through a symlinked ancestor directory", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await put(repo, "real/rules.md", "through the alias\n")
    // `alias` is a symlink to a directory; the component's *leaf* is a regular file.
    await symlink(path.join(repo, "real"), path.join(repo, "alias"))

    const components: readonly ComponentSpec[] = [
      { id: "rules", path: "alias/rules.md", kind: "file" },
    ]
    const result = await capture(repo, ssot, components)

    assert.deepEqual(result.tree, { "alias/rules.md": "through the alias\n" })
    assert.deepEqual(result.files[0]?.origin, { kind: "regular", root: "repo" })
  })

  it("lets a single-file component declare an SSOT source outside .clinerules", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await put(ssot, "rules/other.md", "other rules\n")
    await symlink(path.join(ssot, "rules/other.md"), path.join(repo, "EXPERIENCE.md"))

    const components: readonly ComponentSpec[] = [
      {
        id: "experience",
        path: "EXPERIENCE.md",
        kind: "file",
        canonicalSources: [
          { destination: "EXPERIENCE.md", source: { root: "ssot", path: "rules/other.md" } },
        ],
      },
    ]
    const result = await capture(repo, ssot, components)

    assert.deepEqual(result.files[0]?.canonical, {
      root: "ssot",
      rootRelPath: "rules/other.md",
      sha256: sha256Hex("other rules\n"),
      identical: true,
    })
  })

  it("accepts a declared source sitting directly under the SSOT root", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await writeFile(path.join(ssot, "rules.md"), "top-level rules\n")
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await writeFile(path.join(repo, ".clinerules/x.md"), "generated\n")

    const declared: readonly ComponentSpec[] = [
      {
        id: "clinerules",
        path: ".clinerules",
        kind: "directory",
        canonicalSources: [
          { destination: ".clinerules/x.md", source: { root: "ssot", path: "rules.md" } },
        ],
      },
    ]
    const result = await capture(repo, ssot, declared)

    assert.equal(result.files[0]?.canonical?.rootRelPath, "rules.md")
    assert.equal(result.files[0]?.canonical?.identical, false)
  })

  it("refuses a link target that walks through a regular file", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await put(repo, "file.md", "not a directory\n")
    await put(repo, "real/rules.md", "reachable\n")
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    // The kernel reports ENOTDIR here; lexical collapsing would happily read `real/rules.md`.
    await symlink("../file.md/../real/rules.md", path.join(repo, ".clinerules/x.md"))

    assert.equal(await codeOf(capture(repo, ssot)), "SYMLINK_UNRESOLVED")
  })

  it("detects a self-deepening cycle instead of looping", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    // Each pass adds a segment, so a queue-length key would never repeat.
    await symlink("a/b", path.join(repo, ".clinerules/a"))

    assert.equal(await codeOf(capture(repo, ssot)), "SYMLINK_CYCLE")
  })

  it("refuses a trailing `/.` after a regular file", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await put(repo, "file.md", "not a directory\n")
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    // `file.md/.` requires a directory; dropping the dot would accept the file.
    await symlink("../file.md/.", path.join(repo, ".clinerules/x.md"))

    assert.equal(await codeOf(capture(repo, ssot)), "SYMLINK_UNRESOLVED")
  })

  it("follows a link back through an earlier link from a new position", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await put(repo, "real/sub/rules.md", "deep truth\n")
    await symlink(path.join(repo, "real"), path.join(repo, "alias"))
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    await symlink("alias/sub/rules.md", path.join(repo, "b"))
    await symlink("../alias/../b", path.join(repo, ".clinerules/x.md"))

    const result = await capture(repo, ssot)

    assert.equal(result.tree[".clinerules/x.md"], "deep truth\n")
  })

  it("treats a backslash as a filename character on POSIX", async () => {
    if (process.platform === "win32") return
    const repo = await initRepo()
    const ssot = await initSsot()
    await put(repo, "real/rules.md", "must not be reached\n")
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    // No file is literally named `real\rules.md`, so this must fail rather than split on the backslash.
    await symlink("../real\\rules.md", path.join(repo, ".clinerules/x.md"))

    assert.equal(await codeOf(capture(repo, ssot)), "SYMLINK_UNRESOLVED")
  })

  it("re-walks the same link from a different position without calling it a cycle", async () => {
    const repo = await initRepo()
    const ssot = await initSsot()
    await put(repo, "real/rules.md", "kernel truth\n")
    await symlink(path.join(repo, "real"), path.join(repo, "alias"))
    await mkdir(path.join(repo, ".clinerules"), { recursive: true })
    // `alias` is walked twice, but from a different position each time, so it is not a cycle.
    await symlink("../alias/../alias/rules.md", path.join(repo, ".clinerules/x.md"))

    const result = await capture(repo, ssot)

    assert.equal(result.tree[".clinerules/x.md"], "kernel truth\n")
  })
})
