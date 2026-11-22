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
- **Shared test helpers.** Open databases, boot the service, and wait for async state through
  `src/testing/` (`openMigratedDatabase()`, `bootService()`, `waitUntil()`), not through
  copies in a test file. A Biome rule rejects `new PGlite(` outside `src/testing` and
  `src/index.ts`. Teardown runs after every test, so a test needs no manual `close()` or
  `stop()`.
- **Missing values fail the test.** Use `requirePresent()` instead of `?? ''` or `!`, so a
  missing value cannot let a later assertion pass for the wrong reason.
- **Tests stand alone.** Tests may run in random order, so a test must not rely on another
  test having run first.
- **Locks go in one order.** A transaction takes locks in the order in
  [`docs/architecture.md`](docs/architecture.md#places-and-locks). The store throws when one
  breaks it, so a new store method that takes a row lock must be wrapped in `inLockOrder`. A new
  `FOR UPDATE` path, or code that allocates the next number with `MAX(…) + 1`,
  needs a test with two connections in a `*.postgres.test.ts` file, because the in-process
  database runs one transaction at a time and cannot show a race.
- **Schema conventions.** A timestamp column is named `<field>_at` or `<field>_until`, and every
  table has a `COMMENT ON TABLE` that says what it holds. A constraint is added `NOT VALID` in
  one migration and validated in a later one. An index on an existing table is built with
  `CREATE INDEX CONCURRENTLY` in its own `.no-transaction.sql` file, after a
  `DROP INDEX CONCURRENTLY IF EXISTS` of the same index
  ([ADR 0009](docs/adr/0009-a-migration-that-cannot-run-in-a-transaction-lives-in-its-own-file.md)).
  `schema-conventions.test.ts` fails on a new violation. Its two lists of older exceptions only
  shrink.
- **Docs travel with the change.** A change to a transition row, a policy rule, or a session's
  life updates [`docs/state-machines.md`](docs/state-machines.md) in the same pull request. A
  change to a layer boundary or a port updates [`docs/architecture.md`](docs/architecture.md).
- **Architectural changes have an ADR.** A change that meets the bar in
  [Architecture decisions](#architecture-decisions) needs a decision record. The pull request
  either adds one or names an accepted ADR that already covers the decision. With neither, it
  is not ready for review.
- **Lint is clean.** `bun run lint` must pass with zero errors and zero warnings before review.
- **Small diffs.** Prefer the smallest change that solves the stated problem. No speculative
  scaffolding.

---

## Architecture decisions

A change that settles something a later contributor would otherwise reopen needs an
architecture decision record (ADR) in [`docs/adr/`](docs/adr/). Add it in the same pull request
as the first code that depends on it, or before.

A pull request that builds on an ADR accepted earlier needs no new one when that ADR already
covers the decision. It names the ADR in its description. If the change goes beyond what the
ADR decided, update that ADR or add a new one.

Write an ADR when the change:

- adds, removes or moves a layer boundary, or adds or changes a port;
- changes what a state machine or the policy table means. A new state, a new role, or a new
  rule about who may do what counts. A row that follows an existing pattern does not;
- changes a data-model invariant, or how migrations run;
- adds a runtime dependency, an external system, or a new way for a person or an agent to
  authenticate;
- settles a product-level question, such as how agents communicate, who approves a change, or
  how spend is measured.

A bug fix, a refactor that keeps the boundaries, and a change that follows an existing pattern
need no ADR. When in doubt, write one. They are short.

Name the file with the next number, `NNNN-short-name.md`. Follow
[ADR 0001](docs/adr/0001-forward-only-sql-migrations.md) and the document shape in
[AGENTS.md](AGENTS.md#adrs). An ADR can be accepted before its code exists. Say so in its status. Other docs, such
as `docs/architecture.md`, link to the ADR and do not repeat its reasoning.

`src/docs/adr-links.test.ts` fails when an ADR names a later one that does not supersede it.

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
