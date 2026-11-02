import { constants, type Stats } from "node:fs"
import { open, type FileHandle } from "node:fs/promises"

import { sha256Hex } from "../domain/canonical.ts"

/**
 * One capped, symlink-refusing file reader shared by every layer that puts harness bytes in memory.
 *
 * It lives below both the tree store (which reads directories it owns) and the baseline capture
 * (which reads a repository it does not own), so the security-relevant details exist once:
 *
 * - `O_NOFOLLOW` makes the *final* component of the path fail closed if it was swapped for a symlink
 *   between the caller's `lstat` and this `open`. It says nothing about ancestor directories; a
 *   caller that cares about ancestors resolves them itself.
 * - `fstat` on the open descriptor, not `stat` on the path, so the metadata describes the bytes that
 *   are actually being read.
 * - the read loops to EOF because a single `read` may return a short count, and allocation stays
 *   bounded by a 64 KiB chunk even when the file grows after the size check.
 * - decoding is fatal and keeps a leading BOM, because a silent `U+FFFD` or a stripped BOM changes
 *   the bytes and therefore every hash taken over them.
 *
 * Errors carry the same codes the tree store published before this module existed, so callers can
 * translate them into their own error type without rewriting messages.
 */

export type ReadErrorCode =
  | "READ_FAILED"
  | "SYMLINK_FORBIDDEN"
  | "UNSUPPORTED_ENTRY"
  | "HARDLINK_FORBIDDEN"
  | "TOO_LARGE"
  | "NOT_UTF8"

export class ReadError extends Error {
  override readonly name = "ReadError"
  readonly code: ReadErrorCode
  readonly relPath: string

  constructor(
    code: ReadErrorCode,
    message: string,
    options: { relPath: string; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.relPath = options.relPath
  }
}

/** Largest single allocation while reading a file; the caller's cap still bounds the total. */
export const READ_CHUNK_BYTES = 64 * 1024

/**
 * `ignoreBOM: true` keeps a leading BOM as `U+FEFF` instead of swallowing it.
 *
 * The default (`false`) strips it, so a file written with a BOM would come back one byte shorter and
 * every hash over it would change. `fatal: true` turns malformed bytes into a throw instead of a
 * silent `U+FFFD`.
 */
export const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** Identity of the file that was actually read, taken from the descriptor rather than the path. */
export interface FileIdentity {
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
}

export function identityOf(info: Stats): FileIdentity {
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs }
}

export function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  )
}

export interface ReadCappedTextOptions {
  /** Key or path used in messages; this reader never interprets it. */
  readonly relPath: string
  readonly maxBytes: number
  /**
   * Whether a file with more than one link may be read.
   *
   * A scratch harness directory owns its files, so an extra link is an alias to bytes that may live
   * outside it — the tree store refuses those. A repository legitimately hardlinks (`pnpm` does it
   * throughout `node_modules`), so capture reads them and records the fact instead.
   */
  readonly allowHardlink?: boolean
}

export interface ReadCappedTextResult {
  readonly body: string
  readonly bytes: number
  /** Link count of the descriptor that was read; callers use it for provenance, never for hashing. */
  readonly nlink: number
  /** SHA-256 of the bytes on disk, taken before decoding so it cannot drift from a re-encode. */
  readonly sha256: string
  /** Identity of the descriptor, so a caller can compare it with the `lstat` it validated. */
  readonly identity: FileIdentity
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null | undefined)?.code
}

async function statDescriptor(handle: FileHandle, relPath: string): Promise<Stats> {
  try {
    return await handle.stat()
  } catch (error) {
    throw new ReadError("READ_FAILED", `could not inspect the handle for ${relPath}`, {
      relPath,
      cause: error,
    })
  }
}

export async function readCappedText(
  absolute: string,
  options: ReadCappedTextOptions,
): Promise<ReadCappedTextResult> {
  const { relPath, maxBytes } = options
  const allowHardlink = options.allowHardlink ?? false

  let handle: FileHandle
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    // ELOOP is what the kernel reports when O_NOFOLLOW meets a symlink: the path changed under us.
    if (errorCode(error) === "ELOOP") {
      throw new ReadError("SYMLINK_FORBIDDEN", `${relPath} is a symlink; refusing to read through it`, {
        relPath,
        cause: error,
      })
    }
    throw new ReadError("READ_FAILED", `could not open ${relPath}`, { relPath, cause: error })
  }

  let primary: unknown
  try {
    const info = await statDescriptor(handle, relPath)
    if (!info.isFile()) {
      throw new ReadError("UNSUPPORTED_ENTRY", `${relPath} is not a regular file`, { relPath })
    }
    if (!allowHardlink && info.nlink > 1) {
      throw new ReadError(
        "HARDLINK_FORBIDDEN",
        `${relPath} has ${info.nlink} hard links; a harness tree contains single-link files only`,
        { relPath },
      )
    }
    if (info.size > maxBytes) {
      throw new ReadError(
        "TOO_LARGE",
        `${relPath} is ${info.size} bytes, over the ${maxBytes}-byte file limit`,
        { relPath },
      )
    }

    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const room = maxBytes + 1 - total
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, room))
      let bytesRead: number
      try {
        ;({ bytesRead } = await handle.read(chunk, 0, chunk.length, total))
      } catch (error) {
        throw new ReadError("READ_FAILED", `could not read ${relPath}`, { relPath, cause: error })
      }
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes) {
        throw new ReadError(
          "TOO_LARGE",
          `${relPath} grew past the ${maxBytes}-byte file limit while being read`,
          { relPath },
        )
      }
      chunks.push(chunk.subarray(0, bytesRead))
    }

    const bytes = Buffer.concat(chunks, total)
    let body: string
    try {
      body = UTF8.decode(bytes)
    } catch (error) {
      throw new ReadError("NOT_UTF8", `${relPath} is not valid UTF-8`, { relPath, cause: error })
    }
    return {
      body,
      bytes: total,
      nlink: info.nlink,
      sha256: sha256Hex(bytes),
      identity: identityOf(info),
    }
  } catch (error) {
    primary = error
    throw error
  } finally {
    try {
      await handle.close()
    } catch (closeError) {
      // A close failure must never mask the reason the read failed in the first place.
      if (primary === undefined) {
        throw new ReadError("READ_FAILED", `could not close ${relPath}`, {
          relPath,
          cause: closeError,
        })
      }
    }
  }
}
