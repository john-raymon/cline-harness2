import { expectedExecutions, expectedImprovements } from "../domain/schemas.ts"
import { LedgerError } from "./errors.ts"
import { IMPROVEMENT_STAGES, type ImprovementStage, type LedgerEvent } from "./events.ts"

/**
 * What a ledger says happened, derived only from its events.
 *
 * This is the module's whole gate in one function: "counts are exact and replayable" means a reader
 * that never saw the run can reproduce every number from the file alone, and that the numbers cannot
 * be inflated by a caller who appends twice.
 *
 * `executions` and `improvements` are the `4k`/`3k` identity and move only on a terminal event.
 * `physicalAttempts` is the cost line: retries, schema repairs and oracle substitutions are real work
 * but not real progress, and folding them into the counters above is exactly how a run reports `4k`
 * executions while having made four.
 */

export interface LedgerCounts {
  readonly executions: number
  readonly improvements: number
  readonly physicalAttempts: number
  /** Started but not finished. Non-empty at `run.finished` means the run did not close its work. */
  readonly openExecutions: readonly string[]
  readonly openImprovements: readonly string[]
  readonly byStage: Readonly<Record<ImprovementStage, number>>
  readonly lastSeq: number
  readonly finished: boolean
}

const ZERO_BY_STAGE: Record<ImprovementStage, number> = {
  improver: 0,
  composer: 0,
  selector: 0,
  reflector: 0,
}

export const EMPTY_COUNTS: LedgerCounts = {
  executions: 0,
  improvements: 0,
  physicalAttempts: 0,
  openExecutions: [],
  openImprovements: [],
  byStage: ZERO_BY_STAGE,
  lastSeq: 0,
  finished: false,
}

function corrupt(event: LedgerEvent, index: number, detail: string): never {
  throw new LedgerError("LEDGER_CORRUPT", `event ${index + 1} (seq ${event.seq}): ${detail}`, {
    line: index + 1,
  })
}

function invalid(event: LedgerEvent, index: number, detail: string): never {
  throw new LedgerError(
    "LEDGER_INVALID_EVENT",
    `event ${index + 1} (seq ${event.seq}, ${event.kind}): ${detail}`,
    { line: index + 1 },
  )
}

function duplicate(event: LedgerEvent, index: number, detail: string): never {
  throw new LedgerError(
    "LEDGER_DUPLICATE",
    `event ${index + 1} (seq ${event.seq}, ${event.kind}): ${detail}`,
    { line: index + 1 },
  )
}

/**
 * Enforce `4k`/`3k` while replaying, not only while writing.
 *
 * The writer reserves budget before it appends, so a file it produced cannot exceed the limit. A file
 * that was edited, or written by an older build, could — and a reader that accepted it would report a
 * run that broke its own contract as if it had not. `k` comes from the file's own `run.started`, so the
 * limit a reader applies is the limit the run declared.
 */
function assertBudget(
  kind: "execution" | "improvement",
  event: LedgerEvent,
  index: number,
  k: number | undefined,
  used: number,
): void {
  if (k === undefined) return
  const limit = kind === "execution" ? expectedExecutions(k) : expectedImprovements(k)
  if (used > limit) {
    throw new LedgerError(
      "BUDGET_EXCEEDED",
      `event ${index + 1} (seq ${event.seq}, ${event.kind}): this ${kind} would be ${used} of a ` +
        `${limit} budget (k=${k})`,
      { line: index + 1 },
    )
  }
}

/**
 * Replay every event, refusing anything that would make the record ambiguous.
 *
 * Ordering rules are enforced here rather than only in the writer, because the file is the artifact an
 * operator reads and a hand-edited line has to be rejected by the reader too.
 */
export function replayLedger(events: readonly LedgerEvent[]): LedgerCounts {
  let executions = 0
  let improvements = 0
  let physicalAttempts = 0
  let finished = false
  let lastSeq = 0
  /** The budget declared by `run.started`, so replay enforces the same limit the writer enforced. */
  let k: number | undefined
  let openExecutionCount = 0
  let openImprovementCount = 0

  /** Operations that started and have not finished, keyed by id, valued by the counter they feed. */
  const open = new Map<string, "execution" | "improvement">()
  const stageOf = new Map<string, ImprovementStage>()
  /** Ids that already finished, so a second terminal event is reported as a duplicate, not a mystery. */
  const closed = new Set<string>()
  const attemptIds = new Set<string>()
  const byStage: Record<ImprovementStage, number> = { ...ZERO_BY_STAGE }

  for (const [index, event] of events.entries()) {
    if (event.seq !== index + 1) {
      corrupt(event, index, `expected seq ${index + 1}; the sequence has a gap or a duplicate`)
    }
    lastSeq = event.seq

    if (finished) {
      invalid(event, index, "run.finished is terminal; nothing may follow it")
    }
    if (index === 0 && event.kind !== "run.started") {
      invalid(event, index, "the first event must be run.started")
    }
    if (index > 0 && event.kind === "run.started") {
      duplicate(event, index, "a ledger holds exactly one run; a second run.started is a new file")
    }

    switch (event.kind) {
      case "run.started": {
        k = event.k
        break
      }
      case "execution.started": {
        if (open.has(event.executionId) || closed.has(event.executionId)) {
          duplicate(event, index, `execution ${event.executionId} has already been used in this run`)
        }
        assertBudget("execution", event, index, k, executions + openExecutionCount + 1)
        open.set(event.executionId, "execution")
        openExecutionCount += 1
        break
      }
      case "execution.finished": {
        const kind = open.get(event.executionId)
        if (kind === undefined) {
          if (closed.has(event.executionId)) {
            duplicate(event, index, `execution ${event.executionId} already finished`)
          }
          invalid(event, index, `execution ${event.executionId} finished without a start`)
        }
        if (kind !== "execution") {
          duplicate(event, index, `${event.executionId} is open as an ${kind}, not an execution`)
        }
        open.delete(event.executionId)
        openExecutionCount -= 1
        closed.add(event.executionId)
        executions += 1
        break
      }
      case "improvement.started": {
        if (open.has(event.improvementId) || closed.has(event.improvementId)) {
          duplicate(event, index, `improvement ${event.improvementId} has already been used in this run`)
        }
        assertBudget("improvement", event, index, k, improvements + openImprovementCount + 1)
        open.set(event.improvementId, "improvement")
        openImprovementCount += 1
        stageOf.set(event.improvementId, event.stage)
        break
      }
      case "improvement.finished": {
        const kind = open.get(event.improvementId)
        const stage = stageOf.get(event.improvementId)
        if (kind === undefined || stage === undefined) {
          if (closed.has(event.improvementId)) {
            duplicate(event, index, `improvement ${event.improvementId} already finished`)
          }
          invalid(event, index, `improvement ${event.improvementId} finished without a start`)
        }
        if (kind !== "improvement") {
          duplicate(event, index, `${event.improvementId} is open as an ${kind}, not an improvement`)
        }
        open.delete(event.improvementId)
        openImprovementCount -= 1
        stageOf.delete(event.improvementId)
        closed.add(event.improvementId)
        improvements += 1
        byStage[stage] += 1
        break
      }
      case "attempt.recorded": {
        if (attemptIds.has(event.attemptId)) {
          duplicate(event, index, `attempt ${event.attemptId} is recorded twice`)
        }
        attemptIds.add(event.attemptId)
        const kind = open.get(event.targetId)
        if (kind === undefined) {
          invalid(
            event,
            index,
            `attempt targets ${event.targetId}, which is not open; an attempt cannot happen ` +
              "before its operation starts",
          )
        }
        if (kind !== event.of) {
          invalid(
            event,
            index,
            `attempt says ${event.targetId} is an ${event.of}, but it is open as an ${kind}`,
          )
        }
        physicalAttempts += 1
        break
      }
      case "run.finished": {
        if (
          event.executions !== executions ||
          event.improvements !== improvements ||
          event.physicalAttempts !== physicalAttempts
        ) {
          invalid(
            event,
            index,
            `totals disagree with the record: reported ${event.executions}/${event.improvements}/` +
              `${event.physicalAttempts} (executions/improvements/attempts), replayed ` +
              `${executions}/${improvements}/${physicalAttempts}`,
          )
        }
        if (event.outcome === "completed" && open.size > 0) {
          invalid(
            event,
            index,
            `a completed run cannot leave ${open.size} open operation(s): ${[...open.keys()].join(", ")}`,
          )
        }
        finished = true
        break
      }
    }
  }

  return {
    executions,
    improvements,
    physicalAttempts,
    openExecutions: [...open]
      .filter(([, kind]) => kind === "execution")
      .map(([id]) => id),
    // Reported in pipeline order, not start order, so two equivalent runs summarise identically.
    openImprovements: IMPROVEMENT_STAGES.flatMap((stage) =>
      [...open]
        .filter(([id, kind]) => kind === "improvement" && stageOf.get(id) === stage)
        .map(([id]) => id),
    ),
    byStage,
    lastSeq,
    finished,
  }
}
