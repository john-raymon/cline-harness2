import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  CanonicalJsonError,
  canonicalJson,
  canonicalSha256,
  sha256Hex,
} from "../src/domain/canonical.ts"

describe("canonicalJson", () => {
  it("sorts keys so insertion order cannot change the digest", () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } }
    const b = { c: { y: 2, z: 1 }, a: 2, b: 1 }
    assert.equal(canonicalJson(a), canonicalJson(b))
    assert.equal(canonicalJson(a), '{"a":2,"b":1,"c":{"y":2,"z":1}}')
  })

  it("preserves array order, which is meaningful", () => {
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]))
  })

  it("round-trips unicode without escaping it", () => {
    assert.equal(canonicalJson("café"), '"café"')
  })

  it("refuses values that cannot hash deterministically", () => {
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, () => 1]) {
      assert.throws(() => canonicalJson(value), CanonicalJsonError)
    }
    assert.throws(() => canonicalJson({ a: undefined }), CanonicalJsonError)
  })

  it("refuses non-plain objects, which would otherwise hash as an empty object", () => {
    assert.throws(() => canonicalJson(new Date(0)), CanonicalJsonError)
    assert.throws(() => canonicalJson(new Map([["a", 1]])), CanonicalJsonError)
    assert.throws(() => canonicalJson(new (class Widget {})()), CanonicalJsonError)
    assert.equal(canonicalJson(Object.create(null)), "{}")
  })
})

describe("hashing", () => {
  it("is stable for the same value and differs for different ones", () => {
    assert.equal(canonicalSha256({ a: 1 }), canonicalSha256({ a: 1 }))
    assert.notEqual(canonicalSha256({ a: 1 }), canonicalSha256({ a: 2 }))
    assert.equal(canonicalSha256({ a: 1 }).length, 64)
  })

  it("hashes raw bytes as well as text", () => {
    assert.equal(sha256Hex("abc"), sha256Hex(Buffer.from("abc", "utf8")))
    assert.equal(
      sha256Hex("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
  })
})
