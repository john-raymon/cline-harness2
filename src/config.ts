import { runConfigSchema, type RunConfig } from "./domain/schemas.ts"

/**
 * Configuration loading for one run.
 *
 * This module is pure: it reads no environment and performs no I/O, so the precedence rules are
 * testable without touching the process. `cli.ts` owns argv parsing, printing and exit codes.
 */

export const DEFAULT_K = 1
export const DEFAULT_MODE = "parallel" as const

/** Approved T4 thresholds. Signed off, so they are defaults rather than guesses — no warning. */
export const DEFAULT_T4 = {
  b1Tokens: 120_000,
  b2Tokens: 160_000,
  targetTokens: 105_000,
  tailTokens: 24_000,
} as const

export const DEFAULT_ARBITRATION = "off" as const

/**
 * Real oracle calls are opt-in.
 *
 * `pnpm test` must stay hermetic: the default suite drives the four role interfaces through an
 * injected runner, so a checkout with no credentials and no network still proves the wiring. `on`
 * is for the one live run that proves each role actually reaches a model.
 */
export const DEFAULT_ORACLE_LIVE = "off" as const

/**
 * The provider the operator names, and the SDK provider id it means.
 *
 * The SDK has no `openai` id — it has `openai-native` (its own client) and `openai-compatible`
 * (plain HTTP). Resolving the alias here, once, means the stored and fingerprinted value is the id
 * that actually selected a client, not the word the operator typed.
 */
export const DEFAULT_PROVIDER_ALIAS = "openai"
export const DEFAULT_PROVIDER_ID = "openai-compatible"
export const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  openai: DEFAULT_PROVIDER_ID,
  "openai-compatible": DEFAULT_PROVIDER_ID,
}

export const DEFAULT_BASE_URL = "https://api.synthetic.new/openai/v1"
export const DEFAULT_MODEL_ID = "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017"
export const KIMI_K3_MODEL_ID = "hf:moonshotai/Kimi-K3"

/**
 * Environment variables this project no longer reads.
 *
 * Supplying one is an error rather than a shrug: silently ignoring `HARNESS2_MODEL` would run the
 * default model while the operator believes they overrode it, and every measurement afterwards
 * would be attributed to the wrong model.
 */
export const RETIRED_ENV: Readonly<Record<string, string>> = {
  HARNESS2_PROVIDER: "SOLVER_PROVIDER",
  HARNESS2_MODEL: "SOLVER_MODEL",
  HARNESS2_API_KEY: "SOLVER_API_KEY",
  HARNESS2_BASE_URL: "SOLVER_BASE_URL",
}

/** First non-empty variable wins, in this order. */
export const API_KEY_ENV_CHAIN = [
  "SYNTHETIC_API_KEY",
  "SOLVER_API_KEY",
  "OPENAI_API_KEY",
] as const

/**
 * Oracle credentials, one chain per provider.
 *
 * The oracle clients are local CLIs (`gemini-api`, `codex`) that authenticate themselves from a
 * keyring or an OAuth session, so no key is required here. When one *is* supplied it is forwarded to
 * the child, and its variable name is recorded as provenance — the same discipline the solver key
 * gets, so a run can say which input a credential came from without the credential ever being stored.
 *
 * Astra's chain is its own name only. `OPENAI_API_KEY` belongs to the solver chain, and reading it
 * here would hand that key to `codex` and replace the CLI's own sign-in with an account the operator
 * may never have meant for the oracle. An oracle credential is opted into by naming it.
 */
export const GEMINI_API_KEY_ENV_CHAIN = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const
export const ASTRA_API_KEY_ENV_CHAIN = ["ASTRA_API_KEY"] as const

/** The two oracles the harness arbitrates between. */
export const ORACLE_PROVIDERS = ["gemini", "astra"] as const
export type OracleProvider = (typeof ORACLE_PROVIDERS)[number]

/**
 * Oracle model defaults.
 *
 * Named here rather than inside the oracle module so `loadConfig` and the clients cannot disagree
 * about which model a missing value means.
 */
export const DEFAULT_GEMINI_MODEL_ID = "gemini-4-argon"
export const DEFAULT_ASTRA_MODEL_ID = "gpt-6-astra"

export interface ConfigKeySpec {
  readonly key: keyof RawConfig
  /** A single variable, or a fallback chain tried in order. */
  readonly env: string | readonly string[]
  readonly flag: string
  readonly kind: "integer" | "string"
  readonly choices?: readonly string[]
  readonly summary: string
}

/** One table drives env parsing, CLI flag names and `--help` text, so they cannot drift apart. */
export const CONFIG_KEYS: readonly ConfigKeySpec[] = [
  { key: "k", env: "HARNESS2_K", flag: "k", kind: "integer", summary: "task-level recursion budget" },
  { key: "mode", env: "HARNESS2_MODE", flag: "mode", kind: "string", choices: ["parallel", "sequential"], summary: "oracle scheduling" },
  { key: "b1Tokens", env: "HARNESS2_B1_TOKENS", flag: "b1-tokens", kind: "integer", summary: "T4 soft-stub threshold" },
  { key: "b2Tokens", env: "HARNESS2_B2_TOKENS", flag: "b2-tokens", kind: "integer", summary: "T4 hard-summarise threshold" },
  { key: "targetTokens", env: "HARNESS2_TARGET_TOKENS", flag: "target-tokens", kind: "integer", summary: "T4 summarisation target" },
  { key: "tailTokens", env: "HARNESS2_TAIL_TOKENS", flag: "tail-tokens", kind: "integer", summary: "recent turns preserved verbatim" },
  { key: "arbitration", env: "HARNESS2_ARBITRATION", flag: "arbitration", kind: "string", choices: ["off", "probe"], summary: "extra arbitration probes, outside the 4k budget" },
  { key: "providerId", env: "SOLVER_PROVIDER", flag: "provider", kind: "string", summary: "openai | openai-compatible" },
  { key: "modelId", env: "SOLVER_MODEL", flag: "model", kind: "string", summary: "solver model id" },
  { key: "baseUrl", env: "SOLVER_BASE_URL", flag: "base-url", kind: "string", summary: "solver endpoint (https, or http for loopback)" },
  { key: "apiKey", env: API_KEY_ENV_CHAIN, flag: "api-key", kind: "string", summary: "solver API key (never persisted)" },
  { key: "geminiModelId", env: "ORACLE_GEMINI_MODEL", flag: "gemini-model", kind: "string", summary: "gemini oracle model id" },
  { key: "astraModelId", env: "ORACLE_ASTRA_MODEL", flag: "astra-model", kind: "string", summary: "astra oracle model id" },
  { key: "geminiApiKey", env: GEMINI_API_KEY_ENV_CHAIN, flag: "gemini-api-key", kind: "string", summary: "gemini oracle key (never persisted)" },
  { key: "astraApiKey", env: ASTRA_API_KEY_ENV_CHAIN, flag: "astra-api-key", kind: "string", summary: "astra oracle key (never persisted)" },
  { key: "oracleLive", env: "HARNESS2_LIVE_ORACLE", flag: "oracle-live", kind: "string", choices: ["off", "on"], summary: "allow real oracle calls in the test suite" },
  { key: "root", env: "HARNESS2_ROOT", flag: "root", kind: "string", summary: "run root directory" },
]

export interface RawConfig {
  k: number
  mode: string
  b1Tokens: number
  b2Tokens: number
  targetTokens: number
  tailTokens: number
  arbitration: string
  providerId: string
  modelId: string
  baseUrl: string
  apiKey: string | undefined
  geminiModelId: string
  astraModelId: string
  geminiApiKey: string | undefined
  astraApiKey: string | undefined
  oracleLive: string
  root: string
}

export type ConfigSource = "cli" | "env" | "default"

/**
 * Which input supplied the API key.
 *
 * A name, never the value. `"absent"` is explicit rather than an omitted field so a ledger can show
 * that the check ran and found nothing, instead of looking like a dropped column.
 */
export type ApiKeySource = "--api-key" | (typeof API_KEY_ENV_CHAIN)[number] | "absent"

/** The same provenance rule for each oracle, kept in its own type so the chains cannot be mixed up. */
export type GeminiApiKeySource =
  | "--gemini-api-key"
  | (typeof GEMINI_API_KEY_ENV_CHAIN)[number]
  | "absent"
export type AstraApiKeySource =
  | "--astra-api-key"
  | (typeof ASTRA_API_KEY_ENV_CHAIN)[number]
  | "absent"

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
  /** Which input supplied the API key: a flag or env name, or `"absent"`. Never the value. */
  readonly apiKeySource: ApiKeySource
  /** Provenance for the oracle keys, on the same terms: a name, or `"absent"`. */
  readonly geminiApiKeySource: GeminiApiKeySource
  readonly astraApiKeySource: AstraApiKeySource
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
  const secrets = collectSecrets(cli, env)

  const retired = findRetiredEnv(env)
  if (retired.length > 0) {
    const issues = retired.map(
      ([old, replacement]) => `${old} is no longer read; use ${replacement}`,
    )
    throw new ConfigError(`retired environment variables:\n  ${issues.join("\n  ")}`, issues)
  }

  const sources: Partial<Record<keyof RawConfig, ConfigSource>> = {}
  const raw: Record<string, unknown> = {}
  const failures: string[] = []

  for (const spec of CONFIG_KEYS) {
    const fromCli = cli[spec.key]
    const fromEnv = readEnv(spec, env)

    if (fromCli !== undefined) {
      sources[spec.key] = "cli"
      raw[spec.key] = coerce(spec, fromCli, `--${spec.flag}`, failures, secrets)
      continue
    }
    if (fromEnv !== undefined) {
      sources[spec.key] = "env"
      raw[spec.key] = coerce(spec, fromEnv.value, fromEnv.name, failures, secrets)
      continue
    }
    sources[spec.key] = "default"
    raw[spec.key] = defaultFor(spec.key, input.cwd)
  }

  resolveProvider(raw, sources, failures, secrets)

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

  return {
    config: parsed.data,
    warnings: buildWarnings(cli, env),
    sources,
    apiKeySource: resolveApiKeySource("api-key", cli.apiKey, env, API_KEY_ENV_CHAIN) as ApiKeySource,
    geminiApiKeySource: resolveApiKeySource(
      "gemini-api-key",
      cli.geminiApiKey,
      env,
      GEMINI_API_KEY_ENV_CHAIN,
    ) as GeminiApiKeySource,
    astraApiKeySource: resolveApiKeySource(
      "astra-api-key",
      cli.astraApiKey,
      env,
      ASTRA_API_KEY_ENV_CHAIN,
    ) as AstraApiKeySource,
  }
}

/** Variables the table no longer reads. A non-blank one is an error even if the new name is set. */
function findRetiredEnv(
  env: Readonly<Record<string, string | undefined>>,
): [string, string][] {
  return Object.entries(RETIRED_ENV).filter(([old]) => {
    const value = env[old]
    return value !== undefined && value.trim() !== ""
  })
}

/** First variable in a spec's chain that is set and non-blank. */
function readEnv(
  spec: ConfigKeySpec,
  env: Readonly<Record<string, string | undefined>>,
): { value: string; name: string } | undefined {
  const names = typeof spec.env === "string" ? [spec.env] : spec.env
  for (const name of names) {
    const value = env[name]
    // Whitespace-only counts as unset, so `SYNTHETIC_API_KEY="   "` falls through to the next name
    // instead of failing coercion for a variable the operator meant to clear.
    if (value !== undefined && value.trim() !== "") return { value, name }
  }
  return undefined
}

/** Where a key's value came from, for error messages that have to be actionable. */
function originOf(
  key: keyof RawConfig,
  sources: Readonly<Partial<Record<keyof RawConfig, ConfigSource>>>,
): string {
  const spec = CONFIG_KEYS.find((candidate) => candidate.key === key)
  if (!spec) return String(key)
  if (sources[key] === "cli") return `--${spec.flag}`
  const names = typeof spec.env === "string" ? [spec.env] : spec.env
  return names[0] ?? `--${spec.flag}`
}

/**
 * Turn a named provider into the SDK provider id.
 *
 * Rejecting an unknown name is deliberate: the SDK ships many provider ids, and a typo that fell
 * through would silently select a different HTTP client and a different capability set.
 */
function resolveProvider(
  raw: Record<string, unknown>,
  sources: Readonly<Partial<Record<keyof RawConfig, ConfigSource>>>,
  failures: string[],
  secrets: readonly string[],
): void {
  const value = raw["providerId"]
  if (typeof value !== "string" || value.length === 0) return
  const resolved = PROVIDER_ALIASES[value]
  if (resolved === undefined) {
    const origin = originOf("providerId", sources)
    failures.push(
      redact(
        `config ${origin}: unsupported provider ${JSON.stringify(value)}; ` +
          `accepted: ${Object.keys(PROVIDER_ALIASES).join(" | ")}`,
        secrets,
      ),
    )
    return
  }
  raw["providerId"] = resolved
}

/**
 * Warnings worth interrupting for.
 *
 * The T4 thresholds are approved, so defaulting them is not noteworthy. Two disagreeing API keys
 * are: the wrong account silently answers every request and the run still looks healthy. The oracle
 * chains get the same treatment, plus one warning the solver does not need: `OPENAI_API_KEY` belongs
 * to the solver *and* to the astra chain, and forwarding it to `codex` replaces that CLI's own
 * sign-in with a key the operator may never have meant for it.
 */
function buildWarnings(
  cli: Readonly<Partial<Record<keyof RawConfig, unknown>>>,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const warnings: string[] = []

  // An explicit flag is an explicit override, so env noise below it is not this run's problem.
  if (!hasCliApiKey(cli)) {
    const disagreement = disagreeingKeys(API_KEY_ENV_CHAIN, env)
    if (disagreement !== undefined) {
      warnings.push(
        `multiple API key environment variables are set and disagree (${disagreement.join(", ")}); ` +
          `${disagreement[0]} wins — unset the others so a run cannot silently use the wrong account`,
      )
    }
  }

  for (const [label, chain] of [
    ["gemini", GEMINI_API_KEY_ENV_CHAIN],
    ["astra", ASTRA_API_KEY_ENV_CHAIN],
  ] as const) {
    const disagreement = disagreeingKeys(chain, env)
    if (disagreement !== undefined) {
      warnings.push(
        `multiple ${label} oracle key environment variables are set and disagree ` +
          `(${disagreement.join(", ")}); ${disagreement[0]} wins`,
      )
    }
  }

  return warnings
}

/** The names in a chain that are set and non-blank, in precedence order; undefined when they agree. */
function disagreeingKeys(
  chain: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string[] | undefined {
  const present: { name: string; value: string }[] = []
  for (const name of chain) {
    const value = env[name]
    if (typeof value === "string" && value.trim().length > 0) present.push({ name, value })
  }
  if (present.length < 2) return undefined
  if (new Set(present.map((entry) => entry.value.trim())).size < 2) return undefined
  return present.map((entry) => entry.name)
}

function hasCliApiKey(cli: Readonly<Partial<Record<keyof RawConfig, unknown>>>): boolean {
  const value = cli.apiKey
  return typeof value === "string" && value.length > 0
}

function resolveApiKeySource(
  flag: string,
  fromCli: unknown,
  env: Readonly<Record<string, string | undefined>>,
  chain: readonly string[],
): string {
  if (typeof fromCli === "string" && fromCli.length > 0) return `--${flag}`
  for (const name of chain) {
    const value = env[name]
    if (value !== undefined && value.trim() !== "") return name
  }
  return "absent"
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
    case "arbitration":
      return DEFAULT_ARBITRATION
    case "providerId":
      return DEFAULT_PROVIDER_ALIAS
    case "modelId":
      return DEFAULT_MODEL_ID
    case "baseUrl":
      return DEFAULT_BASE_URL
    case "geminiModelId":
      return DEFAULT_GEMINI_MODEL_ID
    case "astraModelId":
      return DEFAULT_ASTRA_MODEL_ID
    case "oracleLive":
      return DEFAULT_ORACLE_LIVE
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
  if (spec.choices !== undefined && !spec.choices.includes(trimmed)) {
    failures.push(
      redact(
        `config ${origin}: expected one of ${spec.choices.join(" | ")}, ` +
          `received ${JSON.stringify(trimmed)}`,
        secrets,
      ),
    )
  }
  return trimmed
}

/**
 * Shortest value worth treating as a credential.
 *
 * Local shells routinely carry placeholders like `OPENAI_API_KEY=1` or `...=no`. Registering those
 * makes `redact` replace every `1` in unrelated messages (`b<redacted>Tokens`), which hides the real
 * error. No real API key is this short, so this is a noise filter, not a security relaxation.
 */
const MIN_SECRET_LENGTH = 4

function collectSecrets(
  cli: Readonly<Partial<Record<keyof RawConfig, unknown>>>,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  // Every source, including the ones that lose: a stale variable is still a live secret. The retired
  // name is listed too, so reordering `findRetiredEnv` later cannot quietly turn it into a leak.
  const candidates: unknown[] = [
    cli.apiKey,
    ...API_KEY_ENV_CHAIN.map((name) => env[name]),
    env["HARNESS2_API_KEY"],
    // Oracle credentials are secrets on exactly the same terms: a message that mentions one must not
    // print it, whether or not the value went on to be used.
    cli.geminiApiKey,
    cli.astraApiKey,
    ...GEMINI_API_KEY_ENV_CHAIN.map((name) => env[name]),
    ...ASTRA_API_KEY_ENV_CHAIN.map((name) => env[name]),
  ]
  const variants = new Set<string>()
  for (const value of candidates) {
    if (typeof value !== "string" || value.length === 0) continue
    // Coercion trims before reporting, and messages are built with JSON.stringify, so the original
    // secret is rarely the exact substring that leaks. Register every transform that can appear.
    for (const form of [value, value.trim()]) {
      if (form.length < MIN_SECRET_LENGTH) continue
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

