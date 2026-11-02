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

## Known debt carried forward

- **`TreePatch` cannot express deletion.** `""` writes an empty file, by design, because upstream
  deletion happens by removing the file from disk and reading the directory back. If a candidate
  harness must genuinely remove a file (likely once rich edits land), `treePatchSchema` becomes
  `z.record(relPathSchema, z.string().nullable())` — a shape change, so it is recorded here rather
  than discovered mid-chunk.
- **B2's negative result is fixture-scoped.** It shows `pluginPaths` did not load *these* fixtures
  (an uncompiled `.ts` file, and its bare directory); it does not prove path loading can never work
  for a packaged plugin with a `package.json`. Direct `extensions` injection sidesteps the question.
- **`validate at the schema` is not a merge guarantee.** Zod strips a top-level `__proto__` and
  rejects `constructor`/`prototype` on parse, but `applyTreePatch` will faithfully spread whatever a
  caller hands it. Internal callers must pass parsed trees, or the merge itself needs a guard.


