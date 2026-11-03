import { PluginError } from "./errors.ts"

/**
 * The harness's own contract plugin (c8).
 *
 * `B2.plugin` established the shape: `pluginPaths` registered nothing, and an imported object passed
 * through `extensions: [obj]` registered both a tool and a rule. So this module *builds the object* and
 * the session hands it to the runtime — there is no path loading and no plugin discovery.
 *
 * It is one fixed plugin, not a loader. A candidate-plugin pipeline needs a manifest trust model, a
 * capability negotiation and an import sandbox, and shipping a loader before any of those exist would be
 * a way to run arbitrary setup code inside a session that has no sandbox either.
 */

export const CONTRACT_PLUGIN_NAME = "harness2-contract"
export const CONTRACT_VERSION = 1
export const CONTRACT_TOOL_NAME = "harness_contract"
export const CONTRACT_RULE_ID = "harness2.contract"
/**
 * The rule text is a constant of this build, and the marker is what the live gate looks for.
 *
 * A plugin rule that varied per run would be prompt content nobody budgeted or fingerprinted, so it is
 * fixed and its digest is recorded instead of its text.
 */
export const CONTRACT_RULE_TEXT =
  "HARNESS2-CONTRACT: every tool call is gated by policy; a refused call has no effect " +
  "and must not be assumed to have run."

export interface ContractToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly execute: () => Promise<Record<string, unknown>>
}

/** The SDK's `createTool`, injected rather than imported, so this module never initialises the SDK. */
export type ToolFactory = (definition: ContractToolDefinition) => unknown

export interface PluginApi {
  readonly registerTool: (tool: unknown) => void
  readonly registerRule: (rule: Record<string, unknown>) => void
}

export interface ContractPlugin {
  readonly name: string
  readonly manifest: { readonly capabilities: readonly string[] }
  readonly setup: (api: PluginApi) => void
}

export const CONTRACT_EXPECTATIONS = {
  tools: [CONTRACT_TOOL_NAME],
  rules: [CONTRACT_RULE_ID],
  capabilities: ["tools", "rules"],
} as const

export function contractToolDefinition(): ContractToolDefinition {
  return {
    name: CONTRACT_TOOL_NAME,
    description: "Return the harness contract this session is running under.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ ok: true, contractVersion: CONTRACT_VERSION, ruleId: CONTRACT_RULE_ID }),
  }
}

/**
 * Build the plugin object the session injects.
 *
 * `createTool` is the SDK's factory when the session has loaded it; without one the definition is passed
 * through unchanged, which is what lets a unit test exercise `setup` without an SDK.
 */
export function buildContractPlugin(options: { readonly createTool?: ToolFactory } = {}): ContractPlugin {
  const definition = contractToolDefinition()
  const tool = options.createTool === undefined ? definition : options.createTool(definition)
  return {
    name: CONTRACT_PLUGIN_NAME,
    manifest: { capabilities: [...CONTRACT_EXPECTATIONS.capabilities] },
    setup(api: PluginApi) {
      api.registerTool(tool)
      api.registerRule({
        id: CONTRACT_RULE_ID,
        content: CONTRACT_RULE_TEXT,
        source: CONTRACT_PLUGIN_NAME,
      })
    },
  }
}

/**
 * The validation-only load `B2.plugin` demands.
 *
 * The plugin's `setup` runs against a recording stub *before* the SDK ever sees it, and every declared
 * capability is checked against what was actually registered. A manifest that claims `tools` and registers
 * none is refused here rather than accepted silently into a session that believes it has a guard.
 */
export function validateContractPlugin(plugin: ContractPlugin): { tools: string[]; rules: string[] } {
  const capabilities = [...plugin.manifest.capabilities].sort()
  const declared = [...CONTRACT_EXPECTATIONS.capabilities].sort()
  if (capabilities.join(",") !== declared.join(",")) {
    throw new PluginError(
      "PLUGIN_UNSUPPORTED_CAPABILITY",
      `${plugin.name} declares capabilities ${capabilities.join(",") || "(none)"}, but this harness ` +
        `implements exactly ${declared.join(",")}; an unimplemented capability is a claim nothing checks`,
    )
  }

  const tools: string[] = []
  const rules: string[] = []
  try {
    plugin.setup({
      registerTool: (tool) => {
        const name = (tool as { name?: unknown }).name
        if (typeof name !== "string" || name.trim().length === 0) {
          throw new PluginError("PLUGIN_INVALID", `${plugin.name} registered a tool with no usable name`)
        }
        if (tools.includes(name)) {
          throw new PluginError("PLUGIN_INVALID", `${plugin.name} registered tool ${name} twice`)
        }
        tools.push(name)
      },
      registerRule: (rule) => {
        const id = rule["id"]
        if (typeof id !== "string" || id.trim().length === 0) {
          throw new PluginError("PLUGIN_INVALID", `${plugin.name} registered a rule with no id`)
        }
        if (typeof rule["content"] !== "string" || rule["content"].trim().length === 0) {
          throw new PluginError("PLUGIN_INVALID", `${plugin.name} registered rule ${id} with no content`)
        }
        if (rules.includes(id)) {
          throw new PluginError("PLUGIN_INVALID", `${plugin.name} registered rule ${id} twice`)
        }
        rules.push(id)
      },
    })
  } catch (error) {
    if (error instanceof PluginError) throw error
    throw new PluginError("PLUGIN_SETUP_FAILED", `${plugin.name} setup threw: ${describe(error)}`, {
      cause: error,
    })
  }

  const missingTools = CONTRACT_EXPECTATIONS.tools.filter((name) => !tools.includes(name))
  if (missingTools.length > 0) {
    throw new PluginError(
      "PLUGIN_TOOL_MISSING",
      `${plugin.name} declares tool capability but did not register ${missingTools.join(", ")}; the SDK ` +
        "accepts that over-claim silently, so the session would run without the tool it advertised",
    )
  }
  const missingRules = CONTRACT_EXPECTATIONS.rules.filter((id) => !rules.includes(id))
  if (missingRules.length > 0) {
    throw new PluginError(
      "PLUGIN_RULE_MISSING",
      `${plugin.name} declares rule capability but did not register ${missingRules.join(", ")}`,
    )
  }
  return { tools, rules }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

