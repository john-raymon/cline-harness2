#!/usr/bin/env node
/**
 * End-to-end verification (PLAN row 21).
 *
 * Two modes, because "one honest end-to-end result" needs both halves:
 *
 * - **default** — the whole wiring against *this* repository: a real capture, a real ledger, a real tree
 *   on disk, real budget arithmetic. The SDK and the oracles are scripted, so this runs on a fresh clone
 *   with no keys and no network. What it proves is the part that is actually new in this chunk: the ports
 *   line up and the loop stops where it says it stops.
 * - **`HARNESS2_LIVE_ORACLE=on`** — the same run with the real SDK and the real oracle CLIs. This is the
 *   only honest way to claim a model was involved, so the script refuses to report a live result it did
 *   not get.
 *
 * A run that cannot complete exits non-zero and prints why. Silence is never success.
 */
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { captureBaseline } from "../src/baseline/capture.ts"
import { loadConfig } from "../src/config.ts"
import { readLedgerFile } from "../src/ledger/ledger.ts"
import { runHarness, type RunHarnessDeps } from "../src/run/harness.ts"
import type { SdkSlice } from "../src/adapter/session.ts"
import type { OracleClients } from "../src/oracle/client.ts"
import {
  DEFAULT_FIXTURE_CLAIMS,
  FIXTURE_SDK_VERSION,
  writeEvidence,
} from "../test/support/evidence-fixture.ts"
import { astraClient, geminiAnswer, geminiClient, scripted } from "../test/support/oracle-fixtures.ts"

const TASK = "summarise what this repository does in one sentence"
const live = process.env.HARNESS2_LIVE_ORACLE === "on"

function scriptedSdk(): () => Promise<SdkSlice> {
  return async () => ({
    ClineCore: {
      async create(): Promise<unknown> {
        return {
          async start(): Promise<unknown> {
            return {
              sessionId: "verify-session",
              result: { text: "a harness that improves itself", iterations: 1, finishReason: "stop" },
            }
          },
          subscribe: (): (() => void) => () => undefined,
          async abort(): Promise<void> {},
          async dispose(): Promise<void> {},
        }
      },
    },
  })
}

/**
 * A proposal that edits a file the capture actually produced.
 *
 * Adding a path would change what the baseline manifest describes, and the loop rejects that by design, so a
 * verification script that added files would only ever verify the rejection path. Each reply supplies a
 * different body: an identical one would be refused as `PROPOSAL_EMPTY`, which is the improver being right.
 */
function proposal(file: string, rule: string): string {
  const body = `state each rule once\n${rule}\n`
  return [`<<<proposal:${file}>>>`, body, `<<<end proposal:${file}>>>`].join("\n")
}

function scriptedOracles(target: string): OracleClients {
  // Call order: improver after each execution, and the Selector comparing the harness it produced against the
  // one it replaced on the next execution. The selector keeps each improvement (`CHOICE: exec-<n>`), so the
  // run is expected to complete on budget with every edit retained.
  const script = scripted([
    geminiAnswer(proposal(target, "cite the file a rule applies to")),
    geminiAnswer("CHOICE: exec-2"),
    geminiAnswer(proposal(target, "keep the patch small")),
    geminiAnswer("CHOICE: exec-3"),
    geminiAnswer(proposal(target, "state the evidence for each rule")),
    geminiAnswer("CHOICE: exec-4"),
  ])
  return { gemini: geminiClient(script), astra: astraClient(script) }
}

async function main(): Promise<number> {
  const cwd = process.cwd()
  // In scripted mode the session never calls a provider, but it does require a key *source* to exist. The
  // script supplies one under the real variable name rather than claiming provenance it does not have.
  const env = live ? process.env : { ...process.env, SOLVER_API_KEY: "scripted-key-never-sent" }
  const loaded = loadConfig({ env, cwd })
  const root = await mkdtemp(path.join(tmpdir(), "harness2-verify-"))
  const evidencePath = await writeEvidence(
    path.join(root, "spike-evidence.json"),
    FIXTURE_SDK_VERSION,
    DEFAULT_FIXTURE_CLAIMS,
  )

  // The capture decides what may be improved, so it runs here too: the script has to name a real path.
  const ssotRoot = path.join(path.dirname(cwd), "cline-config")
  const captured = await captureBaseline({ repoDir: cwd, ssotRoot })
  const paths = Object.keys(captured.tree).sort()
  const target = paths.find((candidate) => candidate.startsWith(".clinerules/")) ?? paths[0]
  if (target === undefined) {
    console.error("verify-e2e: the capture produced no harness files, so there is nothing to improve")
    return 1
  }
  console.log(`capture:     ${paths.length} file(s), improving ${target}`)

  const deps: RunHarnessDeps = live
    ? { evidencePath, ...(loaded.config.apiKey === undefined ? {} : {}) }
    : {
        loadSdk: scriptedSdk(),
        oracles: scriptedOracles(target),
        installedSdkVersion: FIXTURE_SDK_VERSION,
        evidencePath,
        grade: () => "pass",
      }

  console.log(`verify-e2e: ${live ? "live" : "scripted"} mode, repo ${cwd}`)
  const result = await runHarness({
    config: { ...loaded.config, root },
    repo: cwd,
    task: TASK,
    apiKeySource: loaded.apiKeySource,
    runId: `verify-${live ? "live" : "scripted"}`,
    report: (line) => console.log(`  ${line}`),
    deps,
  })

  const events = await readLedgerFile(result.ledgerPath)
  const kinds = new Map<string, number>()
  for (const event of events) kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1)

  console.log(`\noutcome:     ${result.outcome} (${result.reason})`)
  console.log(`executions:  ${result.executions}`)
  console.log(`improvements: ${result.improvements}`)
  console.log(`lessons:     ${result.lessons}`)
  console.log(`ledger:      ${result.ledgerPath} (${events.length} events)`)
  console.log(`kinds:       ${[...kinds].map(([kind, count]) => `${kind}x${count}`).join(", ")}`)

  if (result.outcome !== "completed") {
    console.error(`\nverify-e2e: the run did not complete: ${result.detail}`)
    return 1
  }
  const expected = loaded.config.k * 4
  if (result.executions !== expected) {
    console.error(`\nverify-e2e: expected ${expected} executions for k=${loaded.config.k}, got ${result.executions}`)
    return 1
  }
  console.log("\nverify-e2e: ok")
  return 0
}

process.exitCode = await main()
