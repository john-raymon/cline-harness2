import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { CONFIG_KEYS, DEFAULT_K, DEFAULT_T4, defaultFor } from "../src/config.ts"
import { helpText, parseArgv } from "../src/cli/argv.ts"
import { EXIT_CODES, main, type CliIo, type CliRunInput } from "../src/cli.ts"

/**
 * The CLI.
 *
 * The gate is "help text cannot drift from the table": every key in `CONFIG_KEYS` must be a flag the
 * parser accepts and a line the help prints, with the same default the resolver would use. The rest is the
 * ergonomics the harness is judged on — a task and nothing else has to be enough.
 */

const CWD = "/tmp/workspace"

function recorder(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err }
}

const NO_ENV = {}

describe("parseArgv", () => {
  it("takes the task from a flag or from the tail of the command", () => {
    assert.equal(parseArgv(["--task", "fix it"], CWD).task, "fix it")
    assert.equal(parseArgv(["fix", "the", "test"], CWD).task, "fix the test")
    assert.equal(parseArgv(["--", "--not-a-flag"], CWD).task, "--not-a-flag")
    assert.equal(parseArgv(["--task=a b"], CWD).task, "a b")
  })

  it("defaults the repository to the working directory", () => {
    assert.equal(parseArgv(["do it"], CWD).repo, CWD)
    assert.equal(parseArgv(["--repo", "/tmp/other", "do it"], CWD).repo, "/tmp/other")
  })

  it("accepts every flag the config table declares, and nothing else", () => {
    for (const spec of CONFIG_KEYS) {
      const parsed = parseArgv([`--${spec.flag}`, "7", "task"], CWD)
      assert.deepEqual(parsed.errors, [], `--${spec.flag} must parse`)
      assert.equal(parsed.values[spec.key], "7")
    }
    assert.deepEqual(parseArgv(["--nope", "task"], CWD).errors, ["unknown flag --nope"])
    assert.deepEqual(parseArgv(["--k"], CWD).errors, ["--k needs a value"])
  })
})

describe("helpText", () => {
  it("documents every config flag with the default the resolver would apply", () => {
    const text = helpText({ cwd: CWD })
    for (const spec of CONFIG_KEYS) {
      assert.ok(text.includes(`--${spec.flag}`), `--help must document --${spec.flag}`)
      assert.ok(text.includes(spec.summary), `--help must explain --${spec.flag}`)
      const fallback = defaultFor(spec.key, CWD)
      if (spec.key === "root") {
        assert.ok(text.includes("default: current directory"), "--root defaults to the working directory")
      } else if (typeof fallback === "string" || typeof fallback === "number") {
        assert.ok(
          text.includes(String(fallback)),
          `--help must show the default for --${spec.flag} (${String(fallback)})`,
        )
      }
    }
    assert.ok(text.includes("--task"))
    assert.ok(text.includes("--repo"))
  })

  it("never prints a secret and never invents a default for one", () => {
    const text = helpText({ cwd: CWD })
    for (const key of ["apiKey", "geminiApiKey", "astraApiKey"] as const) {
      const spec = CONFIG_KEYS.find((candidate) => candidate.key === key)
      assert.ok(spec !== undefined)
      assert.ok(!text.includes("default: undefined"))
    }
    assert.ok(text.includes("unset"))
  })
})

describe("main", () => {
  it("runs a task with nothing but the task, taking every knob from the defaults", async () => {
    const { io, out, err } = recorder()
    let seen: CliRunInput | undefined
    const code = await main(
      ["fix the failing test"],
      {
        env: NO_ENV,
        execute: async (input) => {
          seen = input
          return { outcome: "completed" }
        },
      },
      io,
      CWD,
    )

    assert.equal(code, EXIT_CODES.ok)
    assert.deepEqual(err, [], "a plain run on defaults must not warn")
    assert.equal(seen?.task, "fix the failing test")
    assert.equal(seen?.repo, CWD)
    assert.equal(seen?.config.k, DEFAULT_K)
    assert.equal(seen?.config.b1Tokens, DEFAULT_T4.b1Tokens)
    assert.equal(seen?.config.b2Tokens, DEFAULT_T4.b2Tokens)
    assert.equal(seen?.config.targetTokens, DEFAULT_T4.targetTokens)
    assert.equal(seen?.config.arbitration, "off")
    assert.deepEqual(out, [])
  })

  it("prints help, and refuses an invocation it cannot honour", async () => {
    const help = recorder()
    assert.equal(await main(["--help"], { env: NO_ENV }, help.io, CWD), EXIT_CODES.ok)
    assert.ok(help.out.join("\n").includes("--b2-tokens"))

    const bare = recorder()
    assert.equal(await main([], { env: NO_ENV }, bare.io, CWD), EXIT_CODES.usage)
    assert.match(bare.err.join("\n"), /a task is required/)

    const unknown = recorder()
    assert.equal(await main(["--nope", "task"], { env: NO_ENV }, unknown.io, CWD), EXIT_CODES.usage)
    assert.match(unknown.err.join("\n"), /unknown flag --nope/)
  })

  it("reports a config error as a usage problem, not a crash", async () => {
    const { io, err } = recorder()
    const code = await main(["--b1-tokens", "soon", "task"], { env: NO_ENV }, io, CWD)
    assert.equal(code, EXIT_CODES.usage)
    assert.match(err.join("\n"), /--b1-tokens: expected an integer/)
  })

  it("maps a halted run to its own exit code and a failed one to failure", async () => {
    const halted = recorder()
    assert.equal(
      await main(["task"], { env: NO_ENV, execute: async () => ({ outcome: "halted", detail: "no-improvement" }) }, halted.io, CWD),
      EXIT_CODES.halted,
    )
    assert.match(halted.out.join("\n"), /halted: no-improvement/)

    const failed = recorder()
    assert.equal(
      await main(["task"], { env: NO_ENV, execute: async () => ({ outcome: "failed" }) }, failed.io, CWD),
      EXIT_CODES.failed,
    )

    const threw = recorder()
    assert.equal(
      await main(["task"], { env: NO_ENV, execute: async () => { throw new Error("provider 502") } }, threw.io, CWD),
      EXIT_CODES.failed,
    )
    assert.match(threw.err.join("\n"), /provider 502/)
  })

  it("prints the resolved plan for a dry run and spends nothing", async () => {
    const { io, out } = recorder()
    let called = false
    const code = await main(
      ["--dry-run", "--repo", "/tmp/other", "--k", "2"],
      { env: NO_ENV, execute: async () => { called = true; return { outcome: "completed" } } },
      io,
      CWD,
    )
    assert.equal(code, EXIT_CODES.ok)
    assert.equal(called, false, "a dry run must not execute")
    const plan = out.join("\n")
    assert.match(plan, /repo: {8}\/tmp\/other/)
    assert.match(plan, /k=2 \(cli\)/)
    assert.match(plan, /8 executions, 6 improvements/)
    assert.match(plan, /api key: {5}unset/)
  })

  it("wires the real run by default, and reports its failure as a failure", async () => {
    const { io, err } = recorder()
    // No `execute` supplied: the CLI uses `runHarness`. A repo that does not exist fails at capture, which
    // proves the pipeline is wired (exit 1, not a usage error) without needing a provider.
    const code = await main(["task"], { env: NO_ENV }, io, "/nonexistent-repo-for-cli-test")
    assert.equal(code, EXIT_CODES.failed)
    assert.match(err.join("\n"), /run failed/)
  })
})

describe("review regressions", () => {
  it("refuses a single-dash token instead of silently making it part of the task", () => {
    assert.deepEqual(parseArgv(["-v", "task"], CWD).errors, ["unknown flag -v"])
    assert.equal(parseArgv(["--", "-x"], CWD).task, "-x", "after --, flag-shaped words are task text")
  })

  it("refuses a flag whose value looks like the next flag", () => {
    assert.deepEqual(parseArgv(["--repo", "--dry-run", "task"], CWD).errors, ["--repo needs a value"])
  })

  it("refuses two tasks and an empty one", () => {
    assert.deepEqual(parseArgv(["--task", "one", "two"], CWD).errors, [
      "the task was given twice (--task and positional arguments)",
    ])
    assert.deepEqual(parseArgv(["--task", "   "], CWD).errors, ["--task needs a value"])
  })

  it("lets HARNESS2_ROOT win when no --root was passed", async () => {
    const { io } = recorder()
    let root: string | undefined
    const code = await main(
      ["task"],
      {
        env: { HARNESS2_ROOT: "/tmp/from-env" },
        execute: async (input) => {
          root = (input.config as { root?: string }).root
          return { outcome: "completed" }
        },
      },
      io,
      CWD,
    )
    assert.equal(code, EXIT_CODES.ok)
    assert.equal(root, "/tmp/from-env", "an untyped root must not outrank the environment")
  })

  it("prints help without a trailing blank line", async () => {
    const { io, out } = recorder()
    await main(["--help"], { env: NO_ENV }, io, CWD)
    assert.equal(out.length, 1)
    assert.ok(!(out[0] ?? "").endsWith("\n\n"))
  })
})
