import { runConfigSchema, runModeSchema, type RunConfig } from "./domain/schemas.ts"

/**
 * Configuration loading for one run.
 *
 * This module is pure: it reads no environment and performs no I/O, so the precedence rules are
 * testable without touching the process. `cli.ts` owns argv parsing, printing and exit codes.
 */

export const DEFAULT_K = 1
export const DEFAULT_MODE = "parallel" as const

/** Provisional T4 thresholds. They are defaults, not measurements — see `warnings`. */
export const DEFAULT_T4 = {
  b1Tokens: 120_000,
  b2Tokens: 160_000,
  targetTokens: 105_000,
  tailTokens: 24_000,
} as const

export interface ConfigKeySpec {
  readonly key: keyof RawConfig
  readonly env: string
  readonly flag: string
  readonly kind: "integer" | "string"
  readonly summary: string
}

/** One table drives env parsing, CLI flag names and `--help` text, so they cannot drift apart. */
export const CONFIG_KEYS: readonly ConfigKeySpec[] = [
  { key: "k", env: "HARNESS2_K", flag: "k", kind: "integer", summary: "task-level recursion budget" },
  { key: "mode", env: "HARNESS2_MODE", flag: "mode", kind: "string", summary: "parallel | sequential" },
  { key: "b1Tokens", env: "HARNESS2_B1_TOKENS", flag: "b1-tokens", kind: "integer", summary: "T4 soft-stub threshold" },
  { key: "b2Tokens", env: "HARNESS2_B2_TOKENS", flag: "b2-tokens", kind: "integer", summary: "T4 hard-summarise threshold" },
  { key: "targetTokens", env: "HARNESS2_TARGET_TOKENS", flag: "target-tokens", kind: "integer", summary: "T4 summarisation target" },
  { key: "tailTokens", env: "HARNESS2_TAIL_TOKENS", flag: "tail-tokens", kind: "integer", summary: "recent turns preserved verbatim" },
  { key: "providerId", env: "HARNESS2_PROVIDER", flag: "provider", kind: "string", summary: "solver provider id" },
  { key: "modelId", env: "HARNESS2_MODEL", flag: "model", kind: "string", summary: "solver model id" },
  { key: "apiKey", env: "HARNESS2_API_KEY", flag: "api-key", kind: "string", summary: "solver API key (never persisted)" },
  { key: "root", env: "HARNESS2_ROOT", flag: "root", kind: "string", summary: "run root directory" },
]

export interface RawConfig {
  k: number
  mode: string
  b1Tokens: number
  b2Tokens: number
  targetTokens: number
  tailTokens: number
  providerId: string
  modelId: string
  apiKey: string | undefined
  root: string
}

export type ConfigSource = "cli" | "env" | "default"

export class ConfigError extends Error {
  override readonly name = "ConfigError"
  readonly issues: readonly string[]

  constructor(message: string, issues: readonly string[] = []) {
    super(message)
    this.issues = issues
  }
}

export interface LoadConfigInput {
  /** Parsed CLI flags, keyed by `ConfigKeySpec.key`. `undefined` means "not supplied". */
  readonly cli?: Readonly<Partial<Record<keyof RawConfig, unknown>>>
  /** Environment map. Injected so this function stays pure. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Directory used for the default run root. */
  readonly cwd: string
}

export interface LoadConfigResult {
  readonly config: RunConfig
  readonly warnings: readonly string[]
  readonly sources: Readonly<Partial<Record<keyof RawConfig, ConfigSource>>>
}

/**
 * Merge CLI over env over defaults, then validate.
 *
 * `undefined` never overwrites: an unset variable and an absent flag are both "not supplied", so a
 * blank `HARNESS2_MODE=` cannot silently disable a CLI flag the caller passed.
 */
export function loadConfig(input: LoadConfigInput): LoadConfigResult {
  const cli = input.cli ?? {}
  const env = input.env ?? {}
  const sources: Partial<Record<keyof RawConfig, ConfigSource>> = {}
  const raw: Record<string, unknown> = {}
  const failures: string[] = []
  const secrets = collectSecrets(cli, env)

  for (const spec of CONFIG_KEYS) {
    const fromCli = cli[spec.key]
    const fromEnv = env[spec.env]

    if (fromCli !== undefined) {
      sources[spec.key] = "cli"
      raw[spec.key] = coerce(spec, fromCli, `--${spec.flag}`, failures, secrets)
      continue
    }
    if (fromEnv !== undefined && fromEnv !== "") {
      sources[spec.key] = "env"
      raw[spec.key] = coerce(spec, fromEnv, spec.env, failures, secrets)
      continue
    }
    sources[spec.key] = "default"
    raw[spec.key] = defaultFor(spec.key, input.cwd)
  }

  if (failures.length > 0) {
    throw new ConfigError(`invalid configuration:\n${failures.join("\n")}`, failures)
  }

  const parsed = runConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const at = issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""
      return redact(`${at}${issue.message}`, secrets)
    })
    throw new ConfigError(`invalid configuration:\n${issues.join("\n")}`, issues)
  }

  return { config: parsed.data, warnings: buildWarnings(sources), sources }
}

function buildWarnings(sources: Readonly<Partial<Record<keyof RawConfig, ConfigSource>>>): string[] {
  const warnings: string[] = []
  const t4Keys = ["b1Tokens", "b2Tokens", "targetTokens", "tailTokens"] as const
  const defaulted = t4Keys.filter((key) => sources[key] === "default")
  if (defaulted.length === t4Keys.length) {
    warnings.push(
      `T4 thresholds are provisional defaults (b1=${DEFAULT_T4.b1Tokens}, b2=${DEFAULT_T4.b2Tokens}, ` +
        `target=${DEFAULT_T4.targetTokens}, tail=${DEFAULT_T4.tailTokens}); pin them with ` +
        "--b1-tokens/--b2-tokens/--target-tokens/--tail-tokens before a measured run",
    )
  } else if (defaulted.length > 0) {
    warnings.push(
      `T4 thresholds partially defaulted (${defaulted.join(", ")}); a mixed budget is easy to ` +
        "misread when comparing runs",
    )
  }
  return warnings
}

function defaultFor(key: keyof RawConfig, cwd: string): unknown {
  switch (key) {
    case "k":
      return DEFAULT_K
    case "mode":
      return DEFAULT_MODE
    case "b1Tokens":
      return DEFAULT_T4.b1Tokens
    case "b2Tokens":
      return DEFAULT_T4.b2Tokens
    case "targetTokens":
      return DEFAULT_T4.targetTokens
    case "tailTokens":
      return DEFAULT_T4.tailTokens
    case "root":
      return cwd
    default:
      return undefined
  }
}

function coerce(
  spec: ConfigKeySpec,
  value: unknown,
  origin: string,
  failures: string[],
  secrets: readonly string[],
): unknown {
  if (spec.kind === "integer") {
    const text = typeof value === "number" ? String(value) : String(value).trim()
    if (!/^\d+$/.test(text)) {
      failures.push(
        redact(`config ${origin}: expected an integer, received ${JSON.stringify(text)}`, secrets),
      )
      return Number.NaN
    }
    return Number.parseInt(text, 10)
  }
  if (typeof value !== "string") {
    failures.push(`config ${origin}: expected a string, received ${typeof value}`)
    return ""
  }
  const trimmed = value.trim()
  if (trimmed === "") {
    failures.push(`config ${origin}: must not be empty`)
    return ""
  }
  if (spec.key === "mode" && !runModeSchema.safeParse(trimmed).success) {
    failures.push(
      redact(
        `config ${origin}: expected one of ${runModeSchema.options.join(" | ")}, ` +
          `received ${JSON.stringify(trimmed)}`,
        secrets,
      ),
    )
  }
  return trimmed
}

function collectSecrets(
  cli: Readonly<Partial<Record<keyof RawConfig, unknown>>>,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const candidates = [cli.apiKey, env["HARNESS2_API_KEY"]]
  const variants = new Set<string>()
  for (const value of candidates) {
    if (typeof value !== "string" || value.length === 0) continue
    // Coercion trims before reporting, and messages are built with JSON.stringify, so the original
    // secret is rarely the exact substring that leaks. Register every transform that can appear.
    for (const form of [value, value.trim()]) {
      if (form.length === 0) continue
      variants.add(form)
      const escaped = JSON.stringify(form).slice(1, -1)
      if (escaped !== form) variants.add(escaped)
    }
  }
  // Longest first: a shorter variant would otherwise destroy the match for a longer one.
  return [...variants].sort((a, b) => b.length - a.length)
}

/** Replace every occurrence of a secret. Applied to every message that leaves this module. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length === 0) continue
    out = out.split(secret).join("<redacted>")
  }
  return out
}

