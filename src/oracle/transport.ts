import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { OracleProvider } from "../config.ts"
import { OracleError } from "./errors.ts"

/**
 * How an oracle is actually reached.
 *
 * The transport is the only part of the oracle layer that leaves the process, and it is injected for
 * exactly that reason: the default suite must prove every role's wiring without a network, a
 * credential or a subprocess. The two shipped transports shell out to the CLIs this project already
 * authenticates (`gemini-api`, `codex`) instead of re-implementing their HTTP clients, so a run uses
 * the same account the operator already checked and no key has to be copied anywhere.
 */

export interface OracleUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
}

export interface OracleTransportInput {
  readonly prompt: string
  readonly modelId: string
  readonly timeoutMs: number
}

export interface OracleTransportResult {
  readonly text: string
  readonly usage?: OracleUsage
}

export interface OracleTransport {
  readonly provider: OracleProvider
  /** Which CLI shape the arguments follow; recorded so a reply says how it was obtained. */
  readonly kind: string
  send(input: OracleTransportInput): Promise<OracleTransportResult>
}

export interface RunnerRequest {
  readonly command: string
  readonly args: readonly string[]
  readonly stdin: string
  readonly timeoutMs: number
  readonly env: Readonly<Record<string, string | undefined>>
}

export interface RunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** The seam the default suite replaces. A real call and a scripted one differ only here. */
export type Runner = (request: RunnerRequest) => Promise<RunResult>

/** A chat reply is text, not a log: 1 MiB is already three orders of magnitude past a harness patch. */
const MAX_CAPTURED_BYTES = 1 << 20


/**
 * Run a CLI, capturing its output.
 *
 * `spawn` rather than `exec` so the prompt goes through stdin instead of an argv string: a rendered
 * context can be megabytes, and argv has a hard `ARG_MAX` that would fail with `E2BIG` on a big
 * harness. Timeout is a kill, not a promise race — a race leaves the child running.
 */
export const spawnRunner: Runner = async (request) => {
  return new Promise<RunResult>((resolve, reject) => {
    let child
    try {
      child = spawn(request.command, [...request.args], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...request.env },
      })
    } catch (cause) {
      reject(
        new OracleError("CLI_NOT_FOUND", `could not start ${request.command}: ${String(cause)}`, {
          cause,
        }),
      )
      return
    }

    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let settled = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, request.timeoutMs)

    const finish = (result: RunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const fail = (error: OracleError): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }

    child.on("error", (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") {
        fail(
          new OracleError(
            "CLI_NOT_FOUND",
            `${request.command} was not found on PATH; install it or use a different transport`,
            { cause },
          ),
        )
        return
      }
      fail(
        new OracleError("TRANSPORT_FAILED", `${request.command} failed to start: ${cause.message}`, {
          cause,
        }),
      )
    })

    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length
      if (outBytes > MAX_CAPTURED_BYTES) {
        child.kill("SIGKILL")
        fail(
          new OracleError(
            "TRANSPORT_FAILED",
            `${request.command} wrote more than ${MAX_CAPTURED_BYTES} bytes to stdout`,
          ),
        )
        return
      }
      out.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      errBytes += chunk.length
      // stderr is diagnostics quoted in failures, so it is capped but never fatal.
      if (errBytes <= MAX_CAPTURED_BYTES) err.push(chunk)
    })

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) {
        fail(
          new OracleError(
            "TRANSPORT_TIMEOUT",
            `${request.command} did not answer within ${request.timeoutMs}ms and was killed`,
          ),
        )
        return
      }
      // A signalled child has no exit code. Reporting `1` for it would blame the CLI for something the
      // OOM killer or an operator's Ctrl-C did.
      if (code === null) {
        fail(
          new OracleError(
            "TRANSPORT_FAILED",
            `${request.command} was terminated by signal ${signal ?? "unknown"} before it exited`,
          ),
        )
        return
      }
      finish({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      })
    })

    // A prompt the child stops reading must not surface as an unhandled `EPIPE`.
    child.stdin.on("error", () => undefined)
    child.stdin.end(request.stdin)
  })
}

/**
 * Parse a payload that may be one object or an NDJSON stream.
 *
 * `gemini-api --output-format json` documents one object, but a stream cut short or a build that
 * appends a summary line would make a strict `JSON.parse` fail for a reason that has nothing to do
 * with this module. Falling back to the last parseable line keeps "unparseable" meaning what it says.
 */
function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    throw new OracleError("REPLY_UNPARSEABLE", "the CLI wrote nothing to stdout")
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    // Not one document; try the last line that parses.
  }
  const lines = trimmed.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line === undefined) continue
    try {
      return JSON.parse(line)
    } catch {
      continue
    }
  }
  throw new OracleError(
    "REPLY_UNPARSEABLE",
    `could not parse the CLI output as JSON; first 400 bytes: ${JSON.stringify(excerpt(trimmed))}`,
  )
}

/** The text of every `model_output` step, in order. Thought steps are not part of the answer. */
function geminiText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    throw new OracleError("REPLY_UNPARSEABLE", "gemini reply was not an object")
  }
  const steps = (payload as { steps?: unknown }).steps
  if (!Array.isArray(steps)) {
    throw new OracleError("REPLY_UNPARSEABLE", "gemini reply had no steps array")
  }
  const parts: string[] = []
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue
    if ((step as { type?: unknown }).type !== "model_output") continue
    const content = (step as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue
      const text = (block as { text?: unknown }).text
      if (typeof text === "string") parts.push(text)
    }
  }
  return parts.join("")
}

function geminiUsage(payload: unknown): OracleUsage | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const usage = (payload as { usage?: unknown }).usage
  if (typeof usage !== "object" || usage === null) return undefined
  const input = (usage as { total_input_tokens?: unknown }).total_input_tokens
  const output = (usage as { total_output_tokens?: unknown }).total_output_tokens
  const result: OracleUsage = {
    ...(typeof input === "number" ? { inputTokens: input } : {}),
    ...(typeof output === "number" ? { outputTokens: output } : {}),
  }
  return Object.keys(result).length > 0 ? result : undefined
}

export interface GeminiCliOptions {
  readonly runner?: Runner
  readonly command?: string
  /** Extra environment for the child. A configured key reaches the CLI here, never through argv. */
  readonly env?: Readonly<Record<string, string>>
}

export function geminiCliTransport(options: GeminiCliOptions = {}): OracleTransport {
  const runner = options.runner ?? spawnRunner
  const command = options.command ?? "gemini-api"
  return {
    provider: "gemini",
    kind: "gemini-cli",
    async send(input: OracleTransportInput): Promise<OracleTransportResult> {
      const result = await runner({
        command,
        // `--stdin` is what lets the prompt travel through a pipe instead of argv.
        args: [
          "generate",
          "--stdin",
          "--stream=false",
          "--output-format",
          "json",
          "--model",
          input.modelId,
        ],
        stdin: input.prompt,
        timeoutMs: input.timeoutMs,
        env: options.env ?? {},
      })
      if (result.code !== 0) {
        throw new OracleError(
          "TRANSPORT_FAILED",
          `${command} exited ${result.code}: ${excerpt(result.stderr) || "(no stderr)"}`,
        )
      }
      const payload = parseJsonLoose(result.stdout)
      const text = geminiText(payload).trim()
      if (text.length === 0) {
        throw new OracleError(
          "REPLY_EMPTY",
          `${command} returned no model_output text; the reply is not an answer`,
        )
      }
      const usage = geminiUsage(payload)
      return usage === undefined ? { text } : { text, usage }
    },
  }
}

export interface CodexCliOptions {
  readonly runner?: Runner
  readonly command?: string
  readonly env?: Readonly<Record<string, string>>
  /** Where the last-message file is written. Defaults to a fresh temp dir per call. */
  readonly scratchDir?: () => Promise<string>
}

export function codexCliTransport(options: CodexCliOptions = {}): OracleTransport {
  const runner = options.runner ?? spawnRunner
  const command = options.command ?? "codex"
  const scratchDir =
    options.scratchDir ?? (() => mkdtemp(path.join(os.tmpdir(), "harness2-oracle-")))

  return {
    provider: "astra",
    kind: "codex-cli",
    async send(input: OracleTransportInput): Promise<OracleTransportResult> {
      const dir = await scratchDir()
      const lastMessage = path.join(dir, "last-message.txt")
      try {
        const result = await runner({
          command,
          // `-o` writes the final message to a file, so the reply is not mixed with the session
          // preamble and the token report `codex exec` prints to stdout.
          args: [
            "exec",
            // The model has to be named explicitly: without `-m`, codex runs whatever its own config
            // says, and the reply would be recorded against a model that was never asked for.
            "-m",
            input.modelId,
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--ephemeral",
            "--color",
            "never",
            "-o",
            lastMessage,
            "-",
          ],
          stdin: input.prompt,
          timeoutMs: input.timeoutMs,
          env: options.env ?? {},
        })
        if (result.code !== 0) {
          throw new OracleError(
            "TRANSPORT_FAILED",
            `${command} exited ${result.code}: ${excerpt(result.stderr) || "(no stderr)"}`,
          )
        }
        let text: string
        try {
          text = (await readFile(lastMessage, "utf8")).trim()
        } catch (cause) {
          throw new OracleError(
            "REPLY_UNPARSEABLE",
            `${command} exited 0 but wrote no last message; there is no reply to record`,
            { cause },
          )
        }
        if (text.length === 0) {
          throw new OracleError("REPLY_EMPTY", `${command} wrote an empty last message`)
        }
        return { text }
      } finally {
        // The scratch directory holds one reply; leaving it behind would leak a file per call.
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}

/** stderr is quoted in failures; a whole session log is not evidence, 400 bytes of it is. */
function excerpt(text: string, limit = 400): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`
}
