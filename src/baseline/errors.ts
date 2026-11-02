/**
 * Errors raised while capturing a baseline.
 *
 * Capture reads things it does not own, so its failure modes are different from the tree store's:
 * a link can leave the authorised roots, a repository can be unborn, and a source can change under
 * the reader. Keeping them in one union means the operator sees a code, not a stack trace.
 */
export type BaselineErrorCode =
  | "INVALID_COMPONENTS"
  | "MISSING_COMPONENT"
  | "NOT_A_DIRECTORY"
  | "NOT_A_REPO"
  | "NOT_A_REPO_ROOT"
  | "UNBORN_HEAD"
  | "GIT_FAILED"
  | "GIT_TIMEOUT"
  | "SYMLINK_OUTSIDE_ROOTS"
  | "SYMLINK_CYCLE"
  | "SYMLINK_TOO_DEEP"
  | "SYMLINK_UNRESOLVED"
  | "LINK_INTO_EXCLUDED"
  | "CANONICAL_SOURCE_MISSING"
  | "CANONICAL_SOURCE_MISMATCH"
  | "EXECUTABLE_FORBIDDEN"
  | "UNSUPPORTED_ENTRY"
  | "SYMLINK_FORBIDDEN"
  | "HARDLINK_FORBIDDEN"
  | "NOT_UTF8"
  | "TOO_LARGE"
  | "TOO_MANY_FILES"
  | "INVALID_PATH"
  | "SOURCE_CHANGED"
  | "READ_FAILED"
  | "NOT_MATERIALISABLE"

export class BaselineError extends Error {
  override readonly name = "BaselineError"
  readonly code: BaselineErrorCode
  readonly relPath: string | undefined

  constructor(
    code: BaselineErrorCode,
    message: string,
    options: { relPath?: string | undefined; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.relPath = options.relPath
  }
}
