#!/usr/bin/env node
// Point this repo's git hooks at the tracked `.githooks` directory.
//
// Git will not run a committed hook by itself: `core.hooksPath` is a per-clone setting,
// so a fresh clone is unprotected until something sets it. This script is that
// something — it runs from `pnpm install` via the `prepare` script, and on demand via
// `pnpm run hooks:install`.
//
// Deliberately conservative: it never overwrites a hooks path the developer chose
// (husky, lefthook, a company wrapper), and it exits 0 outside a git checkout so a
// tarball install or a CI install never breaks on it.
import { execFileSync } from "node:child_process"
import { chmodSync, statSync } from "node:fs"
import { join } from "node:path"

const HOOKS_DIR = ".githooks"
// Both hooks ship in this directory; missing the second one from the executable-bit
// repair is how a gate silently stops existing after a zip download.
const HOOK_FILES = ["pre-commit", "pre-push"]

/** Run git and return trimmed stdout. Throws on a non-zero exit. */
function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

/** Run git and return trimmed stdout, or null when it exits non-zero. */
function gitOrNull(args) {
  try {
    return git(args)
  } catch {
    return null
  }
}

/** Whether a binary resolves and runs on PATH. */
function isInstalled(bin) {
  try {
    execFileSync(bin, ["version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const root = gitOrNull(["rev-parse", "--show-toplevel"])
if (root === null) {
  console.log("install-hooks: not a git checkout, nothing to do")
  process.exit(0)
}

// `--local` matters: without it a global `~/.gitconfig` hooksPath (dotfiles, a global
// template) reads as if this repo had chosen it, and the repo stays unguarded while
// this script reports success.
const current = gitOrNull(["config", "--local", "--get", "core.hooksPath"])
const configured = current === null ? "" : current
// A trailing slash is the same setting; treat it as such rather than reporting a clash.
// A leading `./` is the same directory Git will use; normalise it so a developer who set
// it that way is not told there is a clash with their own setting.
const normalized = configured.replace(/^\.\//, "").replace(/\/+$/, "")
let ownsHooksPath = false

if (normalized === HOOKS_DIR) {
  ownsHooksPath = true
  console.log(`install-hooks: core.hooksPath already ${HOOKS_DIR}`)
} else if (normalized === "") {
  git(["config", "core.hooksPath", HOOKS_DIR])
  ownsHooksPath = true
  console.log(`install-hooks: core.hooksPath -> ${HOOKS_DIR}`)
} else {
  console.warn(`install-hooks: core.hooksPath is already "${configured}"; leaving it untouched.`)
  console.warn(`install-hooks: to use the tracked hooks instead, run: git config core.hooksPath ${HOOKS_DIR}`)
}

// Git skips a hook that is not executable, and the x bit is easy to lose through a
// zip download or an unzip that drops the mode. Restore it instead of failing.
const missing = []
for (const hookFile of HOOK_FILES) {
  const hookPath = join(root, HOOKS_DIR, hookFile)
  let mode = null
  try {
    mode = statSync(hookPath).mode
  } catch {
    missing.push(hookFile)
    continue
  }

  if ((mode & 0o111) === 0) {
    chmodSync(hookPath, 0o755)
    console.log(`install-hooks: restored the executable bit on ${HOOKS_DIR}/${hookFile}`)
  }
}

// A missing scanner is not an install failure — the hooks report it per commit, and CI
// does not depend on it. Say it once here so nobody is surprised at commit time.
if (!isInstalled("gitleaks")) {
  console.warn("install-hooks: gitleaks is not on PATH; commits and pushes will be refused until it is.")
  console.warn("install-hooks: brew install gitleaks")
}

// The checks above ran even when another tool owns the hooks directory, so this is the
// only place that says the wiring is not actually in effect.
if (!ownsHooksPath) {
  console.warn(`install-hooks: ${HOOKS_DIR}/${HOOK_FILES.join(", ")} will not run until core.hooksPath points at ${HOOKS_DIR}.`)
} else if (missing.length > 0) {
  console.warn(`install-hooks: missing hook files: ${missing.join(", ")}`)
}
