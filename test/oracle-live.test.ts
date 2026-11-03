import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { describe, it } from "node:test"

import { loadConfig, ORACLE_PROVIDERS } from "../src/config.ts"
import { createOracleClients } from "../src/oracle/client.ts"
import { ORACLE_ROLES } from "../src/oracle/roles.ts"

/**
 * The gate Chunk 14 owes: one real call per role.
 *
 * It is opt-in because `pnpm test` must stay hermetic — no network, no credentials, no quota. When it
 * does run it asserts the thing the gate is actually about: every role reaches a model *and* the model
 * saw the raw context. A nonce is planted in the context and has to come back in the answer, so a
 * call that answered from the role instruction alone (or from a summary) fails here. "A call
 * happened" is not evidence that the oracle read anything.
 *
 * `HARNESS2_LIVE_ORACLE=on` is read through `loadConfig`, not straight from `process.env`, so the
 * switch has the same validation and provenance as every other knob.
 */

const loaded = loadConfig({ env: process.env, cwd: process.cwd() })
const live = loaded.config.oracleLive === "on"

const SKIP = live
  ? false
  : "real oracle calls are opt-in — run `pnpm oracle:live` (HARNESS2_LIVE_ORACLE=on)"

const TIMEOUT_MS = Number(process.env["ORACLE_LIVE_TIMEOUT_MS"] ?? 240_000)

describe("live oracle gate", { skip: SKIP, timeout: TIMEOUT_MS }, () => {
  const clients = createOracleClients({ config: loaded.config, timeoutMs: TIMEOUT_MS })

  for (const provider of ORACLE_PROVIDERS) {
    for (const role of ORACLE_ROLES) {
      it(`${provider}: ${role} answers from the raw context it was given`, async () => {
        const nonce = `NONCE-${randomBytes(6).toString("hex")}`
        const reply = await clients[provider].ask({
          role,
          ask:
            `Connectivity check for the ${role} role. Read the context and reply with the single ` +
            "line \"NONCE: <the nonce you were given>\". Do not call tools.",
          context: [
            { path: "check/nonce.md", body: `The nonce for this check is ${nonce}.\n` },
            { path: "harness/rules.md", body: "# Rules\n- keep patches small\n" },
          ],
        })

        assert.equal(reply.provider, provider)
        assert.equal(reply.role, role)
        assert.ok(reply.text.trim().length > 0, "an empty reply is not an answer")
        assert.equal(reply.promptSha256.length, 64)
        assert.equal(reply.contextSha256.length, 64)
        assert.ok(
          reply.text.includes(nonce),
          `the reply must show the raw context arrived; got ${JSON.stringify(reply.text.slice(0, 400))}`,
        )
      })
    }
  }
})
