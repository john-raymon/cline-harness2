#!/usr/bin/env node
// `harness2-mcp` — the stdio MCP server your Cline session talks to.
//
// Same shape as the CLI shim: tsx's ESM hook refuses `module.register` and wants `--import tsx`, which can
// only be given on a command line, so the entry is re-exec'd rather than imported. Keeping the transport in
// a separate process also means a run that hangs cannot wedge the MCP stream.
//
// That separation has a cost: a signal sent to *this* process does not reach the child, so restarting or
// cancelling the server in Cline left an in-flight `harness2_run` looping in the background — it kept
// writing ledger events and per-execution trees after the client had already given up. Every stop path
// therefore forwards to the child, and a child that will not stop is killed rather than orphaned.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** How long a SIGTERMed child gets to unwind before it is killed outright. */
const KILL_GRACE_MS = 5_000;

const tsx = import.meta.resolve("tsx");
const entry = fileURLToPath(new URL("../src/mcp/main.ts", import.meta.url));
const child = spawn(process.execPath, ["--import", tsx, entry], { stdio: "inherit" });

/** @type {NodeJS.Timeout | undefined} */
let escalation;

function childGone() {
  return child.exitCode !== null || child.signalCode !== null;
}

function stopChild() {
  if (childGone()) return;
  child.kill("SIGTERM");
  // A child stuck in a syscall can ignore SIGTERM; the escalation keeps the promise that nothing outlives
  // its parent. Not `unref`'d: it is the only thing keeping this process alive while the child drains.
  if (escalation === undefined) {
    escalation = setTimeout(() => {
      if (!childGone()) child.kill("SIGKILL");
    }, KILL_GRACE_MS);
  }
}

child.on("error", (error) => {
  process.stderr.write(`harness2-mcp: could not start: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (escalation !== undefined) {
    clearTimeout(escalation);
    escalation = undefined;
  }
  process.exitCode = signal === null ? (code ?? 1) : 1;
});

// The handler deliberately does not exit: the child's `exit` listener sets the code, and exiting here would
// cancel the escalation timer and orphan a child that ignored the first signal.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    stopChild();
  });
}
process.on("exit", () => {
  stopChild();
});

