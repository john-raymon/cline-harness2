import { main } from "./cli.ts"

/**
 * Process entry point.
 *
 * Deliberately four lines: `main` is the whole CLI and it is importable without touching `process`, so a
 * test can drive it with its own argv, its own io and its own working directory. Nothing that runs the
 * harness lives in a module-loading side effect.
 */
process.exitCode = await main(process.argv.slice(2))
