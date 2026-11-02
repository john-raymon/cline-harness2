import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  API_KEY_ENV_CHAIN,
  ConfigError,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL_ID,
  DEFAULT_T4,
  KIMI_K3_MODEL_ID,
  RETIRED_ENV,
  loadConfig,
  redact,
} from "../src/config.ts"

const CWD = "/tmp/harness2-cwd"

describe("defaults (V1)", () => {
  it("resolves a complete config with no env and no flags", () => {
    const { config, sources, warnings, apiKeySource } = loadConfig({ cwd: CWD })
    assert.equal(config.k, 1)
    assert.equal(config.mode, "parallel")
    assert.equal(config.providerId, "openai-compatible")
    assert.equal(config.modelId, DEFAULT_MODEL_ID)
    assert.equal(config.baseUrl, DEFAULT_BASE_URL)
    assert.equal(config.arbitration, "off")
    assert.equal(config.root, CWD)
    assert.equal(config.apiKey, undefined)
    assert.equal(sources.k, "default")
    assert.equal(apiKeySource, "absent")
    assert.deepEqual(warnings, [], "approved T4 defaults are not a warning")
  })

  it("keeps the approved T4 budget as a strictly increasing chain", () => {
    const { config } = loadConfig({ cwd: CWD })
    assert.equal(config.b1Tokens, DEFAULT_T4.b1Tokens)
    assert.equal(config.b2Tokens, DEFAULT_T4.b2Tokens)
    assert.equal(config.targetTokens, DEFAULT_T4.targetTokens)
    assert.equal(config.tailTokens, DEFAULT_T4.tailTokens)
    assert.ok(config.tailTokens < config.targetTokens)
    assert.ok(config.targetTokens < config.b1Tokens)
    assert.ok(config.b1Tokens < config.b2Tokens)
  })
})

describe("precedence", () => {
  it("lets env override defaults and cli override env", () => {
    const env = { HARNESS2_K: "2", HARNESS2_MODE: "sequential" }
    const fromEnv = loadConfig({ cwd: CWD, env })
    assert.equal(fromEnv.config.k, 2)
    assert.equal(fromEnv.config.mode, "sequential")
    assert.equal(fromEnv.sources.k, "env")

    const fromCli = loadConfig({ cwd: CWD, cli: { k: 3 }, env })
    assert.equal(fromCli.config.k, 3)
    assert.equal(fromCli.config.mode, "sequential", "an unset flag must not clobber env")
    assert.equal(fromCli.sources.k, "cli")
  })

  it("treats an explicitly undefined flag and a blank env var as not supplied", () => {
    const { config, sources } = loadConfig({
      cwd: CWD,
      cli: { k: undefined },
      env: { HARNESS2_K: "2", HARNESS2_MODE: "" },
    })
    assert.equal(config.k, 2, "undefined must not overwrite the env value")
    assert.equal(sources.k, "env")
    assert.equal(config.mode, "parallel", "a blank env var means unset")
    assert.equal(sources.mode, "default")
  })
})

describe("provider resolution (V2)", () => {
  it("resolves the openai alias to the SDK provider id", () => {
    assert.equal(
      loadConfig({ cwd: CWD, env: { SOLVER_PROVIDER: "openai" } }).config.providerId,
      "openai-compatible",
    )
    assert.equal(
      loadConfig({ cwd: CWD, cli: { providerId: "openai" } }).config.providerId,
      "openai-compatible",
    )
    assert.equal(
      loadConfig({ cwd: CWD, cli: { providerId: "openai-compatible" } }).config.providerId,
      "openai-compatible",
    )
  })

  it("rejects a provider the adapter does not support, listing what it accepts", () => {
    assert.throws(
      () => loadConfig({ cwd: CWD, cli: { providerId: "openai-native" } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.match(error.message, /--provider: unsupported provider "openai-native"/)
        assert.match(error.message, /accepted: openai \| openai-compatible/)
        return true
      },
    )
    assert.throws(
      () => loadConfig({ cwd: CWD, env: { SOLVER_PROVIDER: "openai-codex" } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.match(error.message, /SOLVER_PROVIDER: unsupported provider/)
        return true
      },
    )
  })
})

describe("model identity (V3)", () => {
  it("accepts both documented model ids", () => {
    assert.equal(loadConfig({ cwd: CWD }).config.modelId, DEFAULT_MODEL_ID)
    assert.equal(
      loadConfig({ cwd: CWD, env: { SOLVER_MODEL: KIMI_K3_MODEL_ID } }).config.modelId,
      KIMI_K3_MODEL_ID,
    )
  })

  it("rejects a model id containing whitespace", () => {
    assert.throws(
      () => loadConfig({ cwd: CWD, cli: { modelId: "hf:deepseek ai/model" } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.match(error.message, /modelId: model id must be a single token/)
        return true
      },
    )
  })
})

describe("endpoint validation (V4)", () => {
  it("strips trailing path slashes", () => {
    const { config } = loadConfig({
      cwd: CWD,
      env: { SOLVER_BASE_URL: "https://api.synthetic.new/openai/v1///" },
    })
    assert.equal(config.baseUrl, "https://api.synthetic.new/openai/v1")
  })

  it("allows plain http only on loopback", () => {
    for (const url of ["http://127.0.0.1:8080/v1", "http://localhost:3000", "http://[::1]:4000/v1"]) {
      assert.equal(loadConfig({ cwd: CWD, cli: { baseUrl: url } }).config.baseUrl, url)
    }
  })

  it("rejects http off loopback and every URL escape", () => {
    const rejected = [
      "http://api.synthetic.new/v1",
      "http://localhost.evil.com/v1",
      "https://user:pass@api.synthetic.new/v1",
      "https://api.synthetic.new/v1?key=1",
      "https://api.synthetic.new/v1#frag",
      "https://api.synthetic.new\\v1",
      "ftp://api.synthetic.new/v1",
      "not-a-url",
    ]
    for (const url of rejected) {
      assert.throws(() => loadConfig({ cwd: CWD, cli: { baseUrl: url } }), ConfigError, url)
    }
  })
})

describe("arbitration (V8)", () => {
  it("defaults off and accepts probe from env and flag", () => {
    assert.equal(loadConfig({ cwd: CWD }).config.arbitration, "off")
    assert.equal(
      loadConfig({ cwd: CWD, env: { HARNESS2_ARBITRATION: "probe" } }).config.arbitration,
      "probe",
    )
    assert.equal(loadConfig({ cwd: CWD, cli: { arbitration: "probe" } }).config.arbitration, "probe")
  })

  it("rejects an unknown arbitration mode", () => {
    assert.throws(
      () => loadConfig({ cwd: CWD, cli: { arbitration: "on" } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.match(error.message, /--arbitration: expected one of off \| probe/)
        return true
      },
    )
  })
})

describe("generic validation", () => {
  it("names the offending source for a bad integer", () => {
    assert.throws(
      () => loadConfig({ cwd: CWD, env: { HARNESS2_K: "abc" } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.match(error.message, /HARNESS2_K: expected an integer, received "abc"/)
        return true
      },
    )
    assert.throws(
      () => loadConfig({ cwd: CWD, cli: { k: "1.5" } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.match(error.message, /--k: expected an integer/)
        return true
      },
    )
  })

  it("rejects an unknown mode with the accepted set", () => {
    assert.throws(
      () => loadConfig({ cwd: CWD, cli: { mode: "agg" } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.match(error.message, /expected one of parallel \| sequential/)
        return true
      },
    )
  })

  it("rejects an out-of-order T4 budget", () => {
    assert.throws(
      () => loadConfig({ cwd: CWD, cli: { b1Tokens: 200_000, b2Tokens: 100_000 } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.match(error.message, /b2Tokens/)
        return true
      },
    )
  })
})

describe("credential precedence (V5)", () => {
  const all = { SYNTHETIC_API_KEY: "sk-syn", SOLVER_API_KEY: "sk-sol", OPENAI_API_KEY: "sk-openai" }

  it("follows SYNTHETIC, then SOLVER, then OPENAI", () => {
    const synthetic = loadConfig({ cwd: CWD, env: all })
    assert.equal(synthetic.config.apiKey, "sk-syn")
    assert.equal(synthetic.apiKeySource, "SYNTHETIC_API_KEY")

    const solver = loadConfig({
      cwd: CWD,
      env: { SOLVER_API_KEY: "sk-sol", OPENAI_API_KEY: "sk-openai" },
    })
    assert.equal(solver.config.apiKey, "sk-sol")
    assert.equal(solver.apiKeySource, "SOLVER_API_KEY")

    const openai = loadConfig({ cwd: CWD, env: { OPENAI_API_KEY: "sk-openai" } })
    assert.equal(openai.config.apiKey, "sk-openai")
    assert.equal(openai.apiKeySource, "OPENAI_API_KEY")
  })

  it("lets an explicit flag win over every variable", () => {
    const { config, apiKeySource } = loadConfig({ cwd: CWD, env: all, cli: { apiKey: "sk-cli" } })
    assert.equal(config.apiKey, "sk-cli")
    assert.equal(apiKeySource, "--api-key")
  })

  it("treats an empty variable as unset and falls through the chain", () => {
    const { config, apiKeySource } = loadConfig({
      cwd: CWD,
      env: { SYNTHETIC_API_KEY: "", OPENAI_API_KEY: "sk-openai" },
    })
    assert.equal(config.apiKey, "sk-openai")
    assert.equal(apiKeySource, "OPENAI_API_KEY")
  })

  it("treats a whitespace-only variable as unset too", () => {
    const { config, apiKeySource } = loadConfig({
      cwd: CWD,
      env: { SYNTHETIC_API_KEY: "   ", SOLVER_API_KEY: "sk-sol" },
    })
    assert.equal(config.apiKey, "sk-sol", "a blank variable must not fail coercion")
    assert.equal(apiKeySource, "SOLVER_API_KEY", "provenance must agree with the value used")
  })

  it("publishes the chain it reads", () => {
    assert.deepEqual([...API_KEY_ENV_CHAIN], [
      "SYNTHETIC_API_KEY",
      "SOLVER_API_KEY",
      "OPENAI_API_KEY",
    ])
  })
})

describe("disagreeing credentials (V6)", () => {
  it("warns and names the sources without leaking either value", () => {
    const { warnings } = loadConfig({
      cwd: CWD,
      env: { SYNTHETIC_API_KEY: "sk-first-secret", OPENAI_API_KEY: "sk-second-secret" },
    })
    const text = warnings[0] ?? ""
    assert.equal(warnings.length, 1)
    assert.match(text, /SYNTHETIC_API_KEY, OPENAI_API_KEY/)
    assert.match(text, /SYNTHETIC_API_KEY wins/)
    assert.ok(!text.includes("sk-first-secret") && !text.includes("sk-second-secret"))
  })

  it("stays quiet when the variables agree", () => {
    const { warnings } = loadConfig({
      cwd: CWD,
      env: { SYNTHETIC_API_KEY: "same", OPENAI_API_KEY: "same" },
    })
    assert.deepEqual(warnings, [])
  })

  it("stays quiet when an explicit flag overrides them", () => {
    const { warnings } = loadConfig({
      cwd: CWD,
      env: { SYNTHETIC_API_KEY: "sk-first-secret", OPENAI_API_KEY: "sk-second-secret" },
      cli: { apiKey: "sk-cli-secret" },
    })
    assert.deepEqual(warnings, [])
  })
})

describe("secret handling (V7)", () => {
  const secrets = ["sk-syn-1111", "sk-sol-2222", "sk-openai-3333", "sk-cli-4444"] as const

  it("keeps the winning secret usable on the resolved config", () => {
    const { config } = loadConfig({ cwd: CWD, cli: { apiKey: secrets[3] } })
    assert.equal(config.apiKey, secrets[3])
  })

  it("redacts a secret that leaks into a failure message", () => {
    const secret = "sk-test-do-not-log-123"
    assert.throws(
      () => loadConfig({ cwd: CWD, cli: { apiKey: secret, k: secret } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.ok(!error.message.includes(secret), `secret leaked: ${error.message}`)
        assert.match(error.message, /<redacted>/)
        return true
      },
    )
  })

  it("redacts every source, including the variables that lost", () => {
    const env = {
      SYNTHETIC_API_KEY: secrets[0],
      SOLVER_API_KEY: secrets[1],
      OPENAI_API_KEY: secrets[2],
    }
    assert.throws(
      // `k` carries the SOLVER key, which loses precedence — it must still be redacted.
      () => loadConfig({ cwd: CWD, env, cli: { apiKey: secrets[3], k: secrets[1] } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        for (const secret of secrets) {
          assert.ok(!error.message.includes(secret), `leaked ${secret}: ${error.message}`)
        }
        assert.match(error.message, /<redacted>/)
        return true
      },
    )
  })

  it("does not let a placeholder credential mangle an unrelated message", () => {
    // Shells commonly carry `OPENAI_API_KEY=1`. Redacting "1" everywhere would turn
    // `b1Tokens` into `b<redacted>Tokens` and hide the actual error.
    assert.throws(
      () => loadConfig({ cwd: CWD, env: { OPENAI_API_KEY: "1", HARNESS2_K: "1.5" } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.match(error.message, /received "1\.5"/)
        return true
      },
    )
  })

  it("redact() replaces every occurrence and ignores empties", () => {
    assert.equal(redact("a s b s", ["s"]), "a <redacted> b <redacted>")
    assert.equal(redact("unchanged", [""]), "unchanged")
  })

  it("redacts a secret that coercion trimmed before reporting it", () => {
    const secret = "  sk-padded-do-not-log-456  "
    assert.throws(
      () => loadConfig({ cwd: CWD, cli: { apiKey: secret, k: secret } }),
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
      () => loadConfig({ cwd: CWD, cli: { apiKey: secret, k: secret } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.ok(!error.message.includes("quoted"), `escaped secret leaked: ${error.message}`)
        return true
      },
    )
  })
})

describe("retired environment variables", () => {
  it("fails and names the replacement for each retired name", () => {
    for (const [old, replacement] of Object.entries(RETIRED_ENV)) {
      assert.throws(
        () => loadConfig({ cwd: CWD, env: { [old]: "value" } }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError)
          assert.match(error.message, /retired environment variables/)
          assert.match(error.message, new RegExp(old))
          assert.match(error.message, new RegExp(replacement))
          return true
        },
        old,
      )
    }
  })

  it("fails even when the replacement variable is also set", () => {
    assert.throws(
      () => loadConfig({ cwd: CWD, env: { HARNESS2_MODEL: "old", SOLVER_MODEL: KIMI_K3_MODEL_ID } }),
      ConfigError,
    )
  })

  it("ignores a retired name that is present but empty", () => {
    assert.equal(loadConfig({ cwd: CWD, env: { HARNESS2_MODEL: "" } }).config.modelId, DEFAULT_MODEL_ID)
  })

  it("ignores a retired name that is only whitespace", () => {
    assert.equal(
      loadConfig({ cwd: CWD, env: { HARNESS2_MODEL: "   " } }).config.modelId,
      DEFAULT_MODEL_ID,
    )
  })
})
