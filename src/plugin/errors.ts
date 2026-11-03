/**
 * Errors raised while building or validating the contract plugin.
 *
 * All of them are pre-flight failures: `B2.plugin` recorded that a manifest which over-claims is accepted
 * by the SDK without complaint, so the only place a bad plugin is detectable is before the session exists.
 */
export type PluginErrorCode =
  | "PLUGIN_INVALID"
  | "PLUGIN_UNSUPPORTED_CAPABILITY"
  | "PLUGIN_SETUP_FAILED"
  | "PLUGIN_TOOL_MISSING"
  | "PLUGIN_RULE_MISSING"

export class PluginError extends Error {
  override readonly name = "PluginError"
  readonly code: PluginErrorCode

  constructor(code: PluginErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
  }
}
