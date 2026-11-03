import path from "node:path"
import { createRequire } from "node:module"

import {
  bootstrapSession,
  type HarnessBaseline,
  type SdkLoader,
  type SessionBootstrapRecord,
} from "../adapter/session.ts"
import { captureBaseline, type BaselineCapture } from "../baseline/capture.ts"
import { baselineFingerprintSchema, baselineShaOf } from "../baseline/fingerprint.ts"
import { canonicalSha256 } from "../domain/canonical.ts"
import { compactContext, recordOverflowRecovery } from "../context/compact.ts"
import { detectContext, type ContextAssessment } from "../context/detector.ts"
import type { HarnessTree, RunConfig } from "../domain/schemas.ts"
import { materialiseTree } from "../harness/tree-store.ts"
import {
  addLesson,
  applyLessonLibrary,
  EMPTY_LIBRARY,
  LESSON_LIBRARY_PATH,
  type LessonLibrary,
} from "../improve/library.ts"
import { proposeImprovement } from "../improve/improver.ts"
import { reflect } from "../improve/reflector.ts"
import { RunLedger } from "../ledger/ledger.ts"
import type { ExecutionOutcome, RunOutcome } from "../ledger/events.ts"
import { buildToolInventory } from "../policy/inventory.ts"
import { compilePrompt } from "../prompt/compile.ts"
import { createOracleClients, oracleRoles, type OracleClients } from "../oracle/client.ts"
import { budgetOf, mayStartImprovement, stopDecision, type StopReason } from "./budget.ts"

/**
 * One run, end to end.
 *
 * The loop is the paper's: measure `e_k`, improve what the evidence supports, and stop on a named
 * condition. Every stage it calls already exists and is verified on its own; this file is the wiring, and
 * wiring is where a system starts making claims no part of it can support. Two rules keep that honest.
 *
 * **Nothing is injected that a test cannot replace.** Capture, the SDK loader, the oracles, the clock and
 * the grader are all ports, so the whole loop runs hermetically in `pnpm test` — the alternative is an
 * end-to-end test that needs a provider, which is an end-to-end test nobody runs.
 *
 * **Nothing is reported that did not happen.** The run's outcome comes from `stopDecision`, the counts come
 * from the ledger, and a stage that refuses is recorded as a refusal rather than as progress.
 */

/** What `main` hands the run; everything here has a default except the three things a run is about. */
export interface RunHarnessInput {
  readonly config: RunConfig
  /** Workspace being improved. */
  readonly repo: string
  readonly task: string
  /** Provenance of the solver key, never the key. Defaults to `"absent"`. */
  readonly apiKeySource?: "absent" | "--api-key" | (string & {})
  /** Root of the operator's rules SSOT. Absent or missing is tolerated by capture. */
  readonly ssotRoot?: string
  readonly runId?: string
  readonly signal?: AbortSignal
  readonly deps?: RunHarnessDeps
  /** Progress lines for the CLI. Absent means silent. */
  readonly report?: (line: string) => void
}

export interface RunHarnessDeps {
  readonly capture?: (input: { repoDir: string; ssotRoot: string }) => Promise<BaselineCapture>
  readonly loadSdk?: SdkLoader
  /** Oracle clients. Absent means no improvement stage: the run measures and stops. */
  readonly oracles?: OracleClients
  readonly installedSdkVersion?: string
  readonly now?: () => Date
  /**
   * Did this execution do the task?
   *
   * The default is deliberately weak and says so: a turn that produced text and did not error counts as a
   * pass. The harness has no grader, and inventing one here would make every improvement look justified.
   */
  readonly grade?: (record: SessionBootstrapRecord) => ExecutionOutcome
  /** Where the SDK claim evidence lives. Defaults to `<repo>/.tmp/spike-evidence.json`. */
  readonly evidencePath?: string
}

export interface RunHarnessResult {
  readonly runId: string
  readonly runDir: string
  readonly outcome: RunOutcome
  readonly reason: StopReason
  readonly detail: string
  readonly executions: number
  /** Finished improvement operations, as the ledger counts them: accepted, rejected and errored. */
  readonly improvements: number
  /** The subset that actually changed the harness. */
  readonly acceptedImprovements: number
  readonly lessons: number
  readonly ledgerPath: string
}

/** A turn with no text, or one the session ended on an error reason, is not a pass. */
export function defaultGrade(record: SessionBootstrapRecord): ExecutionOutcome {
  if (record.text.trim().length === 0) return "fail"
  const reason = (record.finishReason ?? "").toLowerCase()
  if (reason === "error" || reason === "abort" || reason === "aborted") return "fail"
  return "pass"
}

/** The `@cline/sdk` version actually installed. The claim gate compares it, so it is read, never assumed. */
function readInstalledSdkVersion(): string {
  const require = createRequire(import.meta.url)
  const pkg = require("@cline/sdk/package.json") as { version?: unknown }
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("@cline/sdk does not report a version; the claim gate cannot be evaluated")
  }
  return pkg.version
}

export async function runHarness(input: RunHarnessInput): Promise<RunHarnessResult> {
  const deps = input.deps ?? {}
  const now = deps.now ?? (() => new Date())
  const reporter = input.report ?? ((): void => undefined)
  const grade = deps.grade ?? defaultGrade
  const secrets = secretsOf(input.config)
  /** Progress lines are the other boundary: a task or a model output can quote a key too. */
  const say = (line: string): void => reporter(redactSecrets(line, secrets))
  const config = input.config

  if (input.task.trim().length === 0) {
    throw new Error("a run needs a task; an empty one can only produce a meaningless turn")
  }

  const runId = input.runId ?? `run-${now().getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const runDir = path.join(config.root, "runs", runId)
  const evidencePath = deps.evidencePath ?? path.join(input.repo, ".tmp", "spike-evidence.json")
  const installedSdkVersion = deps.installedSdkVersion ?? readInstalledSdkVersion()

  // 1. Freeze what is being improved. Everything downstream describes *this* capture; a tree read twice
  //    would let the prompt and the fingerprint disagree about which harness ran.
  const capture = deps.capture ?? captureBaseline
  const captured = await capture({
    repoDir: input.repo,
    ssotRoot: input.ssotRoot ?? path.join(path.dirname(input.repo), "cline-config"),
  })
  say(`captured ${Object.keys(captured.tree).length} files from ${input.repo} (${captured.baselineSha.slice(0, 12)})`)

  // 2. Lessons from earlier runs are part of the harness the first execution measures, not a thing added
  //    halfway through: an `e_0` that changes under the run would make every probe comparison meaningless.
  let library: LessonLibrary = EMPTY_LIBRARY
  let tree: HarnessTree = applyLessonLibrary(captured.tree, library)
  let baseline: HarnessBaseline = {
    tree,
    baselineSha: captured.baselineSha,
    fingerprint: captured.fingerprint,
  }
  let compiled = compilePrompt({ tree, task: input.task })
  // The run's policy is default-deny: nothing is permitted unless a caller installs a policy, and this
  // loop installs none. Recorded explicitly rather than as an empty list.
  const toolPolicySet = ["default:deny"]
  let inventoryHash = buildToolInventory(tree).hash

  const ledger = await RunLedger.open({ runDir, k: config.k, now })
  await ledger.append({
    kind: "run.started",
    runId,
    baselineSha: captured.baselineSha,
    probeSha: null,
    providerId: config.providerId,
    modelId: config.modelId,
    baseUrl: config.baseUrl,
    promptSha256: compiled.sha256,
    toolPolicySet,
    toolInventoryHash: inventoryHash,
    k: config.k,
  })

  const oracles = deps.oracles ?? createOracleClients({ config })
  const roles = oracleRoles(oracles.gemini)
  let improvements = 0
  let lessons = 0
  let lastImprovementAccepted: boolean | undefined
  let outcome: RunOutcome = "completed"
  let reason: StopReason = "executions-exhausted"
  let detail = ""

  try {
    for (;;) {
      const budget = budgetOf({
        k: config.k,
        executions: await finishedCount(ledger, "execution"),
        improvements: await finishedCount(ledger, "improvement"),
      })
      const decision = stopDecision({
        budget,
        ...(lastImprovementAccepted === undefined ? {} : { lastImprovementAccepted }),
      })
      if (decision.stop) {
        outcome = decision.outcome
        reason = decision.reason
        detail = decision.detail
        break
      }

      // --- execution ---------------------------------------------------------
      const executionId = `exec-${budget.executions + 1}`
      // One run owns one task, so the id is fixed: a prose task is not a legal ledger id.
      await ledger.append({ kind: "execution.started", executionId, taskId: "task-1" })
      say(`execution ${executionId}: ${config.modelId}`)

      let record: SessionBootstrapRecord
      try {
        record = await bootstrapSession({
          config,
          baseline,
          task: input.task,
          apiKeySource: (input.apiKeySource ?? "absent") as never,
          evidencePath,
          installedSdkVersion,
          runId: `${runId}-${executionId}`,
          ...(deps.loadSdk === undefined ? {} : { deps: { loadSdk: deps.loadSdk } }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await ledger.append({ kind: "execution.finished", executionId, outcome: "error" })
        outcome = "failed"
        reason = "error"
        detail = message
        break
      }

      const executionOutcome = grade(record)

      // T4 runs *before* the execution is closed. `recordOverflowRecovery` appends an attempt against this
      // execution, and replay refuses an attempt whose target is already finished — so closing first made
      // every real overflow unrecoverable, and the throw took the run down instead of recording it.
      const assessment = measureContext(config, compiled.systemPrompt, input.task, record)
      if (assessment.tier !== "ok") {
        const compaction = await compactContext({
          messages: conversationOf(input.task, record),
          thresholds: thresholdsOf(config),
          systemPrompt: compiled.systemPrompt,
        })
        say(`t4: ${assessment.tier} -> ${compaction.kind}`)
        if (compaction.kind === "refused" && compaction.residual > 0) {
          await recordOverflowRecovery({
            ledger,
            executionId,
            attemptId: `${executionId}-overflow`,
            residual: compaction.residual,
          })
        }
      }

      await ledger.append({ kind: "execution.finished", executionId, outcome: executionOutcome })
      say(`execution ${executionId}: ${executionOutcome}`)

      // A failure is the only thing worth reflecting on; a pass has no lesson to teach.
      const evidence = evidenceOf(executionId, record, executionOutcome).map((entry) => ({
      ...entry,
      body: redactSecrets(entry.body, secrets),
    }))
      if (executionOutcome !== "pass") {
        const reflection = await reflect({ reflector: roles.reflector, failures: evidence })
        if (reflection.status === "reflected") {
          const added = addLesson(library, reflection.lesson, { at: now().toISOString() })
          library = added.library
          if (added.outcome === "added") {
            lessons += 1
            // The lesson belongs to the harness from now on: the next execution must mount it, or the loop
            // measured a harness that never learned what it just filed.
            tree = applyLessonLibrary(tree, library)
            baseline = rebaseBaseline(baseline, tree)
            compiled = compilePrompt({ tree, task: input.task })
            say(`lesson filed (${reflection.lesson.confidence.level}): ${reflection.lesson.cue}`)
          }
        } else {
          say(`reflection refused: ${reflection.reason}`)
        }
      }

      // --- improvement -------------------------------------------------------
      // The Improver runs after every execution except the last of the round. That is what makes `4k`
      // executions and `3k` improvements describe *one* run instead of two counters racing: improving after
      // the final execution has no successor left to measure, and improving after every execution would make
      // `3k` bind first, so a `k=1` run would spend three of its four executions and stop early.
      if (budget.executions >= budget.maxExecutions || !mayStartImprovement(budget).ok) {
        say(`improvement skipped: ${budget.executions}/${budget.maxExecutions} executions, ${budget.improvements}/${budget.maxImprovements} improvements`)
        continue
      }

      let accepted = false
      const improvementId = `imp-${budget.improvements + 1}`
      // Opening the operation happens outside the `try`: if the append itself failed, the catch must not
      // close an improvement that was never opened, or the ledger refuses the closing event and the real
      // error is replaced by an invariant complaint.
      await ledger.append({ kind: "improvement.started", improvementId, stage: "improver" })
      try {
        const proposal = await proposeImprovement({
          improver: roles.improver,
          tree,
          evidence,
        })

        const foreign = proposal.status === "proposed" ? outsideCaptured(proposal.tree, tree) : []
        if (proposal.status === "proposed" && proposal.changed.length > 0 && foreign.length === 0) {
          tree = applyLessonLibrary(proposal.tree, library)
          baseline = rebaseBaseline(baseline, tree)
          compiled = compilePrompt({ tree, task: input.task })
          inventoryHash = buildToolInventory(tree).hash
          accepted = true
          improvements += 1
          await ledger.append({ kind: "improvement.finished", improvementId, outcome: "accepted" })
          say(`improvement ${improvementId}: accepted (${proposal.changed.length} file(s) changed)`)
        } else {
          await ledger.append({ kind: "improvement.finished", improvementId, outcome: "rejected" })
          // The code and the reason, not just "refused": a rejection that does not say why is a run that
          // stopped for a reason nobody can act on.
          const why =
            proposal.status === "proposed"
              ? foreign.length === 0
                ? "no change"
                : `paths outside the captured harness: ${foreign.join(", ")}`
              : `${proposal.code}: ${proposal.reason}`
          say(`improvement ${improvementId}: rejected (${why})`)
        }
      } catch (error) {
        accepted = false
        await ledger.append({ kind: "improvement.finished", improvementId, outcome: "error" })
        outcome = "failed"
        reason = "error"
        detail = error instanceof Error ? error.message : String(error)
        break
      }
      lastImprovementAccepted = accepted
    }

    // The library is written where a later run would read it: the run directory holds the harness the run
    // ended with, lessons included.
    await materialiseTree({ dir: path.join(runDir, "tree"), tree: applyLessonLibrary(tree, library) })
    const finished = await ledger.finishRun(outcome)
    if (finished.kind !== "run.finished") {
      throw new Error(`the ledger closed the run as ${finished.kind}, not run.finished`)
    }
    say(`${outcome}: ${detail}`)

    return {
      runId,
      runDir,
      outcome,
      reason,
      detail,
      executions: finished.executions,
      // Ledger counts are operations of each kind; `acceptedImprovements` is the subset that actually
      // changed the harness. Reporting the local counter as `improvements` disagreed with `run.finished`
      // as soon as a proposal was rejected.
      improvements: finished.improvements,
      acceptedImprovements: improvements,
      lessons,
      ledgerPath: path.join(runDir, "ledger.jsonl"),
    }
  } finally {
    // The ledger owns a lock and a file handle: a throw from grading, reflection, materialising the tree or
    // a caller's progress callback must not leave either behind. `close()` is idempotent, so the explicit
    // close on the happy path stays harmless.
    await ledger.close()
  }
}

/** Ledger counts are the only source of "how many so far"; a local counter could drift from the record. */
async function finishedCount(ledger: RunLedger, of: "execution" | "improvement"): Promise<number> {
  const counts = await ledger.counts()
  return of === "execution" ? counts.executions : counts.improvements
}

function thresholdsOf(config: RunConfig): {
  tailTokens: number
  targetTokens: number
  b1Tokens: number
  b2Tokens: number
} {
  return {
    tailTokens: config.tailTokens,
    targetTokens: config.targetTokens,
    b1Tokens: config.b1Tokens,
    b2Tokens: config.b2Tokens,
  }
}

/**
 * The conversation as the harness left it.
 *
 * Built from the turn result rather than read from `messagesPath`: the adapter records that path as
 * nullable, so a run that depends on the file would be measuring whatever the SDK happened to flush.
 */
function conversationOf(task: string, record: SessionBootstrapRecord): Record<string, unknown>[] {
  return [
    { role: "user", content: task },
    { role: "assistant", content: record.text },
  ]
}

function measureContext(
  config: RunConfig,
  systemPrompt: string,
  task: string,
  record: SessionBootstrapRecord,
): ContextAssessment {
  return detectContext({
    messages: conversationOf(task, record),
    thresholds: thresholdsOf(config),
    systemPrompt,
  })
}

/**
 * One execution, as the oracle sees it.
 *
 * Hand-built rather than `JSON.stringify(record)`: the record is wide, and the parts of it an Improver can
 * act on are the outcome, what the turn said, and why it stopped. Serialising everything would spend the
 * oracle's context on paths and counters.
 */
function evidenceOf(
  executionId: string,
  record: SessionBootstrapRecord,
  outcome: ExecutionOutcome,
): { path: string; body: string }[] {
  const body = [
    `execution: ${executionId}`,
    `outcome: ${outcome}`,
    `turns: ${record.turns}`,
    `tool calls: ${record.toolCallCount}`,
    `finish reason: ${record.finishReason ?? "(none)"}`,
    `compiled prompt: ${record.compiledPromptHash}`,
    `probe fingerprint: ${record.probeFingerprintSha256}`,
    "",
    "final text:",
    record.text,
    "",
  ].join("\n")
  return [{ path: `evidence/${executionId}.md`, body }]
}

/**
 * The baseline for an improved tree.
 *
 * An improvement changes the harness and nothing else: same repo, same commit, same lockfile, same SSOT
 * links, same components present. So exactly one field of the fingerprint moves — `treeSha` — and every
 * other field is carried over unchanged. Recomputing the whole fingerprint from the capture would have to
 * re-derive the association list, and a fresh `[]` there would silently claim the repo links to nothing.
 *
 * Without this the second execution would mount a tree its baseline never captured, and
 * `verifyHarnessBaseline` would refuse it — correctly, but only after the improvement had been recorded.
 */
export function rebaseBaseline(previous: HarnessBaseline, tree: HarnessTree): HarnessBaseline {
  const fingerprint = baselineFingerprintSchema.parse({
    ...previous.fingerprint,
    treeSha: canonicalSha256(tree),
  })
  return { tree, baselineSha: baselineShaOf(fingerprint), fingerprint }
}

/**
 * Paths a proposal would add or delete.
 *
 * A run improves the harness it captured. Adding or removing a harness file changes what the baseline's
 * manifest describes — presence, not only content — and this loop has no way to re-derive a manifest
 * mid-run. Re-basing only `treeSha` and leaving `manifestSha` alone would then be a statement about the
 * repo that is no longer true, so such a proposal is rejected and the reason is recorded instead.
 *
 * `LongTermMEMORY.md` is exempt because the loop owns it: the library is run state, not a captured
 * component.
 */
function outsideCaptured(next: HarnessTree, previous: HarnessTree): string[] {
  const before = new Set(Object.keys(previous))
  const after = new Set(Object.keys(next))
  const foreign: string[] = []
  for (const path of after) {
    if (path === LESSON_LIBRARY_PATH) continue
    if (!before.has(path)) foreign.push(`+${path}`)
  }
  for (const path of before) {
    if (path === LESSON_LIBRARY_PATH) continue
    if (!after.has(path)) foreign.push(`-${path}`)
  }
  return foreign.sort()
}

/**
 * Every credential this run knows, for redaction at the boundaries that leave the process.
 *
 * `evidenceOf` omits the configuration entirely, so a key cannot arrive from there — but the *solver's own
 * text* is evidence too, and a turn that echoes a credential would otherwise forward it to the Improver and,
 * on failure, to the Reflector. Short values are ignored: redacting a two-character "secret" would mangle
 * ordinary text and hide nothing.
 */
function secretsOf(config: RunConfig): readonly string[] {
  return [config.apiKey, config.geminiApiKey, config.astraApiKey].filter(
    (value): value is string => typeof value === "string" && value.trim().length >= 8,
  )
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) out = out.split(secret).join("***")
  return out
}
