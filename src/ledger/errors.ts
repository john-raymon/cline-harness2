/**
 * Errors raised while recording a run.
 *
 * A ledger is evidence, so its failures are all "the record cannot be trusted" failures. Splitting
 * them by *how* it cannot be trusted is what lets an operator decide whether to look at the file, the
 * writer, or the caller: a torn tail is a crash, a duplicate is a caller bug, a budget breach is a
 * policy stop, and a locked ledger is a second writer.
 */
export type LedgerErrorCode =
  | "LEDGER_INVALID_EVENT"
  | "LEDGER_DUPLICATE"
  | "LEDGER_CORRUPT"
  | "LEDGER_TRUNCATED"
  | "LEDGER_LOCKED"
  | "LEDGER_CLOSED"
  | "LEDGER_IO_FAILED"
  | "BUDGET_EXCEEDED"
  | "ARTIFACT_INVALID"
  | "ARTIFACT_EXISTS"
  | "ARTIFACT_WRITE_FAILED"

export class LedgerError extends Error {
  override readonly name = "LedgerError"
  readonly code: LedgerErrorCode
  /** 1-based line number in the JSONL file, when the failure belongs to one. */
  readonly line: number | undefined
  /** Byte offset of that line's first character, so a 4 GB file is navigable. */
  readonly offset: number | undefined

  constructor(
    code: LedgerErrorCode,
    message: string,
    options: { cause?: unknown; line?: number; offset?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.line = options.line
    this.offset = options.offset
  }
}
