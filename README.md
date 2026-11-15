# agent-hivemind

Bun + TypeScript application with harness-agnostic agent guardrails.

## Quick start

```bash
bun install
bun test
bun run lint
bun run dev
```

Requires [Bun](https://bun.sh) **1.3.4** (see `.tool-versions`).

## Agent tooling

| Surface                              | Role                                 |
| ------------------------------------ | ------------------------------------ |
| `AGENTS.md` / `CLAUDE.md`            | Always-on rules for coding agents    |
| `.cursor/BUGBOT.md`                  | Cursor Bugbot review rules           |
| `.agents/skills/`                    | Canonical skills (source of truth)   |
| `.cursor/skills/`, `.claude/skills/` | Symlinks into `.agents/skills/`      |
| `.cursor/settings.json`              | Enables the **pstack** Cursor plugin |

Skill precedence and commands are documented in [`AGENTS.md`](AGENTS.md). Humans should
read [`CONTRIBUTING.md`](CONTRIBUTING.md). Third-party skill attributions live in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## License

Apache-2.0. See [`LICENSE`](LICENSE).
