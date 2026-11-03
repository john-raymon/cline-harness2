# Adapter decision record

Everything the later chunks are allowed to assume about `@cline/sdk@0.2.0` on Node 23.5, and the
evidence behind it.

Regenerate with `pnpm spike:sdk`. Raw output lands in `.tmp/spike-evidence.json` (gitignored); this
file is the human-readable mirror of that run. If the two ever disagree, the JSON wins and this file
is stale.

## How to read a claim

- **status** — `verified` means the behaviour was observed on a live `ClineCore` session.
  `unverified` means it was not established, and no dependent chunk may assume it.
- **method** — `core-scripted` (live Core session against a local scripted provider), `core-live`
  (live paid provider), `agent` (plain `Agent` runtime), `static` (read from `.d.ts` / dist).
- Evidence from `agent` or `static` is **never** promoted to Core verification. A claim that failed
  to establish stays `unverified` even though the harness around it ran fine.
- Each claim carries its own predicate in code (`established`), so a claim whose behaviour failed
  reports `unverified` even when the run itself completed without throwing. A positive observation
  without a negative control is a correlation, not evidence — B1 therefore runs an ambient-discovery
  control and an outside-`cwd` control.

No claim here needed credentials: `spikes/fake-provider.ts` serves an OpenAI-compatible
`/v1/chat/completions` endpoint (JSON and SSE) on loopback, and `ClineCore` is pointed at it with
`providerId: "openai-compatible"` plus `baseUrl`.

## Claims

| id | status | method | observed |
| --- | --- | --- | --- |
| B1.skills | verified | core-scripted | `<cwd>/.cline/skills/<name>/SKILL.md` → skill name visible and the built-in `skills` tool present. Negative controls: a `skills/` directory **outside** `cwd` → invisible; **no skill on disk at all** (ambient-discovery control) → invisible. An **empty** `config.skills` still shows the skill, so that list is not the visibility gate. |
| B2.plugin | verified | core-scripted | `pluginPaths: [file]` → tool not registered. `pluginPaths: [directory]` → tool not registered. `extensions: [pluginObject]` → **tool and rule both registered**. |
| B3.messageBuilder | verified | core-scripted | `build(messages)` receives an array of provider-shaped messages (first message keys `role,content`), builders run in registration order (B observed A's edit), and A's injected message reached the provider. |
| B5.hooks | verified | core-scripted | `beforeRun`/`afterRun`/`beforeTool`/`afterTool` each fired once, `onEvent` fired 18×, and `beforeTool` returning `{skip:true}` **prevented the file side effect**. |
| B6.subagent | verified | core-scripted | An `extraTools` entry that created its own `ClineCore` and called `start()` produced a child session on the same `cwd`, returning `"child-done"`. |
| B4.compaction | **unverified** | core-scripted | `compaction: {enabled:true, compact}` was accepted, but `compact` was called 0 times because overflow was never induced. |
| B7.sdkTypes | verified | static | `{ providerId }` compiles into `CoreSessionConfig`; `{ name }` compiles into `AgentPlugin`; `ClineCore.start()` resolves to `unknown`. A control type (`{a:number}`) still rejects `{}`, so this is the declarations, not the compiler. |

Dependency note: `skipLibCheck: true` is **mandatory** — the `@cline/*` bundles use extensionless
relative imports that fail under `nodenext` (TS2834). That setting is what lets B7's degradation go
unreported, which is why B7 is recorded rather than worked around.

## What this changes in the adapter plan

**c6 (skills) — mount path corrected, and cheaper than assumed.** Skills live at
`<cwd>/.cline/skills/<name>/SKILL.md`. Two corrections to the earlier plan:
`config.skills` is *not* what makes a skill visible (a discovered skill appeared with the list
empty), so the harness scopes c6 by controlling which directories exist, not by filtering names.
And the skill body is **not inlined** into the request — the built-in `skills` tool loads it on
demand. Consequence for the 24k assertion: c6 contributes a tool entry, not its file body, to the
always-on budget.

**c8 (plugin) — `pluginPaths` is out, `extensions` is in.** Neither a file path nor a directory
path registered anything; injecting the imported object registered both a tool and a rule. So the
compiled `CoreSessionConfig` drops `pluginPaths` and passes `extensions: [pluginObject]`, which
means the harness must import the candidate plugin itself. `pluginPaths` silently accepting a bad
path is also why c8 needs a validation-only load: after setup, assert the declared tools actually
appear, because a manifest that over-claims is accepted without complaint.

**T4 soft stubs (message builder) — confirmed.** The builder receives conversation messages only
(first build saw a single `{role,content}` message; the system prompt is not in the array), runs in
registration order, and its output reaches the provider. This matches the split we need: T4 rewrites
the message stream while c1..c4 sit untouched in the system prompt.

**Contract enforcement — `beforeTool` gates, but `afterTool` lies.** `{skip:true}` genuinely
prevented the side effect, so it is usable as the primary gate. However `afterTool` fired even on
the skipped call, so "afterTool ran" must never be treated as proof that a tool executed. The
post-run `git status` taint check stays load-bearing, and `onEvent` (18 events for a 2-turn session)
is a viable trajectory source.

**c5 subagents — possible, with an enforcement hole to close.** A child `ClineCore` on the same
`cwd` works. It is a separate instance with its own session store, so two things must be handled
explicitly rather than assumed: child sessions are excluded from the `4k`/`3k` ledger, and the
contract plugin must be installed on the *child's* config too — otherwise a subagent escapes the
parent's `beforeTool` gate entirely.

**T4 hard summarisation — residual stands.** `compact` was accepted but never invoked, so whether a
supplied strategy also covers `overflow_recovery` remains unproven. No chunk may claim ownership of
the overflow path.

## Deviations from the Phase 5 chunk table

- **No `bin` and no `src/cli.ts` in Chunk 1.** The bin needs argv parsing and an exit-code contract
  that belong with Chunk 20; a `harness2` script pointing at a missing file is worse than none.
- **`@types/node@26.6.6` against a Node 23.5 runtime** is retained rather than pinned in this chunk.
  It is a type-only mismatch; the spike runs under `tsx`, which does not typecheck at runtime.
- **`docs/ADAPTER.md` is a mirror, not a source.** It is regenerated by hand from
  `.tmp/spike-evidence.json`; the spike itself writes only inside `.tmp/`.

## Accepted decisions

These were signed off by the operator; none is provisional any more.

1. **Solver triple.** Provider `openai` resolves to the SDK id `openai-compatible` (plain HTTP against
   an OpenAI-compatible endpoint). Default endpoint `https://api.synthetic.new/openai/v1`, default
   model `hf:deepseek-ai/DeepSeek-V4.1-Flash-1017`; `hf:moonshotai/Kimi-K3` is the documented
   alternative. `PROVIDER_ALIASES` is the whole accepted set — an unknown name is a `ConfigError`
   instead of a silent fallback, because a different SDK provider id selects a different client and a
   different capability set. `openai-native` is deliberately *not* an alias: that is the SDK's own
   client, not an OpenAI-compatible endpoint.
2. **Credentials.** `--api-key` wins, then `SYNTHETIC_API_KEY`, then `SOLVER_API_KEY`, then
   `OPENAI_API_KEY`. `loadConfig` reports `apiKeySource` (a name, never the value) and warns when two
   or more of those variables disagree, because a stale variable is otherwise invisible until the
   wrong account answers. All sources are redacted from every error message, including the ones that
   lost precedence.
3. **`--arbitration probe` is off by default.** Off keeps the strict `4k` execution identity; `probe`
   spends extra arbitration attempts outside the ledger.
4. **T4 thresholds `120_000` / `160_000` / `105_000` / `24_000` are approved**, so defaulting them is
   no longer news and `loadConfig` no longer warns about it. The chain is still validated as strictly
   increasing.
5. **Retired environment variables fail the run.** `HARNESS2_PROVIDER`, `HARNESS2_MODEL`,
   `HARNESS2_API_KEY` and `HARNESS2_BASE_URL` were replaced by the `SOLVER_*` names; supplying one
   raises a `ConfigError` naming its replacement, even when the new name is also set. Silently
   ignoring a stale variable would run a different model than the operator asked for.

## Probe fingerprint v3

`PROBE_FINGERPRINT_VERSION` is `3`. Version 2 added `baseUrl` (a run against a different endpoint is not
a matched contrast, and the stored value is normalised by `baseUrlSchema` so two spellings of one endpoint
cannot hash differently). Version 3 adds `treeSha` — see the Chunk 8 section for why the *whole* frozen
tree belongs in the record and not only the parts a session reads. Older records are rejected rather than
upgraded: they lack a field, so "upgrading" would assert something nobody verified.

What this file may assert is unchanged: `B4.compaction` stays `unverified`, and the decisions above
are operator approvals, not evidence regenerated by `pnpm spike:sdk`.

Two migration traps to keep in mind. Retired-variable detection runs *before* CLI and `SOLVER_*`
precedence, so a stale `export HARNESS2_MODEL=` in a shell profile blocks every run in that shell
until it is removed — that is the intended fail-closed behaviour, not a bug to relax. And whatever
reads fingerprint records must translate the literal mismatch into "this record predates v3, re-probe"
rather than surfacing a raw `Invalid literal value, expected 3`; that reader does not exist yet, so the
next chunk that touches probe records owns the message.

## Gates for later chunks

- Any chunk touching c5, c6, c8, T4, or contract enforcement must start from this file.
- A claim marked `unverified` (today: `B4.compaction`) blocks any chunk that depends on it.
- Changing `@cline/sdk` version invalidates **B2, B3, B5, B6, B7** at minimum; re-run
  `pnpm spike:sdk` and diff before trusting the adapter again.
- `pnpm spike:sdk` exits **0 by design**, because a claim that fails to establish is a finding, not
  a crash. That makes it unusable as a CI gate on its own. A run that depends on claims must read
  `.tmp/spike-evidence.json` and assert: the claim ids it needs are present, each is `verified`, and
  `sdkVersion` matches the installed SDK. Anything less turns "unverified" into "assumed".

## Harness path contract (Chunk 3)

`relPathSchema` is the single gate for every key in a `HarnessTree`, and Chunk 3 tightened it because
that is the first chunk that puts those names on a disk. It now also rejects Windows-illegal
punctuation (`< > : " | ? *`), superscript reserved device names (`COM¹`, `LPT²`), and any string that
is not well-formed UTF-16 — a lone surrogate is written as `U+FFFD`, so a path or body containing one
cannot round-trip and cannot be hashed honestly. `harnessTreeSchema` values use the same well-formed
check, because the corruption happens to bodies too.

A tree is additionally rejected before any write when it cannot exist in one directory: a key that is
also a directory prefix of another key (`a` and `a/b`), or two keys that fold together on a
case-insensitive volume (`SystemPrompt.md`/`systemprompt.md`, and `A/x` with `a/y`). Checks are pure
and run before the first byte is written, so a bad tree leaves no partial directory.

This is deliberately harness-tree-only. `notes:2024.md` is a legal POSIX filename and an illegal tree
key, so a repository is never read through `readTree`; Chunk 4 captures its declared components with its
own reader and keeps `.git` and `node_modules` out of the walk entirely (see the section below).

## Baseline capture provenance (Chunk 4)

`e_0` is not the repository. It is the *harness* of the repository: a whitelist of declared components
(`.clinerules`, `EXPERIENCE.md`, `.cline/skills`), captured read-only, plus git metadata. `node_modules/`
and `.git/` are never entered because they are not components; anything skipped inside a component is
reported in `excluded` with a reason rather than dropped. `scripts/verify-helpers` is deliberately out of
the manifest until materialisation can carry a mode: capture refuses executables
(`EXECUTABLE_FORBIDDEN`) instead of writing them back as `0o644`.

**A tree holds bodies, not links.** A symlinked rule file is read through, so `materialiseTree` receives a
regular file, and the link itself is recorded as provenance: `origin` says `symlink` with the hop count and
the resolved root, and `canonical` records the declared SSOT counterpart with its own digest and an
`identical` flag. A generated copy and its canonical source are **not** normalised into agreement — they
are different effective inputs, they hash differently, and the drift stays visible (`identical: false`).
Declared mappings are per destination; there is no directory-prefix grant, because a link inside the SSOT
must not be able to redirect a body to a file nobody named.

**Containment is `path.relative` over resolved paths.** Both roots are `realpath`ed, and
`path.relative(root, target)` is rejected when it is empty, `..`, `../…` or absolute — `startsWith(root)`
would accept `/root-evil`. A link target is resolved **component by component in filesystem order**, not
with `path.resolve`: for `alias/../rules.md` where `alias` points at `real/subdir`, the kernel reaches
`real/rules.md` while lexical normalisation picks `rules.md` beside the link. `..` pops the *resolved*
stack, hops are counted (only inside an authorised root, so a host alias like macOS `/var` → `/private/var`
cannot inflate the count), and a cycle is a named error instead of `ELOOP`. Cycle detection tracks the
links whose expansion is still in progress — a revisit of an *active* link is the cycle — because a
total-expansion backstop is the only other way to stop `a -> a/b`, which deepens the path on every pass.
Component paths are walked segment by segment, so a symlinked ancestor (`.cline` in `.cline/skills`) is
authorised per hop instead of being silently followed by `realpath`. A trailing `/` or `/.` still demands
a directory, so `file.md/` is `ENOTDIR` rather than the file.

**Exclusions hold at every depth, on both sides.** A link is not a way around the prune: a resolved target
inside `node_modules`, `.git`, `.tmp` or a `.DS_Store` raises `LINK_INTO_EXCLUDED`, whether it lands in the
repository or in the SSOT, and a component path may not carry an excluded segment at any position.

**A declared source names a file, not a link.** If `folder-x.md` is itself a symlink, following it would
let the declaration authorise whatever that link happens to point at, so capture refuses it
(`CANONICAL_SOURCE_MISSING`) rather than resolving through. The parent directory is still resolved, because
that is an OS alias, not a declaration.

**Every hashed byte is a proven byte.** Reads that contribute to the fingerprint (`readStable`) compare the
`lstat` before opening, the descriptor identity from `fstat`, and the `lstat` after closing; a mismatch —
including an atomic same-size replacement — is `SOURCE_CHANGED`. The lockfile gets the same treatment under
its own 64 MiB cap, because a digest over half of one version and half of another is worse than an error.

**The fingerprint is baseline-only.** `baselineFingerprintSchema` covers `manifestSha`, `baseSha`,
`isDirty`, `dependencyLockHash`, `treeSha` and `ssotRulesHash`; `baselineSha` hashes an explicit projection
of it. `probeFingerprintSchema` is untouched: `toolInventoryHash`, `compiledPromptHash`, `toolPolicySet` and
`slices` belong to Chunks 7–8, and composing the probe fingerprint from this one is their job.
`dependencyLockHash` is `string | null`, where `null` means "no lockfile" — a different state from an empty
one, and composition must reject it rather than substitute a digest.

## Session bootstrap (Chunk 5)

`src/adapter/session.ts` is the only place that starts a real `ClineCore` session. What it does, in the
order the code does it, and why:

1. **Credentials first.** A missing key is an `API_KEY_MISSING` refusal, not a session that fails later
   with a provider error. The key goes to the SDK and is never recorded; the record carries
   `apiKeySource` (a name) instead.
2. **Claim gate before the filesystem.** `requiredClaimsFor(tree)` requires `B1.skills` exactly when the
   tree ships `.cline/skills/**`, because mounting the tree as `cwd` is what makes the built-in skills
   tool appear — the claim's own limitation says an allowlist is not the gate. An empty requirement
   short-circuits without reading `.tmp/spike-evidence.json`, so a machine that never ran the spike can
   still bootstrap a skills-free tree. The remedy in every refusal is `pnpm spike:sdk`.
3. **Run directory, then the tree.** `<root>/<runId>/harness/` is claimed exclusively and materialised
   from the captured tree. The id is validated as a single path component because Chunk 20 will pass it
   from argv. A materialisation failure removes the directory this call created; a failure *after* that
   leaves it on disk deliberately, because a run directory is the evidence of what was attempted.
4. **The session is local and pre-identified.** `backendMode: "local"` only: a hub or remote runtime
   executes elsewhere and none of the spike evidence describes it. `sessionId` is set to the run id
   *before* starting, because `StartSessionResult.sessionId` only exists once `start()` resolves — and
   `abort()` is needed precisely when it never does.
5. **`cwd` is the materialised copy — a starting directory, not a fence.** `cwd` and `workspaceRoot`
   both point at `<runId>/harness`, so a turn *begins* there and a relative path cannot escape it. That
   is not containment: once a tool is allowed, its arguments are the tool's business, and `run_commands`
   with an absolute path reaches anywhere the process can. Chunk 7 gates tool *names*; where an allowed
   tool may act is a sandbox question no chunk has answered. See the containment note in the debt list.
6. **Tools enabled, then denied.** `enableTools: true` with a default `beforeTool` hook returning
   `{ skip: true }` for every call. `B5.hooks` established that `skip` really prevents the side effect,
   so this is a gate rather than a hint. `yolo: true` only removes the approval prompt a headless run
   could never answer; with every call skipped it is never reached.
7. **`checkpoint: { enabled: false }` is pinned.** The SDK defaults it off, but a future default flip
   would begin taking git stash refs in the session workspace, which is not something to inherit.
8. **Teardown is ordered and bounded.** Unsubscribe, then `dispose()`, both `abort()` and `dispose()`
   raced against a teardown deadline so a runtime that never releases cannot turn a bounded turn into
   an unbounded epilogue. A dispose failure after a successful turn is `SESSION_DISPOSE_FAILED` — a
   possibly-running agent is worse than an unreturned record — while a dispose failure after a failed
   turn is swallowed so it cannot hide the real error.
9. **Caller-supplied delays are validated.** A `timeoutMs` of `0`, `NaN` or more than `2**31 - 1` is
   refused with `TIMEOUT_INVALID` rather than handed to `setTimeout`, which silently turns every one of
   those into a ~1ms timer and would abort the session on the next tick.

`SessionBootstrapRecord` is the handoff to Chunk 6: `manifestPath`/`messagesPath` point at the SDK's own
transcript, `eventTypes` is deduped and capped at 128 with `eventCount` keeping the true total, and
`promptSource` is already an enum so the prompt compiler takes over without a schema change. Nothing is
persisted; the only durable effect of this chunk is the run directory.

Verification is live, not mocked: the test spawns `test/support/live-session-child.ts`, which redirects
`HOME`/`XDG_DATA_HOME`/`USERPROFILE`/`APPDATA` into a temporary directory *before* importing the SDK (it
latches its SQLite location at import), runs one turn against `test/support/fake-provider.ts`, and prints
one JSON line that the parent validates with the same zod schema the adapter returns.

## Ledger and artifact store (Chunk 6)

`<runDir>/ledger.jsonl` is the run's record and `<runDir>/artifacts/probe.json` is its probe evidence.
The harness directory is untouched by both — `run-dir.ts` reserved it for the tree so that `readTree`
over it can never pick up run bookkeeping.

1. **One writer, one order.** `RunLedger.open` claims `<runDir>/ledger.lock` with `wx`; a second open is
   `LEDGER_LOCKED` rather than a race between two writers allocating the same `seq`. Appends run through
   an internal queue, so sequence allocation, the budget check, the dry-run and the write happen in one
   turn even when fifty callers append at once. Admission is checked when work is *submitted* and the
   queue is drained on close, so an append already accepted is never lost to a shutdown that started a
   microtask later; `close()` is one memoised teardown, so two shutdown paths cannot race over the lock.
2. **Counts move only on `*.finished`.** `4k` executions and `3k` improvements are derived from terminal
   events; `attempt.recorded` is the cost line (retries, schema repairs, oracle substitutions) and never
   touches them. `byStage` is reported in pipeline order so two equivalent runs summarise identically.
3. **Budget is reserved on `*.started`, and enforced again in replay.** Checking on finish would admit
   more work than the budget and then refuse to record it, stranding an operation that already spent
   tokens. The fifth start of a `4k` budget fails before the cost, and finishing admitted work is always
   allowed afterwards. Replay applies the same limit using the `k` recorded in `run.started`, so a file
   that was edited or written by an older build is refused rather than reported as a run that broke its
   own contract.
4. **The file never contains an event replay would refuse.** Every append dry-runs `replayLedger` over the
   whole history first, so a gapped `seq`, a duplicate id, an orphan attempt or a mismatched
   `run.finished` summary is rejected before any byte is written. A refused append leaves the file
   byte-identical.
5. **`run.finished` is terminal, single, and self-checking.** It carries the totals it was written from,
   and replay re-derives them from the events and refuses a disagreement; `completed` is refused while any
   operation is open, while `failed`/`halted` may record those ids honestly. Finishing is separate from
   `close()`, which only drains and releases the handle and lock.
6. **A torn tail is an error, not a lost line.** `readLedgerFile` refuses a file that does not end in a
   newline (`LEDGER_TRUNCATED`, with the line number) rather than dropping the half-written event — a run
   that lost its closing events must not look like a run that had fewer. A corrupt line *before* the tail
   is `LEDGER_CORRUPT` with its line number and byte offset.
7. **A writer that failed mid-append is poisoned.** It cannot know what reached the disk, so it refuses
   further work instead of appending a `seq` that may already exist.
8. **Probe artifacts are published once, claim-then-rename.** `rename` replaces silently, so an existence
   check alone would let two publishers both "win"; an exclusive `.probe.claim` turns "refuse to
   overwrite" into a decision. The returned digest is the digest of the file's bytes, verified by reading
   it back, and the record is written as canonical JSON so the same record always hashes the same.

The gate is met by `serves counts from the file, so what a reader sees is what a writer wrote`: a ledger
is built, finished, re-read from disk and replayed, and the replayed counts are deep-equal to the writer's.

## Tool policy and inventory (Chunk 7)

The inventory is the tree's claim about its own tools; the policy is the run's claim about what it will
use. Both are inputs to a fingerprint, so both are derived and normalised rather than accepted.

1. **Descriptions are tree files.** `tools/<name>.md`, exactly one level deep. The inventory is built from
   the tree the session is about to mount — there is no parameter for supplying one — and its hash covers
   each name plus the digest of its description bytes, so rewriting a description changes
   `toolInventoryHash`. A nested directory, a non-`.md` file, an empty body or a name that is not
   lowercase `[a-z][a-z0-9_]{0,63}` is refused before a run directory exists.
2. **Names are lowercase for a filesystem reason.** A tree can hold `tools/Foo.md` and `tools/foo.md` in
   memory; materialising that on APFS or NTFS would merge them. Uppercase is refused rather than folded,
   so the inventory on disk is the inventory that was written.
3. **A policy is checked against the inventory at parse time.** Naming a tool the tree does not define is
   `POLICY_UNKNOWN_TOOL`, not dead configuration; a name in both lists is `POLICY_CONFLICT`, not a
   precedence puzzle. Sorting and de-duplicating at parse time means one policy has exactly one
   fingerprint.
4. **Default is deny, and it says so.** `decide` refuses an unlisted tool, refuses an unnamed call, and
   refuses everything when there is no policy. An empty policy reports the same `default-deny` reason that
   `["default:deny"]` fingerprints, so the record cannot fingerprint one thing and report another.
5. **Names match exactly.** Trimming before comparison would let `" run_commands"` match an allowlist entry
   for `run_commands` — permitting a name nobody wrote. An exact-match miss is a refusal.
6. **The gate is the policy; there are no caller-supplied hooks.** `bootstrapSession` takes
   `toolPolicy`, builds `policyHooks`, and records what the gate decided. A caller who could pass arbitrary
   hooks could run a session whose record claims a policy it never installed, so that parameter is gone.
7. **`B5.hooks` is required unconditionally.** Every session installs a `beforeTool` gate — deny-all or a
   policy — and both rest on the claim that `{ skip: true }` really prevents the side effect. The claim gate
   therefore requires it for every run, and the live children write an evidence fixture for the SDK they
   actually loaded (`test/support/evidence-fixture.ts`), because `.tmp/spike-evidence.json` is gitignored
   and a fresh clone has none.
8. **Record version 2 for the policy.** `toolPolicySet`, `toolInventoryHash` and `toolDecisions` join the
   probe record. A record that omits the policy in force cannot be compared with another probe: "same
   result under different permissions" is not the same result. Decisions are capped at 64 and deliberately
   outside every hash — they are evidence of what happened, not identity.

The gate is met live, in the default `pnpm test`: a scripted provider asks for `run_commands` with a `touch`
on an absolute path outside the harness copy. Under `allow: [run_commands]` the file appears; under
`deny: [run_commands]` it does not, and the record carries the refusal. Both runs assert the harness tree is
unchanged, which is only true because the marker is written outside it.

## Prompt compiler and probe fingerprint (Chunk 8)

`src/adapter/prompt.ts` is gone. The bootstrap constant that proved a session could start is replaced by
`compilePrompt({ tree, task, allowedTools })`, and `PROMPT_SOURCES` is now `["compiled"]` — there is no
second producer to pick between, so a record cannot claim one.

**Slices, in this order, never the tree's.** `core` (generated: identity plus the allowed-tool line),
`rules` (`.clinerules/**`, sorted by path), `memory` (`EXPERIENCE.md`), `instructions`
(`systemprompt.md`). A slice with no files is omitted, not emitted empty, so a tree that lost a component
and one that never had it hash alike — they produce the same prompt. Every block is fenced with its own
path on both sides (`<<<path>>> … <<<end path>>>`), and a body containing a line that starts with `<<<`
is refused (`PROMPT_SLICE_INVALID`): without that, one rule file can close its own block and impersonate
the next, and the prompt would attribute text to a path that never held it.

**A slice digest covers the raw inputs, not just the rendered text.** Rendering terminates a body that
lacks a trailing newline, so `"rule"` and `"rule\n"` render byte-identical text. Hashing the rendered
text alone would mean a real edit to a rule file left `compiledPromptHash` unchanged; the digest
therefore covers `{slice, text, entries:[{path, body}]}` over the raw bodies.

**`compiledPromptHash` excludes the task; `promptSha256` includes it.** The fingerprint compares
harnesses, and the same `e_0` on a different task is the same harness — mixing the task in would make
every probe look like a fresh baseline. The ledger compares `promptSha256`, which is the one that has to
tell two turns apart.

**The always-on budget is 24,000 characters, not tokens.** No tokenizer ships with this harness, and a
tokenizer that disagrees with the provider's is worse than no measurement; at roughly four characters per
token the character cap is the stricter bound. `alwaysOnChars` is asserted equal to `systemPrompt.length`
before it is compared to the budget, so the number enforced is the number sent. This is a compiler limit,
not T4 headroom: T4 measures provider tokens over the whole context (Chunks 12–13).

**The fingerprint is composed in `bootstrapSession`, before anything is created.** `HarnessBaseline` now
carries `fingerprint: BaselineFingerprint`, and `verifyHarnessBaseline` refuses a tree whose `treeSha` is
not the pinned one and a `baselineSha` that is not the digest of the fingerprint — both values are
caller-supplied and both parse, so without the check a session can run harness A while recording harness
B. The tree is **snapshotted** at entry (`{...tree}`; values are strings) and the snapshot is what gets
verified, compiled, claimed and written: the caller's object is separated from the write by at least one
await, and re-reading it would let a mutation in that window run a harness the fingerprint does not
describe.

`treeSha` is in the fingerprint (v3) even though it is not prompt text and not a tool description. A
field that covers *everything capture froze* is the only thing that keeps a change nobody has a slice for
yet — a `.cline/skills/**` body today — from comparing equal to the harness it changed. It is deliberately
over-strict: losing a comparison is cheaper than recording two different harnesses as one.

`DEFAULT_COMPONENTS` gained `systemprompt.md` and `tools/`. A component capture never visits is a file the
compiler and the inventory cannot see, so a captured repository could otherwise never produce an
`instructions` slice or a tool inventory at all. `gitObjectIdSchema` is now shared between baseline
capture and `probeFingerprintSchema`, because the two disagreeing on 40 versus 64 hex characters meant a
faithfully captured SHA-256 baseline could not compose.

`reasoningEffort: "none"` and `thinking: false` are now genuinely sent in `sessionConfig` rather than
assumed, since the fingerprint records them; whether `@cline/core` honours either is not established by
any claim in this file.

## Skills mount (Chunk 9)

Gate: "costs a tool entry, not file bytes". `collectSkills` reads `.cline/skills/<name>/**`: a directory
holding a non-empty `SKILL.md`, with companions (`references/`, `scripts/`) allowed and folded into the
skill's identity — they are bytes the model can load on demand, so they belong to what the harness
mounted even though they never reach the prompt. A file directly under `.cline/skills/`, a directory
without `SKILL.md`, and an unusable name are all `SKILL_INVALID`, because each one is a mount the
operator believes in and the runtime ignores.

**A mounted skill is a zero-character slice.** It appears in `prompt.slices` with `text: ""`, the
`SKILL.md` paths in `paths`, and a digest over the definition body plus the companion paths — so a skill
edit moves `compiledPromptHash` and `probeFingerprintSha256` while `systemPrompt` and `alwaysOnChars` are
byte-identical. That is the gate stated as a test: three 30,000-character skill bodies compile under the
24,000-character budget, and the same bytes in a `systemprompt.md` fail with `PROMPT_TOO_LARGE`.

**One entry, never `skills.length`.** `declaredToolEntries` is the *union* of the inventory names and
`skills`, so forty skills cost one entry and a tree that already declares `tools/skills.md` is not charged
twice. `assertToolEntryBudget` (64) runs in `bootstrapSession` before anything is created, and the number
is recorded in the v3 record.

**A policy can now name the built-in.** `parseToolPolicy` takes `knownTools`, and the session passes
`["skills"]` when skills are mounted. Without it, Chunk 7's "a policy may only name tools the tree
defines" made `allow: ["skills"]` impossible — the inventory describes what the tree *declares*, and the
`skills` tool exists because a directory exists. The parameter is deliberately narrow: it names one
runtime built-in, it does not open the inventory.

**The live gate is `test/adapter-skills-gate.test.ts`**, one real session against a scripted provider: the
skill name reaches the request, the built-in `skills` tool is present, and the body's unique marker does
*not* appear. `verifyHarnessBaseline` runs before skills, inventory and budget checks, so drift is
reported as drift rather than as a derived complaint about the wrong harness.

## Contract plugin and hook evidence (Chunk 10)

`extensions: [obj]` is the loader, because `B2.plugin` established that `pluginPaths` registers nothing.
`src/plugin/contract.ts` builds one **fixed** plugin — name `harness2-contract`, tool `harness_contract`,
rule `harness2.contract` — and the session injects it. There is no plugin loader: a candidate pipeline needs
a trust model and an import sandbox, and neither exists yet.

**`createTool` is injected, never imported.** `src/plugin/contract.ts` has no `@cline/sdk` import, so the
module can be unit-tested and pre-flight never initialises SDK state. The plugin is built and validated
**before** `createCore`, because `createTool` is all it needs and a failing plugin must not leave an
undisposed runtime behind.

**The validation-only load is the only place an over-claim is visible.** `validateContractPlugin` requires
capabilities to equal exactly `["tools","rules"]`, runs `setup` against a recording stub, refuses an unnamed
or duplicate tool, an id-less or content-less or duplicate rule, and a declared-but-unregistered tool or
rule (`PLUGIN_TOOL_MISSING` / `PLUGIN_RULE_MISSING`). `B2` recorded that the SDK accepts an over-claiming
manifest silently; the live gate is what proves the runtime then accepted the real object.

**`afterTool` is counted, never believed.** `recordingHooks` wraps `policyHooks` and passes the gate's
verdict through unchanged — a recorder that normalised it would be a policy change hiding as instrumentation.
It counts each phase, and `afterToolOnSkipped` counts `afterTool` calls whose `beforeTool` was refused, which
is the documented lie from this file's contract section. Calls are paired by **identity**
(`toolCall.id`, `callId` or `toolCallId`), and a skip is consumed on first use, because a lingering key would
make the next allowed call look like a lie the runtime never told.

`B2.plugin` is now required unconditionally by the claim gate, alongside `B5.hooks`; record **v4** adds
`contractPlugin {name, tools, rules, ruleSha256}` and `hookEvidence`, and `declaredToolEntries` counts the
contract tool as one entry (unioned with the tree's `tools/` names, so a tree that already declares it is not
charged twice).

**Live gate: `test/adapter-plugin-gate.test.ts`.** One real session, policy denies `run_commands`, provider
scripted to `touch` a marker: the rule marker reaches the request, `harness_contract` is in `tools`, all four
phases fired, `events > 0`, the marker does not exist, and `afterToolOnSkipped >= 1`.

## Known debt carried forward

- **The tree store assumes it owns the directory.** `materialiseTree` claims a non-existent leaf with
  an exclusive `mkdir`, and `readTree` refuses a symlinked root, so writer and reader agree on who may
  be there. Portable Node path checks cannot defeat a *hostile concurrent writer* — `lstat`-then-open
  is always raceable and `O_NOFOLLOW` covers only the last component on Linux — so that ownership
  assumption, not the checks, is the real boundary. Real isolation belongs to the sandbox layer.
- **`TreePatch` deletion is resolved in Chunk 3, and there is deliberately no filesystem deleter.**
  `treePatchSchema` is `z.record(relPathSchema, z.string().nullable())`: `null` deletes, `""` writes an
  empty file, an omitted key inherits. Deletion is applied in memory and the result is materialised
  into a *new* directory, so no API takes an arbitrary path to delete. The only deletion in the store
  is rollback of a directory its own call created.
- **Tree-store rollback is verified by injection, not by observation.** The rollback path (fail after
  `mkdir`, settle every in-flight write, then remove only the directory the call created) is exercised
  by stubbing `writeFile`/`rm` through the builtin export table (`syncBuiltinESMExports()`): one test
  asserts a slow sibling write finishes *before* cleanup runs, another asserts a cleanup failure lands
  on `cleanupError` without replacing the primary cause. A real write can of course still fail (disk
  full, `EACCES`, I/O error); injection is used because a schema-valid tree cannot be made to fail
  deterministically on demand.
- **The visited-entry cap is reachable, via shared deep prefixes.** 1024 files shaped `d{i}/a/b/c/f`
  imply 4096 distinct directories, so `files + directories` (5120) passes `maxFiles` and trips
  `maxEntries`. `readdir` still materialises a whole directory before the counter is consulted, so the
  cap bounds the *tree*, not one directory listing.
- **Hardlinks are refused.** A file with `nlink > 1` is an alias to bytes that may live outside the
  workspace (`~/.ssh/id_rsa` hardlinked in reads as a regular file), so `readTree` rejects it. This
  also rejects legitimate hardlinks inside the tree — an accepted restriction, not an oversight.
- **Filenames are decoded from raw bytes.** `readdir` with the default encoding replaces invalid bytes
  with `U+FFFD`, so two different names on disk can collide onto one key *after* validation. Names are
  read as buffers and decoded with the same strict decoder as file bodies.
- **Case-fold collision detection is a heuristic.** `toLowerCase()` over NFC catches the collisions
  APFS/NTFS actually produce, but it under-folds (Greek final sigma, Turkic dotless i). It is a
  preflight guard, not a proof of portability: a name it misses fails at write time on that volume.
- **Preflight limits are policy, not measurement.** 1024 files / 1 MiB per file / 8 MiB total / 4096
  entries were chosen to bound allocation and traversal, not derived from a real harness.
- **B2's negative result is fixture-scoped.** It shows `pluginPaths` did not load *these* fixtures
  (an uncompiled `.ts` file, and its bare directory); it does not prove path loading can never work
  for a packaged plugin with a `package.json`. Direct `extensions` injection sidesteps the question.
- **`validate at the schema` is not a merge guarantee.** Zod rejects `__proto__`/`constructor`/
  `prototype` path segments and non-plain objects, but `applyTreePatch` will faithfully apply whatever
  a caller hands it. Internal callers must pass parsed trees, or the merge itself needs a guard.
- **Capture is not atomic and does not claim to be.** It assumes quiescent sources: a post-read `lstat`
  comparing `ino`, `size` and `mtimeMs` catches an ordinary mid-read edit (`SOURCE_CHANGED`), but a
  hostile concurrent writer is out of scope, exactly as it is for the tree store.
- **Hardlinks are allowed in capture and refused in the tree store.** The asymmetry is deliberate:
  capture is read-only, and a repository legitimately hardlinks (`pnpm` does it throughout
  `node_modules`). The link count is recorded as `hardlinked: true` and never hashed.
- **An undeclared link may only reach `ssot/.clinerules/`.** Anywhere else in the SSOT needs an explicit
  per-destination `canonicalSources` mapping, and a declared source must be the file itself, never a link.
  That bounds a bad link without forcing every project to enumerate its filenames.
- **`isDirty` is coarse.** It reports tracked index/worktree changes excluding submodules and says nothing
  about untracked files, so two different dirty states share one fingerprint. Comparing probes across runs
  will need a worktree-content identity or a frozen-clean policy.
- **Executable components are refused, not supported.** `scripts/verify-helpers` joins the manifest when
  materialisation carries a mode map and the mode participates in the hash; until then refusing is the
  honest option.
- **The bootstrap proves a turn, not tool execution.** Every tool call is refused by the default hook, so
  nothing in Chunk 5 establishes that a tool *works* inside a materialised tree. c2 owns that.
- **`cwd` = the harness copy is provisional.** Until the tool policy exists there is no way to let a turn
  act on the target repository safely, so the bootstrap deliberately cannot.
- **Run directories are never pruned.** Exclusivity means a crashed run leaves a directory behind and a
  retry must choose a new id; nothing reclaims the old one.
- **The claim gate is only wired for skills.** `B2.plugin`, `B5.hooks` and `B6.subagent` belong to chunks
  that have not landed. The gate accepts those ids today, but nothing requires them yet.
- **`@cline/sdk`'s own `dist/index.d.ts` is a one-line re-export.** The real session surface lives in
  `@cline/core`, so reading it means `.pnpm/@cline+core@*/node_modules/@cline/core/dist`, not
  `node_modules/@cline/sdk/dist`.
- **A stale ledger lock is never cleared automatically.** A run that dies mid-record leaves
  `<runDir>/ledger.lock` behind, and the next attempt reports `LEDGER_LOCKED`. That is deliberate —
  clearing it for the operator would also clear it for a run that is still writing — so recovery is an
  explicit `rm` after confirming the process is gone.
- **Ledger integrity is a filesystem property, not a cryptographic one.** `seq`/`at` are writer-assigned
  and the lock keeps a second *writer* out, but nothing stops a second process from editing the file
  between runs. Detecting that would need a chained digest, which no chunk has required yet.
- **`toolPolicySet`/`toolInventoryHash` in `run.started` are caller-supplied identity.** Chunk 6 records
  what the caller says the policy was; nothing yet verifies it against the tree. Chunk 7 supplies both
  from the same computed snapshot, and only then does the field mean what it looks like it means.
- **`probeSha` is the artifact's byte digest, not a fingerprint.** It identifies the file an operator can
  open. `ProbeFingerprint` composition stays in Chunks 7–8, because it must carry no paths and no timings.
- **The ledger has no rotation and no size bound.** One file per run, in a run directory that is never
  reused; a long run is a few thousand lines. If that ever stops being true the answer is a new run
  directory, not a truncated file.
- **The policy gates tool *names*, not what a tool may touch.** `cwd` is where a turn starts, not a fence:
  an allowed `run_commands` runs with the host process's permissions, and an absolute path in its arguments
  reaches the operator's repository and the SSOT just as easily as anywhere else. The live gate test leans
  on exactly that when it writes its marker outside the harness copy. Real confinement needs a sandbox,
  and until one exists an allow policy is a statement about intent.
- **`toolDecisions` is capped and excluded from the fingerprint.** 64 entries, in call order, and not part
  of `toolInventoryHash` or `toolPolicySet`. Two runs with the same policy and different decisions are
  different *outcomes*, not different probes, so hashing decisions would make every run incomparable.
- **An empty `tools/` directory means "no tools", not "no policy".** `buildToolInventory` returns an empty
  inventory for a tree with nothing under `tools/`, and a policy then cannot name anything. A tree that
  expects tools but ships none fails at `POLICY_UNKNOWN_TOOL`, which is the loud direction.
- **`B5.hooks` is now a hard dependency of every session.** A machine that has never run `pnpm spike:sdk`
  cannot start one, even with default-deny tools, because the deny is itself a hook decision. That is the
  intended fail-closed line; the alternative is trusting an unverified gate.
- **Skill discovery is the SDK's, not the tree's.** The pinned SDK also reads global skill directories
  (`~/.cline/skills`, `~/.agents/skills`), so a session can load instructions the baseline never captured
  while its fingerprint is unchanged — `treeSha` covers only what capture froze. The live gate isolates
  `HOME`/`XDG_*` and proves the mounted skill is visible and not inlined; it cannot prove ambient skills
  are unreachable. `B1` also recorded that an empty `config.skills` still shows a mounted skill, so the
  allowlist is not a visibility gate. Real isolation needs the sandbox layer.
- **"Not inlined" is measured; "returned on demand" is not.** The gate asserts the `skills` tool is
  present and the body marker is absent from the request, which is what `B1` established. Invoking the
  tool would additionally prove the body comes back, but no claim pins its input schema, and guessing one
  in a test would encode a guess as evidence.
- **Skill frontmatter is not modelled.** `collectSkills` treats every directory with a non-empty
  `SKILL.md` as mounted; the SDK's `disabled:` flag and `name:` overrides are ignored, so a disabled skill
  is still counted and a renamed one may collide with another directory's name.



### 11. Subagents

`spawn_subagent` is a real tool, not a harness-side shortcut. The parent registers it through
`extraTools` — the same surface `B6.subagent` verified — and its `execute` calls `spawnSubagent`, which
creates a second `ClineCore` on the parent's materialised `harnessDir`. A model that asks for a helper gets
one through the same path a test does.

The child does not inherit the parent's safety by default, so three things are rebuilt rather than passed
down: the policy hooks (`recordingHooks` with a fresh recorder), the contract plugin, and a config with
`extraTools: []`. The child's policy is the parent's *parsed* policy minus `spawn_subagent`, which is added
to `deny` — deny wins, so recursion is an explicit refusal in the child's own record instead of an
unnamed "not-allowed". Re-parsing the raw input on the child would throw `POLICY_UNKNOWN_TOOL`, because a
child config cannot name a tool its inventory does not declare.

Budget isolation is a property of the files, not a convention. `spawnSubagent` never opens the parent
ledger; the child gets `<runDir>/subagents/<childRunId>/ledger.jsonl` and writes a full lifecycle there
(`run.started`, one `execution.started`/`attempt.recorded`, `execution.finished`, `run.finished`) inside a
`try/finally`, so a child that throws still closes its ledger with a terminal event. The parent's file stays
byte-identical, which is what "child budget never counted" means in practice.

The child is created with `backendMode: "local"`, the same choice the parent makes. This is not cosmetic:
`B6.subagent` recorded the spawn against the local backend, and the SDK's auto-discovered hub forwards hooks
but drops inline `localRuntime.extensions`, so a child on the wrong backend would run without the contract
plugin built for it. The child is also created with its own `distinctId`, so telemetry stays attributable to
the child rather than to the parent's run.

Budget is one absolute instant, computed before the child directory exists: `Math.min` of an explicit
`timeoutMs` and the parent's remaining time, falling back to ten minutes when neither is known. An explicit
timeout can therefore shorten a child but never extend it past what the parent has left, and a child with no
budget is refused with `SUBAGENT_BUDGET_EXHAUSTED` before anything is created. Setup time is charged to the
same deadline, not to a fresh timer.

The parent's `AbortSignal` is passed down as well, and an abort asks the child runtime to abort the session
by id instead of only stopping the wait. Teardown is bounded (`abort` then `dispose`, both raced against a
ten-second limit) and runs *before* the terminal ledger events, so a still-running child cannot keep writing
into the workspace while its record says the run is over.
A failed spawn is reported to the model as `{ok: false, error}` rather than thrown: a helper that could not
start is a failed helper, not a failed run.

**Debt.** `B6.subagent` proved the shape (an `extraTools` entry can create its own core on the same `cwd`),
not the semantics. No claim establishes that a child's tool calls are attributable to it — the seven ledger
event kinds carry no child provenance — so the accounting here is per-file, not per-event. The suite
exercises this through the real tool object with a fake SDK underneath; there is no live child gate yet, so
what remains unproven is that a real provider round-trip through `spawn_subagent` behaves like the fake.
`maxIterations` defaults to 4 for children without a claim behind that number, and the child's
`promptSha256` is the parent's compiled prompt because no separate child prompt is compiled.

### 12. T4 detector

`src/context/` measures the request and recommends an action. It answers three questions and refuses a
fourth: how big is the context, which part may be rewritten, and could a summary reach the target — but it
does not claim to know the provider's token count.

**No tokenizer, and the estimate says so.** `createEstimator` charges `ceil(utf8Bytes / bytesPerToken)` per
serialized payload plus a per-message and per-tool framing allowance. The ratio of 3 is conservative for
ASCII prose and code and roughly one-to-one for CJK; it is explicitly *not* an upper bound, because payloads
dense in punctuation, digit runs or JSON escapes can cost more than one token per three bytes. Every
measurement carries an `estimatorId`, so a record cannot be read as if a later calibrated estimator produced
it. A payload that cannot be serialized raises `CONTEXT_MEASURE_INVALID` rather than collapsing to a short
marker — measuring a 600k cyclic message as ten tokens and reporting `ok` is the worst failure available to
a detector.

**`tier` is advisory.** `tokens >= b2` recommends `compact`, `tokens >= b1` recommends `stub`, below `b1`
recommends nothing. `B4.compaction` stays unverified, so `compact` means "the hard threshold was crossed",
never "a summariser ran"; the executor is expected to refuse the SDK's own `compact` path, which is why
`feasibility` is reported alongside the tier instead of being left for the executor to re-derive.

**The tail is a budget met from the end.** Messages are grouped first: an assistant message carrying tool
calls and the `tool` messages answering it are one indivisible run, because preserving results while
rewriting away their request produces a request the provider rejects. Id matching is used only when *every*
call in the turn carries an id — a partial set would make the id-less call's own result look foreign and
split the pair, so a partial set falls back to positional grouping and over-preserves instead. The final
group is always preserved, and earlier groups join it only while the accumulated estimate stays within
`tailTokens`. "At least 24k" with unbounded overshoot could preserve 111k — above the 105k target and below
the 160k refusal threshold, i.e. a tail that can be neither compacted to target nor refused — so the budget
is met from the end and `oversizeTailGroup` reports the one exception.

**Candidates are runs, and the task is not one.** `stubCandidates` lists every index in a group that lies
entirely before the tail, excluding any group anchored at index 0 and any group containing a system message.
Enumerating positions instead would offer a `tool` result for stubbing while its request stayed preserved.

**Feasibility subtracts everything rewriting cannot touch.** `summaryBudget = targetTokens - (total -
eligible) - SUMMARY_FRAMING_TOKENS`, where `total - eligible` covers the always-on text, the preserved tail,
the task at index 0 and any system message in the prefix. Charging only the fixed text and the tail reported
`fits` for targets a 110k task alone already exceeded. `NOTHING_ELIGIBLE` and `TARGET_UNREACHABLE` are
reported even when the tier is `ok`: saying `fits` about a compaction that would replace nothing is the same
false claim in a quieter voice.

**Debt.** Nothing here proves the estimate agrees with `DeepSeek-V4.1-Flash`; that needs the usage telemetry
`parseStartResult` still discards, and until it exists the post-rewrite assertion Chunk 13 makes must be
"estimated target met", never "target met". `tools` must be passed in its wire shape — a raw SDK object
holding a Zod schema would serialize the schema's internals and inflate `fixed`. `detectContext` re-serializes
the system prompt and tool list on every call, which is twice per turn once the executor exists; a cache keyed
by object identity belongs there, not here. And the ledger still has no compaction event kind, so
`overflow_recovery` residuals have nowhere to go until Chunk 13 decides whether to add one.
