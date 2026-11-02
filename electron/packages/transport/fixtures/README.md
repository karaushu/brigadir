# Transport fixtures

`claude.json` and `codex.json` are reduced protocol samples recorded from live Claude and Codex ACP sessions. They keep
the first sample of each session update kind, the final tool patch and the session catalog. Account notifications,
`_meta`, redundant message chunks and user home paths are excluded. `agent.mjs` is a synthetic SDK peer used by process
lifecycle tests. Fixtures and synthetic processes do not replace the opt-in live transport smoke
(`docs/guides/testing.md`).

`claude-background.jsonl` is the raw SDK `task_*` wire of a live background-command session (one command that finishes,
one that fails), reduced to tool calls, text, `task_*`, `session_state_changed` and the prompt's answer; paths are moved
under `/tmp/brigadir-fixture` (spec/chat-turns-plans-and-questions#background-commands). The `background-live` scenario
of `agent.mjs` runs a real command instead, for `Stop`.
