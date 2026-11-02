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

## Probe fingerprint v2

`PROBE_FINGERPRINT_VERSION` is `2` because `baseUrl` joined the freeze record: a run against a
different endpoint is not a matched contrast. A v1 record is rejected rather than upgraded — it has no
endpoint field, so "upgrading" would assert something nobody verified. The stored value is normalised
by `baseUrlSchema` (lowercase host, no trailing path slash, no query, fragment or userinfo), so two
spellings of one endpoint cannot hash differently.

What this file may assert is unchanged: `B4.compaction` stays `unverified`, and the decisions above
are operator approvals, not evidence regenerated by `pnpm spike:sdk`.

Two migration traps to keep in mind. Retired-variable detection runs *before* CLI and `SOLVER_*`
precedence, so a stale `export HARNESS2_MODEL=` in a shell profile blocks every run in that shell
until it is removed — that is the intended fail-closed behaviour, not a bug to relax. And whatever
reads fingerprint records must translate the literal mismatch into "this record predates v2, re-probe"
rather than surfacing a raw `Invalid literal value, expected 2`; that reader does not exist yet, so the
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


