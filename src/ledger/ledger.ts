import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

import { expectedExecutions, expectedImprovements } from "../domain/schemas.ts"
import { LedgerError } from "./errors.ts"
import {
  LEDGER_EVENT_VERSION,
  ledgerEventSchema,
  type LedgerEvent,
  type LedgerEventInput,
  type RunOutcome,
} from "./events.ts"
import { replayLedger, type LedgerCounts } from "./replay.ts"

/**
 * The append-only record of one run, and the only writer of its file.
 *
 * Three properties are load-bearing and each one is defended by a mechanism rather than a convention:
 *
 * 1. **One writer.** A lock file claimed with `wx` makes a second `open()` an error instead of a race.
 *    Two writers would interleave `seq` allocation and each would believe it was serialising appends.
 * 2. **A total order.** `seq` is allocated by the writer under its own queue, so the file order *is*
 *    the causal order. Readers replay it; they never guess.
 * 3. **No event replay would refuse.** Every append dry-runs `replayLedger` over the whole history
 *    before the bytes reach the disk, so the file cannot come to contain a record that is corrupt,
 *    duplicated, or over budget.
 *
 * What it deliberately is not: a WAL. There is no rollback, no truncation, no rewriting. Evidence that
 * can be rewritten is not evidence, so a bad ledger is a new run directory, not an edited file.
 */

export const LEDGER_FILE_NAME = "ledger.jsonl"
export const LEDGER_LOCK_NAME = "ledger.lock"

export interface RunLedgerOptions {
  readonly runDir: string
  /** Task-level recursion budget: `4k` executions and `3k` improvements. */
  readonly k: number
  /** `datasync()` after every append. Defaults to true; a ledger is tens of lines, not thousands. */
  readonly durable?: boolean
  readonly now?: () => Date
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null | undefined)?.code
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return "no issue reported"
  const at = issue.path.length === 0 ? "<root>" : issue.path.map(String).join(".")
  return `${at}: ${issue.message}`
}

/**
 * Read a ledger file, refusing to interpret anything doubtful.
 *
 * A torn final line is what a crash mid-`write` looks like, and it is reported as such rather than
 * dropped: silently ignoring the last line would make a run that lost its closing events look like a
 * run that simply had fewer of them. A corrupt line *before* the tail is a different animal — that is
 * a hand-edited or foreign file, and it gets its line number and byte offset so it can be looked at.
 */
export async function readLedgerFile(file: string): Promise<LedgerEvent[]> {
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return []
    throw new LedgerError("LEDGER_IO_FAILED", `could not read ${file}: ${describe(error)}`, {
      cause: error,
    })
  }
  if (text.length === 0) return []

  if (!text.endsWith("\n")) {
    const lines = text.split("\n").length
    throw new LedgerError(
      "LEDGER_TRUNCATED",
      `${file} ends mid-line at line ${lines} (${text.length} bytes); the last append did not ` +
        "complete, so the events it carried were never durable. Re-run rather than editing the file",
      { line: lines, offset: text.length },
    )
  }

  const rawLines = text.slice(0, -1).split("\n")
  const events: LedgerEvent[] = []
  let offset = 0

  for (const [index, raw] of rawLines.entries()) {
    const line = index + 1
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new LedgerError(
        "LEDGER_CORRUPT",
        `${file} line ${line} is not JSON: ${describe(error)}`,
        { cause: error, line, offset },
      )
    }

    const validated = ledgerEventSchema.safeParse(parsed)
    if (!validated.success) {
      throw new LedgerError(
        "LEDGER_INVALID_EVENT",
        `${file} line ${line} is not a valid ledger event: ${describeIssue(validated.error)}`,
        { cause: validated.error, line, offset },
      )
    }
    events.push(validated.data)
    offset += Buffer.byteLength(raw, "utf8") + 1
  }

  // Catches everything a per-line schema cannot see: gapped seq, duplicate ids, events after the run
  // finished, and a `run.finished` whose totals disagree with the events it summarises.
  replayLedger(events)
  return events
}

/**
 * The slice of `FileHandle.write` this module needs.
 *
 * Narrowed to three arguments on purpose: `write()` may resolve having written fewer bytes than asked
 * (POSIX allows a short write), and a ledger that trusted the promise to mean "all of it" would advance
 * `seq` past a line that is half on disk. The loop below is unit-tested with a fake that returns short
 * counts, which a real filesystem will not do on demand.
 */
export interface ByteWriter {
  write(buffer: Buffer, offset: number, length: number): Promise<{ bytesWritten: number }>
}

export async function writeAll(writer: ByteWriter, buffer: Buffer): Promise<void> {
  let written = 0
  while (written < buffer.length) {
    const { bytesWritten } = await writer.write(buffer, written, buffer.length - written)
    if (bytesWritten <= 0) throw new Error("write made no progress")
    written += bytesWritten
  }
}

async function claimLock(lockPath: string, now: () => Date): Promise<void> {
  try {
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, at: now().toISOString() })}\n`, {
      flag: "wx",
    })
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new LedgerError(
        "LEDGER_LOCKED",
        `${lockPath} already exists, so another writer owns this ledger. If you are certain the run ` +
          "that created it is dead, remove the lock deliberately — it is never removed automatically",
        { cause: error },
      )
    }
    throw new LedgerError("LEDGER_IO_FAILED", `could not claim ${lockPath}: ${describe(error)}`, {
      cause: error,
    })
  }
}

interface RunLedgerState {
  readonly file: string
  readonly lockPath: string
  readonly k: number
  readonly durable: boolean
  readonly now: () => Date
  readonly handle: FileHandle
  readonly events: LedgerEvent[]
  readonly seq: number
  readonly finished: boolean
}

export class RunLedger {
  private readonly file: string
  private readonly lockPath: string
  private readonly k: number
  private readonly durable: boolean
  private readonly now: () => Date
  private readonly events: LedgerEvent[]
  private handle: FileHandle | undefined
  private seq: number
  private finished: boolean
  private state: "open" | "closing" | "closed" | "failed"
  private closePromise: Promise<void> | undefined
  /**
   * Appends are serialised through this chain rather than awaited directly by callers.
   *
   * Sequence allocation, budget reservation, the replay dry-run and the write itself all happen inside
   * one queued turn, so two callers that append concurrently cannot both be admitted past a budget
   * check that only one of them should pass.
   */
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(input: RunLedgerState) {
    this.file = input.file
    this.lockPath = input.lockPath
    this.k = input.k
    this.durable = input.durable
    this.now = input.now
    this.handle = input.handle
    this.events = input.events
    this.seq = input.seq
    this.finished = input.finished
    this.state = "open"
  }

  /** Claim a run's ledger. Fails rather than joining an existing writer. */
  static async open(options: RunLedgerOptions): Promise<RunLedger> {
    const k = options.k
    if (!Number.isInteger(k) || k < 1) {
      throw new LedgerError("LEDGER_INVALID_EVENT", `k must be a positive integer, got ${String(k)}`)
    }

    const runDir = path.resolve(options.runDir)
    await mkdir(runDir, { recursive: true })
    const file = path.join(runDir, LEDGER_FILE_NAME)
    const lockPath = path.join(runDir, LEDGER_LOCK_NAME)
    const now = options.now ?? (() => new Date())

    await claimLock(lockPath, now)
    try {
      const events = await readLedgerFile(file)
      const counts = replayLedger(events)
      const first = events[0]
      if (first !== undefined && first.kind === "run.started" && first.k !== k) {
        throw new LedgerError(
          "LEDGER_INVALID_EVENT",
          `${file} was started with k=${first.k}; reopening it with k=${k} would compare two ` +
            "different budgets",
        )
      }
      const handle = await open(file, "a").catch((error: unknown) => {
        throw new LedgerError(
          "LEDGER_IO_FAILED",
          `could not open ${file} for appending: ${describe(error)}`,
          { cause: error },
        )
      })
      return new RunLedger({
        file,
        lockPath,
        k,
        durable: options.durable !== false,
        now,
        handle,
        events,
        seq: counts.lastSeq + 1,
        finished: counts.finished,
      })
    } catch (error) {
      // The lock is ours and this instance never came into existence, so nobody else will release it.
      await rm(lockPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  get filePath(): string {
    return this.file
  }

  get runFinished(): boolean {
    return this.finished
  }

  async append(input: LedgerEventInput): Promise<LedgerEvent> {
    // Checked at submission, not inside the queued task: `close()` drains what was already admitted, and
    // a task admitted before close must still run rather than fail because the shutdown has begun.
    this.assertAccepting()
    return this.enqueue(async () => await this.appendNow(input))
  }

  /** Read the file back from disk, after every queued append has landed. */
  async read(): Promise<LedgerEvent[]> {
    await this.queue
    return await readLedgerFile(this.file)
  }

  async counts(): Promise<LedgerCounts> {
    return replayLedger(await this.read())
  }

  /**
   * Close the run, then leave the file alone.
   *
   * Deliberately separate from `close()`: a run can be closed for any reason — a crash handler, a
   * shutdown — while only a run that finished its work may record that it did. `completed` is refused
   * while anything is still open, so the record cannot claim an ending its events do not support.
   */
  async finishRun(outcome: RunOutcome): Promise<LedgerEvent> {
    this.assertAccepting()
    return this.enqueue(async () => {
      this.assertNotPoisoned()
      const counts = replayLedger(this.events)
      if (counts.finished) {
        throw new LedgerError("LEDGER_DUPLICATE", `the run in ${this.file} is already finished`)
      }
      if (
        outcome === "completed" &&
        (counts.openExecutions.length > 0 || counts.openImprovements.length > 0)
      ) {
        throw new LedgerError(
          "LEDGER_INVALID_EVENT",
          `cannot finish this run as completed: ${counts.openExecutions.length} execution(s) and ` +
            `${counts.openImprovements.length} improvement(s) are still open`,
        )
      }
      return await this.appendNow({
        kind: "run.finished",
        outcome,
        executions: counts.executions,
        improvements: counts.improvements,
        physicalAttempts: counts.physicalAttempts,
      })
    })
  }

  /** Drain, release the file handle and release the lock. Safe — and idempotent — from any caller. */
  async close(): Promise<void> {
    // One teardown per instance. Two concurrent closes would otherwise race over the handle and the
    // lock, and the slower one could delete a lock that a *new* writer had already claimed.
    this.closePromise ??= this.doClose()
    return await this.closePromise
  }

  private async doClose(): Promise<void> {
    this.state = "closing"
    await this.queue
    const handle = this.handle
    this.handle = undefined
    let failure: LedgerError | undefined
    try {
      await handle?.close()
    } catch (error) {
      failure = new LedgerError("LEDGER_IO_FAILED", `could not close ${this.file}: ${describe(error)}`, {
        cause: error,
      })
    }
    try {
      await rm(this.lockPath, { force: true })
    } catch (error) {
      failure ??= new LedgerError(
        "LEDGER_IO_FAILED",
        `could not release ${this.lockPath}: ${describe(error)}`,
        { cause: error },
      )
    }
    this.state = "closed"
    if (failure !== undefined) throw failure
  }

  private async appendNow(input: LedgerEventInput): Promise<LedgerEvent> {
    this.assertNotPoisoned()
    if (this.finished) {
      throw new LedgerError(
        "LEDGER_CLOSED",
        `the run in ${this.file} is finished; a finished ledger is evidence and takes no more events`,
      )
    }

    const validated = ledgerEventSchema.safeParse({
      ...input,
      version: LEDGER_EVENT_VERSION,
      seq: this.seq,
      at: this.now().toISOString(),
    })
    if (!validated.success) {
      throw new LedgerError(
        "LEDGER_INVALID_EVENT",
        `refusing to append a malformed event: ${describeIssue(validated.error)}`,
        { cause: validated.error },
      )
    }
    const event = validated.data

    if (event.kind === "run.started" && event.k !== this.k) {
      throw new LedgerError(
        "LEDGER_INVALID_EVENT",
        `run.started declares k=${event.k}, but this ledger enforces k=${this.k}; a run cannot record a ` +
          "budget it is not held to",
      )
    }

    this.assertBudget(event)
    replayLedger([...this.events, event])

    await this.write(event)
    this.events.push(event)
    this.seq += 1
    if (event.kind === "run.finished") this.finished = true
    // A copy: the caller must not be able to edit the object the writer keeps as its history, which
    // would let a later append validate against memory while the file says something else.
    return structuredClone(event)
  }

  /**
   * Reserve budget on *start*, not on finish.
   *
   * Checking only on finish would admit more work than the budget allows and then refuse to record the
   * completion — stranding an operation that already spent tokens and making replay undercount the
   * work that actually happened. Reservation makes the refusal happen before the cost.
   */
  private assertBudget(event: LedgerEvent): void {
    if (event.kind === "execution.started") {
      const counts = replayLedger(this.events)
      const used = counts.executions + counts.openExecutions.length
      const limit = expectedExecutions(this.k)
      if (used + 1 > limit) {
        throw new LedgerError(
          "BUDGET_EXCEEDED",
          `starting execution ${event.executionId} would be execution ${used + 1} of a ${limit} ` +
            `budget (4k with k=${this.k})`,
        )
      }
    }
    if (event.kind === "improvement.started") {
      const counts = replayLedger(this.events)
      const used = counts.improvements + counts.openImprovements.length
      const limit = expectedImprovements(this.k)
      if (used + 1 > limit) {
        throw new LedgerError(
          "BUDGET_EXCEEDED",
          `starting improvement ${event.improvementId} would be improvement ${used + 1} of a ` +
            `${limit} budget (3k with k=${this.k})`,
        )
      }
    }
  }

  private async write(event: LedgerEvent): Promise<void> {
    if (this.handle === undefined) {
      throw new LedgerError("LEDGER_IO_FAILED", `${this.file} has no open handle`)
    }
    try {
      await writeAll(this.handle, Buffer.from(`${JSON.stringify(event)}\n`, "utf8"))
      if (this.durable) await this.handle.datasync()
    } catch (error) {
      // A writer that failed mid-append cannot know what reached the disk, so it refuses further work
      // rather than appending a sequence number that may already exist.
      this.state = "failed"
      throw new LedgerError("LEDGER_IO_FAILED", `could not append to ${this.file}: ${describe(error)}`, {
        cause: error,
      })
    }
  }

  private assertNotPoisoned(): void {
    if (this.state !== "failed") return
    throw new LedgerError(
      "LEDGER_IO_FAILED",
      `this writer is unusable after an earlier write failure; reopen ${this.file} to continue`,
    )
  }

  /** Refuse *new* work once teardown has begun; work already queued still drains. */
  private assertAccepting(): void {
    this.assertNotPoisoned()
    if (this.state === "open") return
    throw new LedgerError("LEDGER_CLOSED", `this ledger is ${this.state} and accepts no more events`)
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => task())
    // The chain itself never rejects, or one failed append would wedge every later one.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
