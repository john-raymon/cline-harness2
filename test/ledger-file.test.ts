import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { afterEach, describe, it } from "node:test"
import os from "node:os"
import path from "node:path"

import { LedgerError } from "../src/ledger/errors.ts"
import { LEDGER_FILE_NAME, RunLedger, readLedgerFile, writeAll, type ByteWriter } from "../src/ledger/ledger.ts"
import { replayLedger } from "../src/ledger/replay.ts"
import { asInput, eventAt, runStartedBody } from "./support/ledger-fixtures.ts"

/**
 * The writer, and the file it produces.
 *
 * These tests are about the two things a ledger has to be: append-only (a refused event leaves zero
 * bytes behind) and singular (one writer, one sequence, one run).
 */

const scratchRoots: string[] = []

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness2-ledger-"))
  scratchRoots.push(root)
  return root
}

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function errorOf(task: Promise<unknown>): Promise<LedgerError> {
  try {
    await task
  } catch (error) {
    assert.ok(error instanceof LedgerError, `expected a LedgerError, got ${String(error)}`)
    return error
  }
  assert.fail("expected this call to fail")
}

async function fileBytes(file: string): Promise<string> {
  return readFile(file, "utf8")
}

describe("run ledger", () => {
  it("writes one parseable line per event, with a trailing newline", async () => {
    const runDir = await scratch()
    const ledger = await RunLedger.open({ runDir, k: 1, durable: false })
    await ledger.append(asInput(runStartedBody()))
    await ledger.append({ kind: "execution.started", executionId: "exec-1", taskId: "task-1" })
    await ledger.append({ kind: "execution.finished", executionId: "exec-1", outcome: "pass" })
    const file = path.join(runDir, LEDGER_FILE_NAME)
    await ledger.close()

    const text = await fileBytes(file)
    assert.equal(text.endsWith("\n"), true)
    const lines = text.slice(0, -1).split("\n")
    assert.equal(lines.length, 3)
    for (const [index, line] of lines.entries()) {
      const parsed = JSON.parse(line) as { seq: number }
      assert.equal(parsed.seq, index + 1)
    }
  })

  it("refuses a second writer and releases the lock on close", async () => {
    const runDir = await scratch()
    const first = await RunLedger.open({ runDir, k: 1, durable: false })
    const locked = await errorOf(RunLedger.open({ runDir, k: 1, durable: false }))
    assert.equal(locked.code, "LEDGER_LOCKED")
    assert.match(locked.message, /never removed automatically/)

    await first.close()
    const second = await RunLedger.open({ runDir, k: 1, durable: false })
    await second.close()
  })

  it("continues the sequence on reopen and refuses a different budget", async () => {
    const runDir = await scratch()
    const first = await RunLedger.open({ runDir, k: 2, durable: false })
    await first.append(asInput(runStartedBody({ k: 2 })))
    await first.append({ kind: "execution.started", executionId: "exec-1", taskId: "task-1" })
    await first.close()

    const reopened = await RunLedger.open({ runDir, k: 2, durable: false })
    const appended = await reopened.append({ kind: "execution.finished", executionId: "exec-1", outcome: "pass" })
    assert.equal(appended.seq, 3)
    await reopened.close()

    const mismatch = await errorOf(RunLedger.open({ runDir, k: 3, durable: false }))
    assert.equal(mismatch.code, "LEDGER_INVALID_EVENT")
    assert.match(mismatch.message, /different budgets/)
  })

  it("leaves the file byte-identical when an append is refused", async () => {
    const runDir = await scratch()
    const ledger = await RunLedger.open({ runDir, k: 1, durable: false })
    await ledger.append(asInput(runStartedBody()))
    await ledger.append({ kind: "execution.started", executionId: "exec-1", taskId: "task-1" })
    const file = path.join(runDir, LEDGER_FILE_NAME)
    const before = await fileBytes(file)

    const duplicate = await errorOf(
      ledger.append({ kind: "execution.started", executionId: "exec-1", taskId: "task-1" }),
    )
    assert.equal(duplicate.code, "LEDGER_DUPLICATE")
    assert.equal(await fileBytes(file), before, "a refused append must not reach the disk")
    await ledger.close()
  })

  it("reserves the 4k budget on start, not on finish", async () => {
    const runDir = await scratch()
    // k=1 is four executions. Starting five without finishing any must fail, because admitting the
    // fifth would spend the work and then refuse to record it.
    const ledger = await RunLedger.open({ runDir, k: 1, durable: false })
    await ledger.append(asInput(runStartedBody()))
    for (let index = 1; index <= 4; index += 1) {
      await ledger.append({ kind: "execution.started", executionId: `exec-${index}`, taskId: "task-1" })
    }
    const file = path.join(runDir, LEDGER_FILE_NAME)
    const before = await fileBytes(file)

    const over = await errorOf(
      ledger.append({ kind: "execution.started", executionId: "exec-5", taskId: "task-1" }),
    )
    assert.equal(over.code, "BUDGET_EXCEEDED")
    assert.match(over.message, /execution 5 of a 4 budget/)
    assert.equal(await fileBytes(file), before)

    // Finishing the admitted work is always allowed, and reopens no capacity.
    for (let index = 1; index <= 4; index += 1) {
      await ledger.append({ kind: "execution.finished", executionId: `exec-${index}`, outcome: "pass" })
    }
    const stillOver = await errorOf(
      ledger.append({ kind: "execution.started", executionId: "exec-6", taskId: "task-1" }),
    )
    assert.equal(stillOver.code, "BUDGET_EXCEEDED")
    await ledger.close()
  })

  it("refuses to record a completed run while work is open, then writes exact totals", async () => {
    const runDir = await scratch()
    const ledger = await RunLedger.open({ runDir, k: 1, durable: false })
    await ledger.append(asInput(runStartedBody()))
    await ledger.append({ kind: "execution.started", executionId: "exec-1", taskId: "task-1" })
    await ledger.append({ kind: "attempt.recorded", attemptId: "att-1", of: "execution", targetId: "exec-1", reason: "initial" })

    const premature = await errorOf(ledger.finishRun("completed"))
    assert.equal(premature.code, "LEDGER_INVALID_EVENT")
    assert.match(premature.message, /still open/)

    await ledger.append({ kind: "execution.finished", executionId: "exec-1", outcome: "pass" })
    const finished = await ledger.finishRun("completed")
    assert.equal(finished.kind, "run.finished")
    assert.equal(ledger.runFinished, true)

    const counts = await ledger.counts()
    assert.equal(counts.executions, 1)
    assert.equal(counts.improvements, 0)
    assert.equal(counts.physicalAttempts, 1)

    const late = await errorOf(
      ledger.append({ kind: "execution.started", executionId: "exec-2", taskId: "task-1" }),
    )
    assert.equal(late.code, "LEDGER_CLOSED")
    await ledger.close()
  })

  it("accepts no events after close", async () => {
    const runDir = await scratch()
    const ledger = await RunLedger.open({ runDir, k: 1, durable: false })
    await ledger.append(asInput(runStartedBody()))
    await ledger.close()
    const error = await errorOf(
      ledger.append({ kind: "execution.started", executionId: "exec-1", taskId: "task-1" }),
    )
    assert.equal(error.code, "LEDGER_CLOSED")
    // Closing twice is not an error: a crash handler and a finally block both get to call it.
    await ledger.close()
  })

  it("serves counts from the file, so what a reader sees is what a writer wrote", async () => {
    const runDir = await scratch()
    const ledger = await RunLedger.open({ runDir, k: 2, durable: true })
    await ledger.append(asInput(runStartedBody({ k: 2 })))
    await ledger.append({ kind: "execution.started", executionId: "exec-1", taskId: "task-1" })
    await ledger.append({ kind: "execution.finished", executionId: "exec-1", outcome: "fail" })
    await ledger.append({ kind: "improvement.started", improvementId: "imp-1", stage: "reflector" })
    await ledger.append({ kind: "improvement.finished", improvementId: "imp-1", outcome: "accepted" })
    await ledger.finishRun("halted")

    const fromDisk = replayLedger(await readLedgerFile(ledger.filePath))
    assert.deepEqual(fromDisk, await ledger.counts())
    assert.equal(fromDisk.executions, 1)
    assert.equal(fromDisk.improvements, 1)
    assert.equal(fromDisk.byStage.reflector, 1)
    await ledger.close()
  })

  it("refuses a run.started whose k is not the ledger's k", async () => {
    const runDir = await scratch()
    const ledger = await RunLedger.open({ runDir, k: 1, durable: false })
    const error = await errorOf(ledger.append(asInput(runStartedBody({ k: 5 }))))
    assert.equal(error.code, "LEDGER_INVALID_EVENT")
    assert.match(error.message, /declares k=5, but this ledger enforces k=1/)
    // Nothing was written, so reopening with the real k still works.
    assert.deepEqual(await readLedgerFile(path.join(runDir, LEDGER_FILE_NAME)), [])
    await ledger.close()
  })

  it("drains an append that was admitted before close", async () => {
    const runDir = await scratch()
    const ledger = await RunLedger.open({ runDir, k: 1, durable: false })
    await ledger.append(asInput(runStartedBody()))

    // Both calls are in flight at once: the append was admitted, so shutdown must finish it rather than
    // reject it and lose an event the caller believes was recorded.
    const pending = ledger.append({ kind: "execution.started", executionId: "exec-1", taskId: "task-1" })
    const closing = ledger.close()
    const [appended] = await Promise.all([pending, closing])

    assert.equal(appended.seq, 2)
    const events = await readLedgerFile(path.join(runDir, LEDGER_FILE_NAME))
    assert.equal(events.length, 2)
    assert.equal(events[1]?.kind, "execution.started")
  })

  it("survives concurrent closes without stranding the lock", async () => {
    const runDir = await scratch()
    const ledger = await RunLedger.open({ runDir, k: 1, durable: false })
    await ledger.append(asInput(runStartedBody()))
    // Two shutdown paths (a signal handler and a finally block) racing: one teardown, one lock removal.
    await Promise.all([ledger.close(), ledger.close()])

    const reopened = await RunLedger.open({ runDir, k: 1, durable: false })
    await reopened.close()
  })

  it("does not hand the caller the history it keeps", async () => {
    const runDir = await scratch()
    const ledger = await RunLedger.open({ runDir, k: 1, durable: false })
    await ledger.append(asInput(runStartedBody()))
    const started = await ledger.append({ kind: "execution.started", executionId: "exec-1", taskId: "task-1" })
    ;(started as unknown as { executionId: string }).executionId = "exec-mutated"

    // The writer's own history still holds the original id, so this finish is accepted...
    const finished = await ledger.append({ kind: "execution.finished", executionId: "exec-1", outcome: "pass" })
    assert.equal(finished.seq, 3)
    // ...and the file never mentioned the mutation.
    const text = await fileBytes(path.join(runDir, LEDGER_FILE_NAME))
    assert.match(text, /"exec-1"/)
    assert.doesNotMatch(text, /exec-mutated/)
    await ledger.close()
  })

  it("writes every byte of a line even when the file system accepts a short write", async () => {
    // POSIX allows `write` to accept fewer bytes than asked. A ledger that trusted the promise would
    // leave half a line on disk and then append the *next* event onto it.
    const chunks: string[] = []
    const stingy: ByteWriter = {
      write: (buffer, offset, length) => {
        const take = Math.min(2, length)
        chunks.push(buffer.subarray(offset, offset + take).toString("utf8"))
        return Promise.resolve({ bytesWritten: take })
      },
    }
    await writeAll(stingy, Buffer.from("{\"a\":1}\n", "utf8"))
    assert.equal(chunks.join(""), "{\"a\":1}\n")

    const stalled: ByteWriter = { write: () => Promise.resolve({ bytesWritten: 0 }) }
    await assert.rejects(writeAll(stalled, Buffer.from("x")), /no progress/)
  })

  it("reads a ledger as a stream of events, contiguously", async () => {
    const runDir = await scratch()
    const ledger = await RunLedger.open({ runDir, k: 1, durable: false })
    await ledger.append(asInput(runStartedBody()))
    await ledger.append({ kind: "execution.started", executionId: "exec-1", taskId: "task-1" })

    // Fifty appends in flight at once: the queue is the only thing keeping `seq` and the byte stream
    // in the same order.
    const attempts = Array.from({ length: 50 }, (_unused, index) =>
      ledger.append({
        kind: "attempt.recorded",
        attemptId: `att-${index + 1}`,
        of: "execution",
        targetId: "exec-1",
        reason: "retry",
      }),
    )
    await Promise.all(attempts)

    const events = await ledger.read()
    assert.equal(events.length, 52)
    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_event, index) => index + 1),
    )
    const attemptIds = new Set(events.flatMap((event) => (event.kind === "attempt.recorded" ? [event.attemptId] : [])))
    assert.equal(attemptIds.size, 50, "a concurrent append was written twice or lost")
    assert.equal((await ledger.counts()).physicalAttempts, 50)
    await ledger.close()
  })

  it("reports a missing ledger as empty rather than as a failure", async () => {
    const runDir = await scratch()
    assert.deepEqual(await readLedgerFile(path.join(runDir, "nothing.jsonl")), [])
  })

  it("refuses a torn tail instead of dropping the half-written line", async () => {
    const runDir = await scratch()
    const file = path.join(runDir, LEDGER_FILE_NAME)
    await writeFile(file, `${JSON.stringify(eventAt(1, runStartedBody()))}\n{"kind":"execution.sta`)

    const error = await errorOf(readLedgerFile(file))
    assert.equal(error.code, "LEDGER_TRUNCATED")
    assert.equal(error.line, 2)
    assert.match(error.message, /did not complete/)
    // And the writer refuses to adopt it: a truncated file cannot be made whole by appending.
    const opened = await errorOf(RunLedger.open({ runDir, k: 1, durable: false }))
    assert.equal(opened.code, "LEDGER_TRUNCATED")
  })

  it("refuses a corrupt line and says which one, and where", async () => {
    const runDir = await scratch()
    const file = path.join(runDir, LEDGER_FILE_NAME)
    const first = `${JSON.stringify(eventAt(1, runStartedBody()))}\n`
    await writeFile(file, `${first}{"kind":\n${JSON.stringify(eventAt(3, { kind: "execution.started", executionId: "e", taskId: "t" }))}\n`)

    const error = await errorOf(readLedgerFile(file))
    assert.equal(error.code, "LEDGER_CORRUPT")
    assert.equal(error.line, 2)
    assert.equal(error.offset, first.length)
  })

  it("refuses a line that is JSON but not a ledger event", async () => {
    const runDir = await scratch()
    const file = path.join(runDir, LEDGER_FILE_NAME)
    await writeFile(file, `${JSON.stringify(eventAt(1, runStartedBody()))}\n{"kind":"run.paused"}\n`)

    const error = await errorOf(readLedgerFile(file))
    assert.equal(error.code, "LEDGER_INVALID_EVENT")
    assert.equal(error.line, 2)
  })

  it("refuses a file whose order replay would not accept", async () => {
    const runDir = await scratch()
    const file = path.join(runDir, LEDGER_FILE_NAME)
    // Both lines are individually valid; only the history is impossible.
    const finish = eventAt(2, { kind: "execution.finished", executionId: "exec-1", outcome: "pass" })
    await writeFile(file, `${JSON.stringify(eventAt(1, runStartedBody()))}\n${JSON.stringify(finish)}\n`)

    const error = await errorOf(readLedgerFile(file))
    assert.equal(error.code, "LEDGER_INVALID_EVENT")
    assert.match(error.message, /without a start/)
  })
})
