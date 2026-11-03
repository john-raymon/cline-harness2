import { ConfigError, loadConfig } from "./config.ts"
import { redactSecrets, runHarness } from "./run/harness.ts"
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
  /** Which input supplied the solver key: a flag name, an env name, or `"absent"`. Never the key. */
  readonly apiKeySource: string
  /** Write the improved harness back into the repository when the run ends. */
  readonly writeBack: boolean
}

export interface CliRunOutcome {
  readonly outcome: "completed" | "halted" | "failed"
  readonly detail?: string
}

export interface CliDeps {
  /** The run itself. Defaults to `runHarness`, wired here so `harness2 <task>` actually runs. */
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
  if ((parsed.task === undefined || parsed.task.trim().length === 0) && !parsed.dryRun) {
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

  if (parsed.dryRun) {
    printPlan(io, { config, repo: parsed.repo, task: parsed.task }, loaded.sources)
    return EXIT_CODES.ok
  }

  const execute = deps.execute ?? ((input: CliRunInput) => executeWithRunHarness(input, io))
  try {
    const result = await execute({
      config,
      repo: parsed.repo,
      task: parsed.task ?? "",
      apiKeySource: loaded.apiKeySource,
      writeBack: parsed.writeBack,
    })
    if (result.detail !== undefined) io.out(`${result.outcome}: ${result.detail}`)
    return EXIT_CODES[result.outcome === "completed" ? "ok" : result.outcome === "halted" ? "halted" : "failed"]
  } catch (error) {
    io.err(`harness2: run failed: ${error instanceof Error ? error.message : String(error)}`)
    return EXIT_CODES.failed
  }
}

/** The real run. Progress goes to stderr so stdout stays the run's result. */
function executeWithRunHarness(input: CliRunInput, io: CliIo): Promise<CliRunOutcome> {
  return runHarness({
    config: input.config,
    repo: input.repo,
    task: input.task,
    apiKeySource: input.apiKeySource,
    writeBack: input.writeBack,
    report: (line) => io.err(`harness2: ${line}`),
  }).then((result) => ({
    outcome: result.outcome,
    detail:
      `${result.detail} (run ${result.runId}, ${result.executions} executions, ` +
      `${result.improvements} improvements, ${result.acceptedImprovements} accepted, ` +
      `${result.writeBack?.written.length ?? 0} file(s) written back)`,
  }))
}

/** Everything the run will use, so `--dry-run` answers "what would happen" without spending anything. */
function printPlan(
  io: CliIo,
  input: { readonly config: RunConfig; readonly repo: string; readonly task: string | undefined },
  sources: Readonly<Partial<Record<string, string>>>,
): void {
  const { config } = input
  const secrets = [config.apiKey, config.geminiApiKey, config.astraApiKey].filter(
    (value): value is string => typeof value === "string" && value.trim().length >= 8,
  )
  // The task, the model id and the endpoint are caller-supplied strings: a key echoed into one of them
  // would otherwise be printed as part of a "harmless" plan.
  const out = (line: string): void => io.out(redactSecrets(line, secrets))
  const budget = budgetOf({ k: config.k, executions: 0, improvements: 0 })
  const room = remaining(budget)
  const from = (key: string): string => {
    const source = sources[key]
    return source === undefined ? "" : ` (${source})`
  }

  out(`repo:        ${input.repo}`)
  out(`task:        ${input.task ?? "(none - dry run)"}`)
  out(`model:       ${config.modelId}${from("modelId")}`)
  out(`provider:    ${config.providerId}${from("providerId")} at ${config.baseUrl}`)
  out(
    `budget:      k=${config.k}${from("k")} -> ${room.executions} executions, ${room.improvements} improvements`,
  )
  out(
    `t4:          tail ${config.tailTokens} / target ${config.targetTokens} / b1 ${config.b1Tokens} / b2 ${config.b2Tokens}`,
  )
  out(`arbitration: ${config.arbitration}${from("arbitration")}`)
  out(`api key:     ${config.apiKey === undefined ? "unset" : "set"}`)
}
