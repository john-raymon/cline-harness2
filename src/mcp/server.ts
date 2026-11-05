import path from "node:path"

import { ConfigError, loadConfig } from "../config.ts"
import { runHarness, type RunHarnessDeps } from "../run/harness.ts"
import type { RunConfig } from "../domain/schemas.ts"

/**
 * The MCP surface: one tool, no configuration.
 *
 * The point of this server is that a Cline session can call `harness2_run` with a task and get an improved
 * harness back without knowing anything about T4 thresholds, recursion budgets, providers or oracle models.
 * Every knob has a default from `config.ts`, and the schema below deliberately exposes only what a caller
 * legitimately varies: what to do, where, how deep, and whether to touch the repository.
 *
 * Transport is JSON-RPC 2.0 over stdin/stdout, one JSON object per line — the MCP stdio framing. No SDK
 * dependency: the protocol surface a tools-only server needs is four methods, and pulling in a full client
 * library to write them would be more code than the handlers.
 */

export const MCP_PROTOCOL_VERSION = "2024-11-05"
export const SERVER_NAME = "harness2"
export const SERVER_VERSION = "1.0.0"
export const RUN_TOOL_NAME = "harness2_run"

export interface JsonRpcRequest {
  readonly jsonrpc?: string
  readonly id?: string | number | null
  readonly method?: string
  readonly params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0"
  readonly id: string | number | null
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown }
}

/** The tool a Cline agent sees. `task` and `repo` are required: there is no working directory to guess from. */
export const RUN_TOOL = {
  name: RUN_TOOL_NAME,
  description:
    "Run the harness2 self-improvement loop on a repository and return the improved harness files. " +
    "Every threshold, provider and model setting is defaulted; `task` and `repo` are required.",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", minLength: 1, description: "the task the harness should be able to do" },
      repo: {
        type: "string",
        description:
          "Required absolute path to the target repository workspace (e.g. /Users/johnraymon/Projects/<repo>).",
      },
      k: {
        type: "integer",
        minimum: 1,
        maximum: 16,
        description: "recursion budget: 4k executions and 3k improvements (default 1)",
      },
      writeBack: {
        type: "boolean",
        description: "write the winning harness back into the repository (default true)",
      },
    },
    required: ["task", "repo"],
  },
} as const

/**
 * What the caller is told when `repo` is unusable.
 *
 * The server used to fall back to `process.cwd()`, which is the directory the MCP server was launched from —
 * not the workspace the agent is working in. A run silently improved the wrong repository and reported
 * success. Asking the caller for the path it actually means is the only honest default.
 */
const REPO_RETRY =
  "retry the call and pass the active workspace's absolute path in `repo` " +
  "(e.g. /Users/johnraymon/Projects/<repo>)"

/**
 * The operator's single source of truth for rules.
 *
 * In Multi-Root Mode this *is* Cline's `cwd`, so a caller reaching for "the active workspace" hands us the
 * config repo without meaning to. `cline-config` holds folder rules and MCP servers, not a project harness:
 * a run there would capture the config repo as if it were a project and then write back into it.
 */
export const SSOT_ROOT = "/Users/johnraymon/Projects/cline-config"

export interface McpDeps {
  /** Overrides for the run, used by tests: the whole loop is already a set of ports. */
  readonly harness?: RunHarnessDeps
  readonly now?: () => Date
  /** Environment used to resolve configuration. Defaults to `process.env`; injected by tests. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface ToolCallOutcome {
  readonly payload: Record<string, unknown>
  readonly isError: boolean
}

function textResult(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  }
}

/**
 * `harness2_run`.
 *
 * Validation is explicit rather than delegated to zod alone, because the failure has to be *reported to the
 * model* as a tool error rather than crashing the server: a session that gets a stack trace cannot recover,
 * and a session that gets "k must be an integer between 1 and 16" can.
 */
export async function callRunTool(
  params: Record<string, unknown>,
  deps: McpDeps = {},
): Promise<ToolCallOutcome> {
  try {
    return await runTool(params, deps)
  } catch (error) {
    // The server keeps serving no matter what the run does: a rejected promise here would leave the client
    // waiting for a response that never comes.
    return { isError: true, payload: { error: error instanceof Error ? error.message : String(error) } }
  }
}

async function runTool(params: Record<string, unknown>, deps: McpDeps): Promise<ToolCallOutcome> {
  const task = params.task
  if (typeof task !== "string" || task.trim().length === 0) {
    return { isError: true, payload: { error: "task is required and must be a non-empty string" } }
  }

  const rawRepo = params.repo
  if (typeof rawRepo !== "string" || rawRepo.trim().length === 0) {
    return { isError: true, payload: { error: `repo is required: ${REPO_RETRY}` } }
  }
  if (!path.isAbsolute(rawRepo)) {
    return {
      isError: true,
      payload: {
        error: `repo must be an absolute path, got ${JSON.stringify(rawRepo)}: ${REPO_RETRY}`,
      },
    }
  }
  const repo = path.resolve(rawRepo)
  if (repo === path.parse(repo).root) {
    return {
      isError: true,
      payload: {
        error: `repo must name a repository workspace, not the filesystem root (${repo}): ${REPO_RETRY}`,
      },
    }
  }
  if (repo === path.resolve(SSOT_ROOT)) {
    return {
      isError: true,
      payload: {
        error:
          `repo must be the active project repository, not the shared config root (${repo}): pass the ` +
          "absolute path of the sibling project you are working in " +
          "(e.g. /Users/johnraymon/Projects/<project>), never cline-config",
      },
    }
  }

  const k = params.k
  if (k !== undefined && (typeof k !== "number" || !Number.isInteger(k) || k < 1 || k > 16)) {
    return { isError: true, payload: { error: "k must be an integer between 1 and 16" } }
  }
  const writeBack = params.writeBack === undefined ? true : params.writeBack
  if (typeof writeBack !== "boolean") {
    return { isError: true, payload: { error: "writeBack must be a boolean" } }
  }

  let config: RunConfig
  let apiKeySource: string
  try {
    // Zero-config: the environment is read exactly as the CLI reads it, and every unset key falls back to the
    // default in `config.ts`. A caller that passes `repo` does not have to pass anything else.
    const loaded = loadConfig({
      env: deps.env ?? process.env,
      cwd: path.resolve(repo),
      ...(k === undefined ? {} : { cli: { k } }),
    })
    config = loaded.config
    apiKeySource = loaded.apiKeySource
  } catch (error) {
    if (error instanceof ConfigError) {
      return { isError: true, payload: { error: "invalid configuration", issues: error.issues } }
    }
    return { isError: true, payload: { error: error instanceof Error ? error.message : String(error) } }
  }

  try {
    const result = await runHarness({
      config,
      repo,
      task,
      apiKeySource,
      writeBack,
      ...(deps.harness === undefined && deps.now === undefined
        ? {}
        : {
            deps: {
              ...(deps.harness ?? {}),
              ...(deps.now === undefined ? {} : { now: deps.now }),
            },
          }),
    })

    return {
      isError: result.outcome === "failed",
      payload: {
        outcome: result.outcome,
        reason: result.reason,
        detail: result.detail,
        runId: result.runId,
        runDir: result.runDir,
        counts: {
          executions: result.executions,
          improvements: result.improvements,
          acceptedImprovements: result.acceptedImprovements,
          lessons: result.lessons,
        },
        selections: result.selections,
        improvedFiles: (result.writeBack?.written ?? []).map((file) => ({
          path: file.path,
          kind: file.kind,
        })),
        ledgerPath: result.ledgerPath,
      },
    }
  } catch (error) {
    // A thrown run is a tool error with a message, never a broken server.
    return { isError: true, payload: { error: error instanceof Error ? error.message : String(error) } }
  }
}

/** One request in, one response out. `undefined` means "a notification: say nothing". */
export async function handleRequest(
  request: JsonRpcRequest,
  deps: McpDeps = {},
): Promise<JsonRpcResponse | undefined> {
  const id = request.id ?? null
  const method = request.method

  if (typeof method !== "string") {
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request: no method" } }
  }

  // A request with no id is a notification: the protocol says it must not be answered, for *any* method. A
  // client that sends `tools/list` without an id has asked for silence, and answering would corrupt its stream.
  const isNotification = request.id === undefined
  if (isNotification) return undefined

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      }
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined
    case "ping":
      return { jsonrpc: "2.0", id, result: {} }
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: [RUN_TOOL] } }
    case "tools/call": {
      const params = request.params
      if (typeof params !== "object" || params === null || Array.isArray(params)) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: "invalid params" } }
      }
      const name = params.name
      if (name !== RUN_TOOL_NAME) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `unknown tool ${JSON.stringify(name)}` },
        }
      }
      const raw = params.arguments ?? {}
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: "arguments must be an object" } }
      }
      const args = raw as Record<string, unknown>
      const outcome = await callRunTool(args, deps)
      return {
        jsonrpc: "2.0",
        id,
        result: { ...textResult(outcome.payload), isError: outcome.isError },
      }
    }
    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      }
  }
}
