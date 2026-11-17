# agent-hivemind

hivemind-svc records a group's tasks and the agent sessions that work them. The record
is a PGlite database. `bun run start` serves the HTTP API. `bun run hivemind` is the
client for that API.

## Quick start

```bash
bun install
bun test
bun run lint
HIVEMIND_RESPONSE_KEY=dev-key bun run dev
```

Requires [Bun](https://bun.sh) **1.3.4** (see `.tool-versions`). The service refuses to
start when `HIVEMIND_RESPONSE_KEY` is unset. The first start prints a bootstrap key, once.

| Variable                | What it does                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `HIVEMIND_RESPONSE_KEY` | Required. The service will not start without it.                                    |
| `PORT`                  | Listen port. Unset uses an ephemeral port.                                          |
| `HIVEMIND_DATA`         | Directory for the PGlite record. Defaults to `.hivemind`.                           |
| `HIVEMIND_POSTGRES_URL` | Connection string for the PostgreSQL spawn-gate test. The service does not read it. |

## Client

`bun run hivemind` commands are `enroll`, `whoami`, `task`, `member`, `release`, and
`resume`.

| Variable         | What it does                                                             |
| ---------------- | ------------------------------------------------------------------------ |
| `HIVEMIND_URL`   | Required service address. Use `https`, or `http` on loopback.            |
| `HIVEMIND_HOME`  | Directory for the saved token. Defaults to `~/.hivemind`.                |
| `HIVEMIND_TOKEN` | Token for this run. When unset, the client reads `$HIVEMIND_HOME/token`. |

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
