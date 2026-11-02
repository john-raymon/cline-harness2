import { canonicalSha256 } from "../domain/canonical.ts"
import type { HarnessTree } from "../domain/schemas.ts"
import { PolicyError } from "./errors.ts"

/**
 * The tool inventory (c2): what the harness claims its tools *are*.
 *
 * Descriptions live in the tree as `tools/<name>.md`, so they are edited and versioned with the rest of
 * the harness instead of being hardcoded in the adapter. Two consequences that matter:
 *
 * - The inventory is derived, never supplied. A caller cannot hand in an inventory that disagrees with
 *   the tree the session is about to mount, because there is no parameter for one.
 * - The hash covers names *and* description bytes, so a prompt-level rewrite of a tool description
 *   changes `toolInventoryHash` and therefore the probe fingerprint. Two probes comparing different tool
 *   documentation are not a matched contrast.
 *
 * Names are lowercase-only on purpose. A tree can hold `tools/Foo.md` and `tools/foo.md` in memory, but
 * materialising it on APFS or NTFS would collide, so uppercase is refused rather than folded.
 */

export const TOOLS_DIR = "tools"
export const TOOL_INVENTORY_VERSION = 1
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
/** A tool description is prompt text; anything longer is a document, not a description. */
export const MAX_TOOL_DESCRIPTION_CHARS = 4000

export interface ToolEntry {
  readonly name: string
  readonly descriptionPath: string
  readonly descriptionSha256: string
}

export interface ToolInventory {
  readonly tools: readonly ToolEntry[]
  readonly hash: string
}

const EMPTY_INVENTORY_HASH = canonicalSha256({
  kind: "tool-inventory",
  version: TOOL_INVENTORY_VERSION,
  tools: [],
})

/** A tree with no `tools/` directory has an empty inventory, which is a real state, not an error. */
export function emptyToolInventory(): ToolInventory {
  return { tools: [], hash: EMPTY_INVENTORY_HASH }
}

function byName(left: ToolEntry, right: ToolEntry): number {
  return left.name === right.name ? 0 : left.name < right.name ? -1 : 1
}

function hashOf(tools: readonly ToolEntry[]): string {
  return canonicalSha256({
    kind: "tool-inventory",
    version: TOOL_INVENTORY_VERSION,
    // Sorted by name so the hash depends on the inventory, not on the order keys happen to be in.
    tools: tools.map((tool) => ({
      name: tool.name,
      descriptionPath: tool.descriptionPath,
      descriptionSha256: tool.descriptionSha256,
    })),
  })
}

/**
 * Read the inventory out of a tree.
 *
 * Everything under `tools/` must be exactly `<name>.md`: a nested directory or a stray `.txt` is refused
 * rather than ignored, because "the file exists but the tool is not registered" is the failure mode this
 * whole chunk exists to prevent.
 */
export function buildToolInventory(tree: HarnessTree): ToolInventory {
  const entries: ToolEntry[] = []

  for (const [destination, body] of Object.entries(tree)) {
    if (destination !== TOOLS_DIR && !destination.startsWith(`${TOOLS_DIR}/`)) continue
    if (destination === TOOLS_DIR) {
      throw new PolicyError(
        "TOOL_INVENTORY_INVALID",
        `${TOOLS_DIR} is a file; the inventory expects ${TOOLS_DIR}/<name>.md entries`,
      )
    }

    const relative = destination.slice(TOOLS_DIR.length + 1)
    if (relative.includes("/")) {
      throw new PolicyError(
        "TOOL_INVENTORY_INVALID",
        `${destination} is nested; a tool description must be exactly ${TOOLS_DIR}/<name>.md`,
      )
    }
    if (!relative.endsWith(".md")) {
      throw new PolicyError(
        "TOOL_INVENTORY_INVALID",
        `${destination} is not a .md file; a tool description is prompt text and nothing else lives here`,
      )
    }

    const name = relative.slice(0, -".md".length)
    if (!TOOL_NAME_PATTERN.test(name)) {
      throw new PolicyError(
        "TOOL_NAME_INVALID",
        `tool ${JSON.stringify(name)} from ${destination} is not a usable tool name: it must match ` +
          `${String(TOOL_NAME_PATTERN)}, which is lowercase only so it survives a case-insensitive ` +
          "file system",
      )
    }
    if (body.trim().length === 0) {
      throw new PolicyError(
        "TOOL_DESCRIPTION_EMPTY",
        `${destination} is empty; a tool with no description cannot be chosen by a model`,
      )
    }
    if (body.length > MAX_TOOL_DESCRIPTION_CHARS) {
      throw new PolicyError(
        "TOOL_INVENTORY_INVALID",
        `${destination} is ${body.length} characters; a tool description is capped at ` +
          `${MAX_TOOL_DESCRIPTION_CHARS} so the inventory stays a prompt and not a document`,
      )
    }

    entries.push({ name, descriptionPath: destination, descriptionSha256: canonicalSha256(body) })
  }

  if (entries.length === 0) return emptyToolInventory()
  // Sorted once, here, so every consumer (hash, record, prompt) sees the same order.
  const tools = [...entries].sort(byName)
  return { tools, hash: hashOf(tools) }
}
