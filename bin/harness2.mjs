#!/usr/bin/env node
// `harness2` entry point.
//
// A separate process rather than an in-process loader: tsx's ESM hook refuses `module.register` and
// wants `--import tsx`, which can only be given on the command line. Re-execing keeps the loader
// configuration identical to the one `pnpm test` uses, so the CLI runs the same code the suite does.
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const entry = fileURLToPath(new URL("../src/cli-main.ts", import.meta.url))
const child = spawn(process.execPath, ["--import", "tsx", entry, ...process.argv.slice(2)], {
  stdio: "inherit",
})

child.on("error", (error) => {
  process.stderr.write(`harness2: could not start: ${error.message}\n`)
  process.exitCode = 1
})
child.on("exit", (code, signal) => {
  process.exitCode = signal === null ? (code ?? 1) : 1
})
