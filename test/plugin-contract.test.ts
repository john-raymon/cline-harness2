import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildContractPlugin,
  CONTRACT_PLUGIN_NAME,
  CONTRACT_RULE_ID,
  CONTRACT_RULE_TEXT,
  CONTRACT_TOOL_NAME,
  contractToolDefinition,
  validateContractPlugin,
  type ContractPlugin,
} from "../src/plugin/contract.ts"
import { PluginError } from "../src/plugin/errors.ts"

function codeOf(operation: () => unknown): string {
  try {
    operation()
  } catch (error) {
    assert.ok(error instanceof PluginError, `expected PluginError, got ${String(error)}`)
    return error.code
  }
  assert.fail("expected a rejection")
}

function pluginWith(overrides: Partial<ContractPlugin> & { capabilities?: readonly string[] }): ContractPlugin {
  const base = buildContractPlugin()
  return {
    name: overrides.name ?? base.name,
    manifest: { capabilities: overrides.capabilities ?? base.manifest.capabilities },
    setup: overrides.setup ?? base.setup,
  }
}

describe("the contract plugin", () => {
  it("registers exactly the tool and rule it declares", () => {
    const plugin = buildContractPlugin()
    const registered = validateContractPlugin(plugin)
    assert.equal(plugin.name, CONTRACT_PLUGIN_NAME)
    assert.deepEqual(registered.tools, [CONTRACT_TOOL_NAME])
    assert.deepEqual(registered.rules, [CONTRACT_RULE_ID])
    assert.match(CONTRACT_RULE_TEXT, /^HARNESS2-CONTRACT:/)
  })

  it("passes the tool definition through the injected factory", () => {
    const seen: unknown[] = []
    const plugin = buildContractPlugin({ createTool: (definition) => ({ ...definition, built: true }) })
    plugin.setup({
      registerTool: (tool) => seen.push(tool),
      registerRule: () => undefined,
    })
    assert.deepEqual((seen[0] as { built?: boolean }).built, true)
    assert.equal((seen[0] as { name?: string }).name, CONTRACT_TOOL_NAME)
  })

  it("describes a tool that takes no arguments, so the model cannot pass any", () => {
    const definition = contractToolDefinition()
    assert.deepEqual(definition.inputSchema["properties"], {})
    assert.equal(definition.inputSchema["additionalProperties"], false)
  })

  it("refuses an over-claiming manifest, which the SDK accepts silently", () => {
    const plugin = pluginWith({ setup: () => undefined })
    assert.equal(codeOf(() => validateContractPlugin(plugin)), "PLUGIN_TOOL_MISSING")
  })

  it("refuses a rule capability with no rule", () => {
    const plugin = pluginWith({
      setup: (api) => {
        api.registerTool(contractToolDefinition())
      },
    })
    assert.equal(codeOf(() => validateContractPlugin(plugin)), "PLUGIN_RULE_MISSING")
  })

  it("refuses a capability the harness does not implement", () => {
    const plugin = pluginWith({ capabilities: ["tools", "rules", "hooks"] })
    assert.equal(codeOf(() => validateContractPlugin(plugin)), "PLUGIN_UNSUPPORTED_CAPABILITY")
  })

  it("wraps a setup that throws, keeping the cause", () => {
    const plugin = pluginWith({
      setup: () => {
        throw new Error("setup exploded")
      },
    })
    try {
      validateContractPlugin(plugin)
      assert.fail("expected a rejection")
    } catch (error) {
      assert.ok(error instanceof PluginError)
      assert.equal(error.code, "PLUGIN_SETUP_FAILED")
      assert.match(error.message, /setup exploded/)
      assert.ok(error.cause instanceof Error)
    }
  })

  it("refuses a rule with no content or a duplicate registration", () => {
    const noContent = pluginWith({
      setup: (api) => {
        api.registerTool(contractToolDefinition())
        api.registerRule({ id: CONTRACT_RULE_ID, content: "  " })
      },
    })
    assert.equal(codeOf(() => validateContractPlugin(noContent)), "PLUGIN_INVALID")

    const twice = pluginWith({
      setup: (api) => {
        const definition = contractToolDefinition()
        api.registerTool(definition)
        api.registerTool(definition)
        api.registerRule({ id: CONTRACT_RULE_ID, content: "x" })
      },
    })
    assert.equal(codeOf(() => validateContractPlugin(twice)), "PLUGIN_INVALID")
  })
})
