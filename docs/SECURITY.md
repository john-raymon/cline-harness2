# Secret scanning

Three gates, in the order they fire.

| Gate | Runs | Blocks |
| --- | --- | --- |
| `.githooks/pre-commit` | `git commit` | the commit |
| `.githooks/pre-push` | `git push` | the push |
| `.github/workflows/secret-scan.yml` | push, PR, weekly | the build |
| GitHub push protection | `git push` | the push (unavailable here — see below) |

All of them use [gitleaks](https://github.com/gitleaks/gitleaks) with the same
`.gitleaks.toml`, so a commit that passes locally does not fail in CI for a different
reason.

pre-commit only sees the diff you are about to add, so it misses commits that arrive by
other routes — `--no-verify`, `--amend`, `rebase`, `cherry-pick`, or anything committed
before gitleaks was installed. pre-push scans what is actually leaving the machine.

## Local setup

Hooks are tracked, but git will not run them until `core.hooksPath` points at them.
That is a per-clone setting, so it cannot be committed. Two ways to set it:

```bash
pnpm install          # on a fresh clone: the prepare script sets it
pnpm run hooks:install # always works, including after a no-op install
```

`scripts/install-hooks.mjs` sets `core.hooksPath` to `.githooks` only when it is unset,
and restores the hook's executable bit if a zip download dropped it. If you already use
husky or lefthook, it prints a warning and leaves your setting alone — wire
`.githooks/pre-commit` into your existing chain instead.

The hook needs gitleaks **v8.19 or newer** (`gitleaks git --staged` did not exist
before that):

```bash
brew install gitleaks     # or: brew upgrade gitleaks
gitleaks version
```

## Running the scan by hand

```bash
pnpm run secrets:scan     # every commit on every ref
pnpm run secrets:staged   # just the staged diff, same check the hook runs
```

Both redact the matched value in the output, so a real key does not end up in a
terminal scrollback or a CI log. Use `--report-format json --report-path <file>` when
you need the unredacted value to identify which key leaked.

## When the hook blocks you

It fails closed: a missing or outdated gitleaks refuses the commit rather than passing
it unscanned. That is intentional — a silent pass is indistinguishable from a clean
commit.

- **It is a real key.** Remove it from the commit and rotate it. Deleting the file in a
  later commit does not help; the blob stays in history and the hook only inspects the
  diff you are about to add.
- **It is a test fixture.** Add the exact literal to `.gitleaks.toml`, or append a
  `gitleaks:allow` comment to that one line. Never allowlist a path: `^test/` would
  hide a real key pasted into a test, which is the mistake most worth catching.
- **Emergency.** `HARNESS2_SKIP_SECRET_SCAN=1 git commit ...` skips this check and
  prints that it did. `git commit --no-verify` skips every hook. Both leave a visible
  trace, and CI still scans the push.

## If a key does reach history

Rotate first. The key is public the moment it is pushed, and rewriting history does not
un-publish it. After that, `git filter-repo --path <file> --invert-paths` (or BFG) can
drop the blob; this repository has done that once already — see commit `9fc0108`, which
untracked run artifacts that `d872128` swept in by accident.

## GitHub settings

`Settings → Code security` should have **Secret scanning** and **Push protection**
enabled. Neither can be turned on for this repository today: the REST API returns `422
Secret scanning is not available for this repository`, because both are paid features on
a private repo (Secret Protection / GitHub Advanced Security). That is a licensing limit,
not a misconfiguration — either make the repo public, or buy Secret Protection, and both
become available.

Until then `.githooks/pre-push` is the substitute: it runs the same scan on the same
commits, just locally. The difference is that a developer with a stale clone, or someone
pushing from a machine without the hook installed, is not covered by it — which is
exactly the case GitHub-side push protection would catch. Treat that as the reason to
keep CI on every push rather than only on pull requests.
