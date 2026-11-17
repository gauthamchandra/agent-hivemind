# Contributing to agent-hivemind

Thanks for considering a contribution. This document is the single source of truth for what
"done" looks like. `AGENTS.md` (and its `CLAUDE.md` symlink) defer to this file on anything
they both describe.

---

## Quality bar

- **Bun-first.** Use Bun for runtime, install, scripts, and tests. Do not reintroduce the
  Node/Jest/Vitest toolchain without an ADR-level reason.
- **Type-safe TypeScript.** Strict settings are on. Prefer `unknown` over `any`, type-only
  imports, and no non-null assertions.
- **Tests travel with the change.** Co-locate `*.test.ts`. Cover error paths when you change
  behaviour. Every test needs a meaningful `expect()`.
- **Lint is clean.** `bun run lint` must pass with zero errors and zero warnings before review.
- **Small diffs.** Prefer the smallest change that solves the stated problem. No speculative
  scaffolding.

---

## Local setup

```bash
# Bun 1.3.4 — see .tool-versions
bun install
bun test
bun run lint
```

Cloud Agents run [`.cursor/install.sh`](.cursor/install.sh), which checksum-verifies the Bun
install and then runs `bun install`.

---

## Pull requests

1. Branch from `main`.
2. Keep the PR focused. Prefer several small PRs over one large one. A pull request
   touches at most 25 files unless the change cannot be split. When it cannot, the
   pull request says why.
3. Fill out the PR template. Lead with why, not a file tour.
4. Sign off every commit (see below).
5. Disclose AI assistance when a model substantially shaped the change.

---

## Developer Certificate of Origin (DCO)

This project requires a `Signed-off-by` line on every commit under the identity of the
**human** who stands behind the change. That line certifies the
[DCO](https://developercertificate.org/) and that the signer has read the change.

**Humans:** `git commit -s`

**Cloud agents:** keep the agent as git author/committer so GitHub can verify the signature.
Put the human on both trailers and do **not** run `git commit -s`:

```
Co-authored-by: Gautham Chandra <gautham.chandra@live.com>
Signed-off-by: Gautham Chandra <gautham.chandra@live.com>
```

CI rejects `Signed-off-by` lines that carry coding-agent identities.

---

## Agent tooling

- Canonical skills live under [`.agents/skills/`](.agents/skills/).
- `.cursor/skills/` and `.claude/skills/` are symlinks into that directory so Cursor and
  Claude Code see the same set.
- The **pstack** Cursor plugin is enabled in [`.cursor/settings.json`](.cursor/settings.json)
  for `/poteto-mode` and related workflows. A curated, self-contained subset is also vendored
  under `.agents/skills/` for non-Cursor harnesses.
- Claude Code shared permissions live in [`.claude/settings.json`](.claude/settings.json).
  Personal overrides go in `.claude/settings.local.json` (gitignored).
- Default writing skill: `write-for-humans`. Use `asd-ste100` only for agent-facing English
  that must not be ambiguous. See skill precedence in `AGENTS.md`.
