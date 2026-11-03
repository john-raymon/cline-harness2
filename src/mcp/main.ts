import { createInterface } from "node:readline"

import { handleRequest, type JsonRpcRequest } from "./server.ts"

/**
 * The stdio transport.
 *
 * One JSON object per line in, one per line out. A malformed line is answered with a parse error and does not
 * end the server: a client that sends one bad frame should not have to restart the process to recover, and a
 * session that loses its tools mid-task cannot finish.
 */
const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })

lines.on("line", (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return

  void (async () => {
    let request: JsonRpcRequest
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`,
      )
      return
    }

    try {
      const response = await handleRequest(request)
      if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: { code: -32603, message },
        })}\n`,
      )
    }
  })()
})
