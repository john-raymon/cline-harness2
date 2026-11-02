import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { ConfigError, DEFAULT_T4, loadConfig, redact } from "../src/config.ts"

const CWD = "/tmp/harness2-cwd"
const REQUIRED = { providerId: "openai-compatible", modelId: "test-model" }

describe("loadConfig precedence", () => {
  it("applies defaults for the recursion budget and run root", () => {
    const { config, sources, warnings } = loadConfig({ cwd: CWD, cli: REQUIRED })
    assert.equal(config.k, 1)
    assert.equal(config.mode, "parallel")
    assert.equal(config.root, CWD)
    assert.equal(sources.k, "default")
    assert.equal(sources.root, "default")
    assert.equal(warnings.length, 1, "an all-default T4 budget must be flagged")
    assert.match(warnings[0] ?? "", /provisional defaults/)
  })

  it("lets env override defaults and cli override env", () => {
    const env = { HARNESS2_K: "2", HARNESS2_MODE: "sequential" }
    const fromEnv = loadConfig({ cwd: CWD, cli: REQUIRED, env })
    assert.equal(fromEnv.config.k, 2)
    assert.equal(fromEnv.config.mode, "sequential")
    assert.equal(fromEnv.sources.k, "env")

    const fromCli = loadConfig({ cwd: CWD, cli: { ...REQUIRED, k: 3 }, env })
    assert.equal(fromCli.config.k, 3)
    assert.equal(fromCli.config.mode, "sequential", "an unset flag must not clobber env")
    assert.equal(fromCli.sources.k, "cli")
  })

  it("treats an explicitly undefined flag and a blank env var as not supplied", () => {
    const { config, sources } = loadConfig({
      cwd: CWD,
      cli: { ...REQUIRED, k: undefined },
      env: { HARNESS2_K: "2", HARNESS2_MODE: "" },
    })
    assert.equal(config.k, 2, "undefined must not overwrite the env value")
    assert.equal(sources.k, "env")
    assert.equal(config.mode, "parallel", "a blank env var means unset")
    assert.equal(sources.mode, "default")
  })
})

describe("loadConfig validation", () => {
  it("refuses to invent a provider or model", () => {
    assert.throws(() => loadConfig({ cwd: CWD }), (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.match(error.message, /providerId/)
      return true
    })
  })

  it("names the offending source for a bad integer", () => {
    assert.throws(
      () => loadConfig({ cwd: CWD, cli: REQUIRED, env: { HARNESS2_K: "abc" } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.match(error.message, /HARNESS2_K: expected an integer, received "abc"/)
        return true
      },
    )
    assert.throws(
      () => loadConfig({ cwd: CWD, cli: { ...REQUIRED, k: "1.5" } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.match(error.message, /--k: expected an integer/)
        return true
      },
    )
  })

  it("rejects an unknown mode with the accepted set", () => {
    assert.throws(
      () => loadConfig({ cwd: CWD, cli: { ...REQUIRED, mode: "agg" } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.match(error.message, /expected one of parallel \| sequential/)
        return true
      },
    )
  })

  it("rejects an out-of-order T4 budget", () => {
    assert.throws(
      () => loadConfig({ cwd: CWD, cli: { ...REQUIRED, b1Tokens: 200_000, b2Tokens: 100_000 } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.match(error.message, /b2Tokens/)
        return true
      },
    )
  })

  it("warns when only part of the T4 budget is pinned", () => {
    const { warnings, config } = loadConfig({ cwd: CWD, cli: { ...REQUIRED, b1Tokens: 130_000 } })
    assert.equal(config.b1Tokens, 130_000)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? "", /partially defaulted \(b2Tokens, targetTokens, tailTokens\)/)
  })

  it("stays quiet once the whole budget is pinned", () => {
    const { warnings } = loadConfig({
      cwd: CWD,
      cli: {
        ...REQUIRED,
        b1Tokens: 130_000,
        b2Tokens: 170_000,
        targetTokens: 110_000,
        tailTokens: 20_000,
      },
    })
    assert.deepEqual(warnings, [])
  })
})

describe("secret handling", () => {
  it("redacts a secret that leaks into a failure message", () => {
    const secret = "sk-test-do-not-log-123"
    assert.throws(
      () => loadConfig({ cwd: CWD, cli: { ...REQUIRED, apiKey: secret, k: secret } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.ok(!error.message.includes(secret), `secret leaked: ${error.message}`)
        assert.match(error.message, /<redacted>/)
        return true
      },
    )
  })

  it("keeps the real secret in the resolved config so it can be used", () => {
    const secret = "sk-test-do-not-log-123"
    const { config } = loadConfig({ cwd: CWD, cli: { ...REQUIRED, apiKey: secret } })
    assert.equal(config.apiKey, secret)
  })

  it("redact() replaces every occurrence and ignores empties", () => {
    assert.equal(redact("a s b s", ["s"]), "a <redacted> b <redacted>")
    assert.equal(redact("unchanged", [""]), "unchanged")
  })

  it("redacts a secret that coercion trimmed before reporting it", () => {
    const secret = "  sk-padded-do-not-log-456  "
    assert.throws(
      () => loadConfig({ cwd: CWD, cli: { ...REQUIRED, apiKey: secret, k: secret } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.ok(
          !error.message.includes("sk-padded-do-not-log-456"),
          `trimmed secret leaked: ${error.message}`,
        )
        assert.match(error.message, /<redacted>/)
        return true
      },
    )
  })

  it("redacts a secret whose JSON-escaped form appears in the message", () => {
    const secret = 'sk-"quoted"-do-not-log-789'
    assert.throws(
      () => loadConfig({ cwd: CWD, cli: { ...REQUIRED, apiKey: secret, k: secret } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.ok(!error.message.includes("quoted"), `escaped secret leaked: ${error.message}`)
        return true
      },
    )
  })
})

describe("defaults are declared once", () => {
  it("exposes the provisional T4 budget it warns about", () => {
    const { config } = loadConfig({ cwd: CWD, cli: REQUIRED })
    assert.equal(config.b1Tokens, DEFAULT_T4.b1Tokens)
    assert.equal(config.b2Tokens, DEFAULT_T4.b2Tokens)
    assert.equal(config.targetTokens, DEFAULT_T4.targetTokens)
    assert.equal(config.tailTokens, DEFAULT_T4.tailTokens)
    assert.ok(config.tailTokens < config.targetTokens)
    assert.ok(config.targetTokens < config.b1Tokens)
    assert.ok(config.b1Tokens < config.b2Tokens)
  })
})
