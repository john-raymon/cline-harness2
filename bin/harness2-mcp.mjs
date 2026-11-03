#!/usr/bin/env node
// `harness2-mcp` — the stdio MCP server your Cline session talks to.
//
// Same shape as the CLI shim: tsx's ESM hook refuses `module.register` and wants `--import tsx`, which can
// only be given on a command line, so the entry is re-exec'd rather than imported. Keeping the transport in
// a separate process also means a run that hangs cannot wedge the MCP stream.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const tsx = import.meta.resolve("tsx");
const entry = fileURLToPath(new URL("../src/mcp/main.ts", import.meta.url));
const child = spawn(process.execPath, ["--import", tsx, entry], { stdio: "inherit" });

child.on("error", (error) => {
  process.stderr.write(`harness2-mcp: could not start: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = signal === null ? (code ?? 1) : 1;
});
