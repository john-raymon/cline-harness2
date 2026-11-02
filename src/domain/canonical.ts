import { createHash } from "node:crypto"

/**
 * JSON values that survive a canonical round-trip.
 *
 * `undefined`, `NaN`, `Infinity`, functions and symbols are deliberately excluded: a value that
 * cannot be serialised deterministically cannot be hashed deterministically, and a hash that
 * silently changes is worse than a loud failure here.
 */
export type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json }

export class CanonicalJsonError extends Error {
  override readonly name = "CanonicalJsonError"
}

/**
 * Serialise a value to canonical JSON: object keys sorted by code unit, no whitespace, UTF-8
 * output left unescaped apart from what JSON requires.
 *
 * Two runs that agree on the value produce byte-identical output, which is what makes the probe
 * fingerprint and the frozen oracle artifact comparable.
 */
export function canonicalJson(value: unknown): string {
  const out: string[] = []
  write(value, out, "$")
  return out.join("")
}

function write(value: unknown, out: string[], at: string): void {
  if (value === null) {
    out.push("null")
    return
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false")
      return
    case "string":
      out.push(JSON.stringify(value))
      return
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`${at}: ${String(value)} is not representable in canonical JSON`)
      }
      out.push(JSON.stringify(value))
      return
    case "object":
      break
    default:
      throw new CanonicalJsonError(`${at}: ${typeof value} is not representable in canonical JSON`)
  }
  if (Array.isArray(value)) {
    out.push("[")
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out.push(",")
      write(value[i], out, `${at}[${i}]`)
    }
    out.push("]")
    return
  }
  const record = value as Record<string, unknown>
  const prototype: unknown = Object.getPrototypeOf(record)
  if (prototype !== Object.prototype && prototype !== null) {
    const name = (record.constructor as { name?: string } | undefined)?.name ?? "unknown"
    throw new CanonicalJsonError(
      `${at}: only plain objects are representable in canonical JSON (got ${name}); ` +
        "Date, Map and class instances serialise as {} and would hash as identical",
    )
  }
  const keys = Object.keys(record).sort()
  out.push("{")
  let first = true
  for (const key of keys) {
    const item = record[key]
    if (item === undefined) {
      throw new CanonicalJsonError(`${at}.${key}: undefined is not representable in canonical JSON`)
    }
    if (!first) out.push(",")
    first = false
    out.push(JSON.stringify(key), ":")
    write(item, out, `${at}.${key}`)
  }
  out.push("}")
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of `input`. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex")
}

/** SHA-256 of the canonical serialisation of `value`. */
export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}
