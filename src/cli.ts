import { ConfigError, loadConfig } from "./config.ts"
import { helpText, parseArgv } from "./cli/argv.ts"
import { budgetOf, remaining } from "./run/budget.ts"
import type { RunConfig } from "./domain/schemas.ts"

/**
 * The command line.
 *
 * Three things this file refuses to do: require a flag that has a default, print a secret, and report
 * success for something it did not run. Everything else is plumbing.
 *
 * Exit codes are distinct because a script has to tell the cases apart: `0` the run completed, `1` it
 * failed, `2` the invocation was wrong, `3` it halted deliberately (a `no-improvement` stop is not a
 * crash, and treating it as one hides the difference between "gave up" and "broke").
 */

export const EXIT_CODES = { ok: 0, failed: 1, usage: 2, halted: 3 } as const

export interface CliRunInput {
  readonly config: RunConfig
  readonly repo: string
  readonly task: string
}

export interface CliRunOutcome {
  readonly outcome: "completed" | "halted" | "failed"
  readonly detail?: string
}

export interface CliDeps {
  /** The run itself. Absent means this build cannot execute, and says so instead of pretending. */
  readonly execute?: (input: CliRunInput) => Promise<CliRunOutcome>
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface CliIo {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
}

export function consoleIo(): CliIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }
}

export async function main(
  argv: readonly string[],
  deps: CliDeps = {},
  io: CliIo = consoleIo(),
  cwd: string = process.cwd(),
): Promise<number> {
  const parsed = parseArgv(argv, cwd)

  if (parsed.help) {
    io.out(helpText({ cwd }))
    return EXIT_CODES.ok
  }
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) io.err(`harness2: ${error}`)
    io.err("try: harness2 --help")
    return EXIT_CODES.usage
  }
  if (parsed.task === undefined && !parsed.dryRun) {
    io.err('harness2: a task is required; pass it as the last argument or with --task "..."')
    io.err("try: harness2 --help")
    return EXIT_CODES.usage
  }

  let loaded: ReturnType<typeof loadConfig>
  try {
    loaded = loadConfig({
      // Only what was actually passed: `cwd: parsed.repo` below already makes the workspace the default
      // root, and seeding `root` here would outrank `HARNESS2_ROOT` for a flag nobody typed.
      cli: parsed.values,
      env: deps.env ?? process.env,
      cwd: parsed.repo,
    })
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    for (const issue of error.issues) io.err(`harness2: ${issue}`)
    return EXIT_CODES.usage
  }

  for (const warning of loaded.warnings) io.err(`harness2: warning: ${warning}`)
  const config = loaded.config

  if (parsed.dryRun || deps.execute === undefined) {
    printPlan(io, { config, repo: parsed.repo, task: parsed.task }, loaded.sources)
    if (parsed.dryRun) return EXIT_CODES.ok
    io.err("harness2: this build has no run wired; use --dry-run to inspect the plan")
    return EXIT_CODES.usage
  }

  const task = parsed.task ?? ""
  try {
    const result = await deps.execute({ config, repo: parsed.repo, task })
    if (result.detail !== undefined) io.out(`${result.outcome}: ${result.detail}`)
    return EXIT_CODES[result.outcome === "completed" ? "ok" : result.outcome === "halted" ? "halted" : "failed"]
  } catch (error) {
    io.err(`harness2: run failed: ${error instanceof Error ? error.message : String(error)}`)
    return EXIT_CODES.failed
  }
}

/** Everything the run will use, so `--dry-run` answers "what would happen" without spending anything. */
function printPlan(
  io: CliIo,
  input: { readonly config: RunConfig; readonly repo: string; readonly task: string | undefined },
  sources: Readonly<Partial<Record<string, string>>>,
): void {
  const { config } = input
  const budget = budgetOf({ k: config.k, executions: 0, improvements: 0 })
  const room = remaining(budget)
  const from = (key: string): string => {
    const source = sources[key]
    return source === undefined ? "" : ` (${source})`
  }

  io.out(`repo:        ${input.repo}`)
  io.out(`task:        ${input.task ?? "(none — dry run)"}`)
  io.out(`model:       ${config.modelId}${from("modelId")}`)
  io.out(`provider:    ${config.providerId}${from("providerId")} at ${config.baseUrl}`)
  io.out(`budget:      k=${config.k}${from("k")} -> ${room.executions} executions, ${room.improvements} improvements`)
  io.out(
    `t4:          tail ${config.tailTokens} / target ${config.targetTokens} / b1 ${config.b1Tokens} / b2 ${config.b2Tokens}`,
  )
  io.out(`arbitration: ${config.arbitration}${from("arbitration")}`)
  io.out(`api key:     ${config.apiKey === undefined ? "unset" : "set"}`)
}
