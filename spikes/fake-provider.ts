import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

/**
 * An OpenAI-compatible model endpoint that answers from a script.
 *
 * The spike needs a *real* ClineCore session — hooks, plugins, builders and compaction only prove
 * anything inside the runtime — but it must not need a paid model or network access. Pointing
 * `providerId: "openai-compatible"` at `baseUrl` here gives the runtime a provider that speaks the
 * protocol it expects and returns exactly the tool calls the claim under test needs.
 *
 * Both transports matter: several SDKs default to `stream: true`, and a provider that only spoke
 * JSON would make every streaming claim fail for the wrong reason.
 */

export interface ScriptedToolCall {
  readonly id: string
  readonly name: string
  readonly args: unknown
}

export interface ScriptedTurn {
  readonly content?: string
  readonly toolCalls?: readonly ScriptedToolCall[]
}

export interface ChatRequest {
  readonly stream: boolean
  readonly model: string
  readonly body: Record<string, unknown>
}

export interface FakeProvider {
  readonly baseUrl: string
  readonly requests: ChatRequest[]
  close(): Promise<void>
}

export const SPIKE_MODEL_ID = "spike-model"

export async function startFakeProvider(turns: readonly ScriptedTurn[]): Promise<FakeProvider> {
  const queue = [...turns]
  const requests: ChatRequest[] = []

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/"
    if (req.method === "GET" && url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: SPIKE_MODEL_ID, object: "model", owned_by: "spike" }],
        }),
      )
      return
    }
    if (req.method !== "POST" || !url.includes("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: `unsupported route ${req.method} ${url}` } }))
      return
    }

    const raw = await readBody(req)
    let body: Record<string, unknown> = {}
    try {
      body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {}
    } catch {
      body = { __unparsed: raw }
    }
    const stream = body["stream"] === true
    requests.push({ stream, model: String(body["model"] ?? ""), body })

    const turn = queue.length > 1 ? queue.shift() : queue[0]
    const payload = buildCompletion(turn, String(body["model"] ?? SPIKE_MODEL_ID))

    if (!stream) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(payload.completion))
      return
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    for (const chunk of payload.chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    res.write("data: [DONE]\n\n")
    res.end()
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: { message: error instanceof Error ? error.message : String(error) },
        }),
      )
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => closeServer(server),
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

interface CompletionPayload {
  readonly completion: Record<string, unknown>
  readonly chunks: Record<string, unknown>[]
}

function buildCompletion(turn: ScriptedTurn | undefined, model: string): CompletionPayload {
  const content = turn?.content ?? ""
  const toolCalls = turn?.toolCalls ?? []
  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop"

  const message: Record<string, unknown> = { role: "assistant", content }
  if (toolCalls.length > 0) {
    message["tool_calls"] = toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
    }))
  }

  const completion = {
    id: "spike-completion",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }

  const chunk = (delta: Record<string, unknown>, finish: string | null): Record<string, unknown> => ({
    id: "spike-chunk",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })

  const chunks: Record<string, unknown>[] = [chunk({ role: "assistant" }, null)]
  if (content.length > 0) chunks.push(chunk({ content }, null))
  toolCalls.forEach((call, index) => {
    chunks.push(
      chunk(
        {
          tool_calls: [
            {
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
            },
          ],
        },
        null,
      ),
    )
  })
  const final = chunk({}, finishReason)
  final["usage"] = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  chunks.push(final)

  return { completion, chunks }
}

