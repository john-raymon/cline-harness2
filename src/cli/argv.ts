import { CONFIG_KEYS, defaultFor, type RawConfig } from "../config.ts"

/**
 * Argument parsing, and the help text that has to match it.
 *
 * Two rules shape this file. The flags are `CONFIG_KEYS` — a flag is not declared here and wired there,
 * because that is how `--help` starts describing options nobody can pass. And every internal knob has a
 * default, so the only thing a caller *must* supply is the task: `harness2 "fix the failing test"` has to
 * work, with the T4 thresholds, the recursion budget and the model all resolved from `config.ts`.
 */

export const TASK_FLAG = "task"
export const REPO_FLAG = "repo"
export const DRY_RUN_FLAG = "dry-run"

export const USAGE = "harness2 [options] [--] <task>"

export interface ParsedArgv {
  /** Config flags, keyed by `RawConfig` key. Values stay raw; `loadConfig` coerces and validates them. */
  readonly values: Readonly<Partial<Record<keyof RawConfig, string>>>
  /** `--task`, or the positional words joined with single spaces. */
  readonly task: string | undefined
  /** The target workspace. Defaults to the working directory, which is what `--repo` almost always is. */
  readonly repo: string
  readonly help: boolean
  readonly dryRun: boolean
  readonly errors: readonly string[]
}

const CONFIG_BY_FLAG = new Map(CONFIG_KEYS.map((spec) => [spec.flag, spec] as const))

export function parseArgv(argv: readonly string[], cwd: string): ParsedArgv {
  const values: Partial<Record<keyof RawConfig, string>> = {}
  const positionals: string[] = []
  const errors: string[] = []
  let task: string | undefined
  let repo = cwd
  let help = false
  let dryRun = false
  let index = 0

  while (index < argv.length) {
    const token = argv[index] ?? ""
    index += 1

    if (token === "--") {
      // Everything after `--` is the task, including words that look like flags.
      positionals.push(...argv.slice(index))
      break
    }
    if (token === "-h" || token === "--help") {
      help = true
      continue
    }
    if (token === `--${DRY_RUN_FLAG}`) {
      dryRun = true
      continue
    }
    if (token.startsWith("-") && !token.startsWith("--") && token !== "-") {
      // A single-dash token is a flag this parser does not have. Absorbing it as task text would run a
      // slightly different task than the one typed, which is worse than refusing.
      errors.push(`unknown flag ${token}`)
      continue
    }
    if (!token.startsWith("--")) {
      positionals.push(token)
      continue
    }

    const equals = token.indexOf("=")
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals)
    let value = equals === -1 ? undefined : token.slice(equals + 1)
    if (value === undefined) {
      const next = argv[index]
      // `--repo --dry-run` means the value was forgotten; taking the flag as a path would disable a mode
      // the caller asked for and leave a directory named after a flag.
      if (next === undefined || (next.startsWith("-") && next !== "-")) {
        errors.push(`--${name} needs a value`)
        continue
      }
      value = next
      index += 1
    }
    if (value.length === 0) {
      errors.push(`--${name} needs a value`)
      continue
    }

    if (name === TASK_FLAG) {
      const trimmed = value.trim()
      if (trimmed.length === 0) {
        errors.push(`--${name} needs a value`)
        continue
      }
      task = trimmed
      continue
    }
    if (name === REPO_FLAG) {
      repo = value
      continue
    }
    const spec = CONFIG_BY_FLAG.get(name)
    if (spec === undefined) {
      errors.push(`unknown flag --${name}`)
      continue
    }
    values[spec.key] = value
  }

  const joined = positionals.join(" ").trim()
  if (task !== undefined && joined.length > 0) {
    // Two tasks in one invocation: picking one silently would run something the caller did not ask for.
    errors.push("the task was given twice (--task and positional arguments)")
  }
  return {
    values,
    task: task ?? (joined.length === 0 ? undefined : joined),
    repo,
    help,
    dryRun,
    errors,
  }
}

/**
 * `--help`, rendered from `CONFIG_KEYS`.
 *
 * Each line is generated from the same spec the parser reads and the same `defaultFor` the resolver
 * applies, so a flag cannot exist without appearing here, and a default cannot drift from the one that
 * would actually be used. The API keys print as "(unset)" — never a value, and never a default that
 * looks like one.
 */
export function helpText(options: { readonly cwd?: string } = {}): string {
  const cwd = options.cwd ?? process.cwd()
  const rows = CONFIG_KEYS.map((spec) => {
    const fallback = defaultFor(spec.key, cwd)
    const env = typeof spec.env === "string" ? spec.env : (spec.env[0] ?? "")
    return {
      flag: `--${spec.flag} <${spec.kind === "integer" ? "int" : "value"}>`,
      summary: spec.summary,
      env,
      ...describeDefault(spec.key, fallback),
    }
  })
  const width = rows.reduce((widest, row) => Math.max(widest, row.flag.length), 0)

  const lines = [
    USAGE,
    "",
    "Runs one task against a harness in --repo, improving it within the 4k/3k budget.",
    "Every option below has a default: pass the task and nothing else to start.",
    "",
    "Options:",
    "  -h, --help".padEnd(width + 4) + "show this help and exit",
    `  --${DRY_RUN_FLAG}`.padEnd(width + 4) + "resolve everything, print the plan, run nothing",
    `  --${TASK_FLAG} <text>`.padEnd(width + 4) + "the task to run (or pass it as the last argument)",
    `  --${REPO_FLAG} <dir>`.padEnd(width + 4) + "workspace to work in (default: current directory)",
    "",
    "Configuration:",
  ]

  for (const row of rows) {
    lines.push(`  ${row.flag.padEnd(width)}  ${row.summary} [${row.describe}; env ${row.env}]`)
  }

  lines.push(
    "",
    "A flag overrides its environment variable, which overrides the default. See docs/ADAPTER.md.",
  )
  return lines.join("\n")
}

function describeDefault(
  key: keyof RawConfig,
  fallback: unknown,
): { describe: string } {
  if (key === "apiKey" || key === "geminiApiKey" || key === "astraApiKey") {
    // A key is never printed, and never has a default that could be mistaken for one.
    return { describe: "unset" }
  }
  if (fallback === undefined) return { describe: "no default" }
  if (key === "root") return { describe: "default: current directory" }
  return { describe: `default: ${String(fallback)}` }
}
