# EXPERIENCE

Lessons from traps that actually cost time. One line each: trap → rule.

- **`@ts-expect-error` placement:** a directive on a multi-line `//` comment binds to the comment's second line, so it reports "unused" and you conclude the type is permissive when it is not -> keep the directive on a single line immediately above the code under test.
- **`@cline/sdk` declarations decay under `skipLibCheck`:** `AgentPlugin` and `CoreSessionConfig` accept objects missing their own required fields, and `ClineCore.start()` resolves to `unknown` (TS2834 forces `skipLibCheck`) -> never validate an SDK object by type; validate at the boundary with our own zod and declare a local interface for the slice we call.
- **`pluginPaths` does not load candidate plugins:** a `.ts` file or its bare directory both register nothing -> import the plugin ourselves and inject it via `extensions: [pluginObject]`, then assert the declared tools actually appeared.
- **Secret redaction misses transformed values:** `coerce` trims before reporting, so redacting only the raw key leaves the trimmed substring in the error -> register raw + trimmed + JSON-escaped variants and replace longest-first.
- **`config.skills` is not a visibility gate:** a skill under `<cwd>/.cline/skills/<name>/SKILL.md` appears even with an empty list, and its body is never inlined into the request -> scope c6 by which directories exist, and budget for a tool entry rather than the file body.
- **Over-redaction from placeholder credentials:** a leftover `OPENAI_API_KEY=1` makes `redact` replace every `1`, turning `b1Tokens` into `b<redacted>Tokens` and hiding the real error -> skip redaction candidates shorter than 4 chars; no real key is that short.
- **Whitespace-only env vars are not "unset" by default:** a `!== ""` check lets `SYNTHETIC_API_KEY="   "` win the chain and then fail coercion, while the provenance field already reported it as absent -> test `.trim() !== ""` in every place that reads a chain (value, provenance, retired-name check).
