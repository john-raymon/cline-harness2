import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import {
  handleRequest,
  RUN_TOOL_NAME,
  type JsonRpcResponse,
  type McpDeps,
} from "../src/mcp/server.ts"
import { FIXTURE_SDK_VERSION } from "./support/evidence-fixture.ts"
import { fakeCapture, fakeSdk, oraclesWith, proposalBlock, runRoot, TREE } from "./support/harness-fixture.ts"

/**
 * The MCP surface.
 *
 * The gate is "zero configuration": a Cline session sends a task and gets an improved harness back. So the
 * tests drive the protocol the way a client does — `initialize`, `tools/list`, `tools/call` — and assert that
 * a call carrying only `task` still resolves the recursion budget and every threshold from `config.ts`.
 */

async function call(
  id: number,
  method: string,
  params?: Record<string, unknown>,
  deps: McpDeps = {},
): Promise<JsonRpcResponse> {
  const response = await handleRequest(
    { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) },
    deps,
  )
  assert.ok(response !== undefined, `${method} must be answered`)
  return response
}

/** A run root with claim evidence, plus a repository to write back into. */
async function fixture(): Promise<{ root: string; repo: string }> {
  const root = await runRoot()
  const repo = await mkdtemp(path.join(tmpdir(), "harness2-mcp-repo-"))
  return { root, repo }
}

function depsFor(root: string, replies: readonly string[]): McpDeps {
  return {
    // A session needs a key *source* even when the transport is scripted; the script supplies one under the
    // real variable name rather than claiming provenance it does not have.
    env: { SOLVER_API_KEY: "scripted-key-never-sent" },
    harness: {
      capture: fakeCapture(TREE),
      loadSdk: fakeSdk(),
      installedSdkVersion: FIXTURE_SDK_VERSION,
      evidencePath: path.join(root, "spike-evidence.json"),
      oracles: oraclesWith(replies),
    },
  }
}

interface ToolResult {
  readonly isError: boolean
  readonly structuredContent: Record<string, unknown>
}

async function callTool(id: number, args: Record<string, unknown>, deps: McpDeps): Promise<ToolResult> {
  const response = await call(id, "tools/call", { name: RUN_TOOL_NAME, arguments: args }, deps)
  return response.result as ToolResult
}

describe("handleRequest", () => {
  it("answers initialize, lists one tool, and never answers a notification", async () => {
    const init = await call(1, "initialize")
    assert.deepEqual(init.result, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "harness2", version: "1.0.0" },
    })

    const list = await call(2, "tools/list")
    const tools = (list.result as { tools: { name: string; inputSchema: { required: string[] } }[] }).tools
    assert.equal(tools.length, 1)
    assert.equal(tools[0]?.name, RUN_TOOL_NAME)
    assert.deepEqual(
      tools[0]?.inputSchema.required,
      ["task", "repo"],
      "a run needs a task and the absolute path of the workspace it is meant to improve",
    )

    assert.equal(await handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined)
  })

  it("reports an unknown method and an unknown tool as protocol errors", async () => {
    const missing = await call(3, "prompts/list")
    assert.equal(missing.error?.code, -32601)

    const unknownTool = await call(4, "tools/call", { name: "nope", arguments: {} })
    assert.equal(unknownTool.error?.code, -32602)
  })

  it("never answers a notification, whatever the method", async () => {
    for (const method of ["tools/list", "ping", "tools/call", "prompts/list"]) {
      assert.equal(
        await handleRequest({ jsonrpc: "2.0", method, params: {} }),
        undefined,
        `${method} without an id is a notification, and a reply would corrupt the client's stream`,
      )
    }
  })

  it("treats malformed params as a tool error rather than throwing", async () => {
    const nonObjectParams = await call(8, "tools/call", { name: RUN_TOOL_NAME, arguments: "not an object" })
    assert.equal(nonObjectParams.error?.code, -32602)

    const result = await callTool(9, {}, { env: {} })
    assert.equal(result.isError, true)
    assert.match(String(result.structuredContent.error), /task is required/)
  })

  it("rejects a call with no task as a tool error rather than a crash", async () => {
    const { repo } = await fixture()
    const result = await callTool(5, { repo, writeBack: false }, { env: {} })
    assert.equal(result.isError, true)
    assert.match(String(result.structuredContent.error), /task is required/)
  })

  it("refuses the shared config root as `repo`", async () => {
    let captures = 0
    const deps: McpDeps = {
      env: { SOLVER_API_KEY: "scripted-key-never-sent" },
      harness: {
        capture: async () => {
          captures += 1
          throw new Error("a run must not start in the config repository")
        },
      },
    }

    // In Multi-Root Mode Cline's cwd *is* `cline-config`, so this is the path a caller reaches for by accident.
    const result = await callTool(
      32,
      { task: "do the thing", repo: "/Users/johnraymon/Projects/cline-config" },
      deps,
    )
    assert.equal(result.isError, true)
    assert.match(String(result.structuredContent.error), /not the shared config root/)
    assert.match(String(result.structuredContent.error), /sibling project/)
    assert.equal(captures, 0, "the config repository is refused before any run starts")
  })

  it("rejects a missing, blank, relative or root repo before any run starts", async () => {
    let captures = 0
    const deps: McpDeps = {
      env: { SOLVER_API_KEY: "scripted-key-never-sent" },
      harness: {
        capture: async () => {
          captures += 1
          throw new Error("a run must not start when `repo` is unusable")
        },
      },
    }

    // `process.cwd()` is the directory the *server* was launched from, not the workspace the agent is
    // working in, so there is no honest fallback: every unusable `repo` is refused with a way to recover.
    for (const repo of [undefined, "", "   ", "relative/repo", "."]) {
      const args: Record<string, unknown> = { task: "do the thing" }
      if (repo !== undefined) args.repo = repo
      const result = await callTool(30, args, deps)
      assert.equal(result.isError, true, `repo ${JSON.stringify(repo)} must be rejected`)
      assert.match(
        String(result.structuredContent.error),
        /retry the call and pass the active workspace's absolute path/,
        "the caller is told how to recover",
      )
    }

    const root = await callTool(31, { task: "do the thing", repo: "/" }, deps)
    assert.equal(root.isError, true)
    assert.match(String(root.structuredContent.error), /filesystem root/)

    assert.equal(captures, 0, "validation happens before the loop, so no run is started")
  })
})

describe("harness2_run", () => {
  it("runs from `task` and `repo` alone and writes the improved harness back", async () => {
    const { root, repo } = await fixture()
    // Call order: improver (after exec-1), selector (after exec-2), improver (refuses, so the run halts).
    const deps = depsFor(root, [
      proposalBlock(".clinerules/core.md", "prefer small, cited edits\napply the requested edit\n"),
      "CHOICE: exec-2",
      "I have no further proposal.",
    ])

    const result = await callTool(6, { task: "add a rule about citations", repo }, deps)

    assert.equal(result.isError, false)
    assert.equal(result.structuredContent.outcome, "halted")
    const counts = result.structuredContent.counts as { executions: number; acceptedImprovements: number }
    assert.equal(counts.executions, 2, "k defaulted to 1, and the second cycle produced nothing")
    assert.equal(counts.acceptedImprovements, 1)
    assert.deepEqual(result.structuredContent.improvedFiles, [
      { path: ".clinerules/core.md", kind: "created" },
    ])
    assert.equal(
      await readFile(path.join(repo, ".clinerules/core.md"), "utf8"),
      "prefer small, cited edits\napply the requested edit\n",
      "the improved rule is in the repository, which is the whole point of the tool",
    )
  })

  it("leaves the repository untouched when writeBack is false", async () => {
    const { root, repo } = await fixture()
    const result = await callTool(7, { task: "do the thing", repo, writeBack: false }, depsFor(root, ["no proposal here"]))

    assert.equal((result.structuredContent.counts as { executions: number }).executions, 1)
    assert.deepEqual(result.structuredContent.improvedFiles, [])
    await assert.rejects(readFile(path.join(repo, ".clinerules/core.md"), "utf8"), /ENOENT/)
  })
})
