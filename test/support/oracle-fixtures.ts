import { createOracleClient, type OracleClient } from "../../src/oracle/client.ts"
import { codexCliTransport, geminiCliTransport } from "../../src/oracle/transport.ts"
import { scriptedRunner, type ScriptedReply, type ScriptedRunner } from "./scripted-runner.ts"

/**
 * A paired oracle setup with the subprocess replaced.
 *
 * Arbitration is about two *providers*, so the fixture has to supply two clients that differ in the ways
 * that matter (provider id, model id, transport) while sharing one scripted runner — that way the order
 * of calls is observable and a second call in `off` mode fails loudly instead of passing unnoticed.
 */

export const CONTEXT = [{ path: "harness/rules.md", body: "prefer small patches" }]

export function scripted(replies: readonly ScriptedReply[]): ScriptedRunner {
  return scriptedRunner(replies)
}

/** A gemini reply in the shape `--output-format json` prints, trimmed to what the transport reads. */
export function geminiAnswer(text: string): ScriptedReply {
  return {
    stdout: JSON.stringify({
      status: "completed",
      steps: [{ type: "model_output", content: [{ text, type: "text" }] }],
    }),
  }
}

/** An astra reply: `codex exec -o` writes the answer to a file, never to stdout. */
export function astraAnswer(text: string): ScriptedReply {
  return { lastMessage: text }
}

export function geminiClient(script: ScriptedRunner): OracleClient {
  return createOracleClient({
    provider: "gemini",
    modelId: "gemini-4-argon",
    transport: geminiCliTransport({ runner: script.runner }),
    timeoutMs: 1_000,
  })
}

export function astraClient(script: ScriptedRunner): OracleClient {
  return createOracleClient({
    provider: "astra",
    modelId: "gpt-6-astra",
    transport: codexCliTransport({ runner: script.runner }),
    timeoutMs: 1_000,
  })
}
