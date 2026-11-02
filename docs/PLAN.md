# PLAN — 21 chunks

The order work lands in. Every chunk is isolated, verifiable on its own, and committed before the
next one starts. **Chunks 1–6 are operator-confirmed; 7–21 are reconstructed from the Phase 5
architecture and must be re-confirmed before each is entered.** Update the status column here at the
end of every chunk so scope survives a context reset.

| # | Status | Chunk | Deliverable | Gate |
| --- | --- | --- | --- | --- |
| 1 | done `bffadef` | Foundation | `tsconfig`, `package.json`, `src/domain/schemas.ts`, `src/domain/canonical.ts`, `src/config.ts`, `spikes/`, `docs/ADAPTER.md`, first test suite | SDK spike evidence in `.tmp/spike-evidence.json` |
| 2 | done `280fbd9` | Config migration | provider alias + `baseUrl` + `arbitration`, credential chain with provenance, retired-env fatal, fingerprint v2 | `pnpm typecheck`, 68 tests, `pnpm spike:sdk` exit 0 |
| 3 | done `1e732af` | Harness tree on disk | materialise a `HarnessTree` into a run directory and read it back; `TreePatch` gains deletion; this file | round-trips, deletion, containment, collisions |
| 4 | impl ✓ | Baseline snapshot `e_0` | capture a target repo into a tree + git sha + baseline fingerprint | baseline fingerprint is complete and re-derivable; the probe fingerprint is composed in Chunks 7–8 |
| 5 | impl ✓ | Adapter session bootstrap | first chunk that talks to `ClineCore`: build a session from a materialised tree (provider, compiled prompt, tools) | session starts and one turn completes — proven live, in the default `pnpm test` |
| 6 | impl ✓ | Ledger + artifact store | 4k/3k execution/improvement accounting, JSONL run ledger, probe record persistence | counts are exact and replayable |
| 7 | draft | Tool policy + inventory (c2) | tool descriptions as tree files, allow/deny policy set, `toolInventoryHash` | policy actually gates a call |
| 8 | draft | Prompt compiler (c0/c1) | assemble tree files into the compiled prompt; `compiledPromptHash` | hash changes iff the tree changes |
| 9 | draft | Skills mount (c6) | `<cwd>/.cline/skills/<name>/SKILL.md` visibility and its tool-entry budget | costs a tool entry, not file bytes |
| 10 | draft | Plugin + hooks (c8) | guard plugin via `extensions: [obj]`, hooks that record evidence | hook fires and effect is observable |
| 11 | draft | Subagent orchestration | child `ClineCore` on the same cwd, excluded from the 4k/3k ledger, contract hooks installed | child budget never counted |
| 12 | draft | T4 detector | measure context, apply `tail < target < b1 < b2`, decide stub vs summarise | thresholds trigger at the right counts |
| 13 | draft | T4 compaction executor | summarise to target, preserve the verbatim tail, `overflow_recovery` residual logged | target met, tail intact |
| 14 | draft | Oracle clients | gemini + astra behind Improver/Composer/Selector/Reflector roles, raw context in every call | one real call per role |
| 15 | draft | Dual-oracle arbitration | compare oracle outputs, `off` by default, `probe` outside the ledger | disagreement is surfaced, not averaged |
| 16 | draft | Improver loop | propose `e_{k+1}` from `e_k` evidence | proposals are patches, not rewrites |
| 17 | draft | Selector + Reflector | matched-contrast probe (fingerprint must agree), reflections from failures | unequal probes are refused |
| 18 | draft | Lesson library | capture lessons, dedupe, cap, feed `LongTermMEMORY.md` | a duplicate lesson is not re-added |
| 19 | draft | Budget + stop conditions | enforce 4k executions / 3k improvements, halting rules | run stops exactly on budget |
| 20 | draft | CLI | `src/cli.ts` + `bin`, argv parsing, exit codes, `--help` from `CONFIG_KEYS` | help text cannot drift from the table |
| 21 | draft | End-to-end | full run against a real model, docs finalisation, verification script | one honest end-to-end result |

## Standing rules for every chunk

- `docs/ADAPTER.md` is the authority on what the SDK actually does; a claim marked `unverified`
  (today: `B4.compaction`) blocks any chunk that depends on it.
- A chunk that cannot be verified is reported as unverified, never described as working.
- `EXPERIENCE.md` gets an entry only for traps that cost real time.
