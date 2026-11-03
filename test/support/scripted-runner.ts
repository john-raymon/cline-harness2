import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import type { RunResult, Runner, RunnerRequest } from "../../src/oracle/transport.ts"

/**
 * A runner that answers from a script.
 *
 * The oracle transports are the only code in this project that leaves the process, so the seam they
 * expose is what the default suite replaces. Everything above it — role contracts, raw-context
 * digests, argv, reply parsing, error mapping — is real code under test; only the subprocess is not.
 *
 * `codex exec -o <file>` writes its answer to a file rather than stdout, so a scripted reply may carry
 * `lastMessage` and the runner writes it to the `-o` path the transport chose. That keeps the file
 * path out of the test and lets the transport's own temp-dir handling run for real.
 */

export interface ScriptedReply {
  readonly code?: number
  readonly stdout?: string
  readonly stderr?: string
  /** Written to the `-o` path when the request has one. */
  readonly lastMessage?: string
}

export interface ScriptedRunner {
  readonly runner: Runner
  readonly requests: RunnerRequest[]
}

export function scriptedRunner(replies: readonly ScriptedReply[]): ScriptedRunner {
  const queue = [...replies]
  const requests: RunnerRequest[] = []

  const runner: Runner = async (request: RunnerRequest): Promise<RunResult> => {
    requests.push(request)
    const reply = queue.shift()
    if (reply === undefined) {
      throw new Error(`unscripted oracle call: ${request.command} ${request.args.join(" ")}`)
    }
    const at = request.args.indexOf("-o")
    const outPath = at >= 0 ? request.args[at + 1] : undefined
    if (reply.lastMessage !== undefined && outPath !== undefined) {
      await mkdir(path.dirname(outPath), { recursive: true })
      await writeFile(outPath, reply.lastMessage, "utf8")
    }
    return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" }
  }

  return { runner, requests }
}

/** The shape `gemini-api generate --output-format json` actually prints, trimmed to the fields read. */
export function geminiJson(
  text: string,
  usage: { readonly input?: number; readonly output?: number } = {},
): string {
  return JSON.stringify({
    status: "completed",
    object: "interaction",
    usage: {
      total_input_tokens: usage.input ?? 11,
      total_output_tokens: usage.output ?? 22,
    },
    steps: [
      { type: "thought", signature: "not-an-answer" },
      { type: "model_output", content: [{ text, type: "text" }] },
    ],
  })
}
