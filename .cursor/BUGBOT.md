# Bugbot review rules — agent-hivemind

Bun + TypeScript application. Review for runtime discipline, type safety, and test quality.
Full context: [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md).

---

## Flag these

### Runtime — Bun, not Node

| Don't                           | Use                        |
| ------------------------------- | -------------------------- |
| `node script.ts`, `ts-node`     | `bun script.ts`            |
| `npm` / `pnpm` / `yarn` install | `bun install`              |
| `npm run <script>`              | `bun run <script>`         |
| `npx`                           | `bunx`                     |
| `jest` / `vitest`               | `bun test`                 |
| `webpack` / `esbuild` / `vite`  | `bun build`                |
| Express (unless already chosen) | `Bun.serve()` when fitting |
| `better-sqlite3`                | `bun:sqlite`               |
| `ws`                            | built-in `WebSocket`       |
| `dotenv`                        | nothing — Bun loads `.env` |

Also flag `NodeJS.*` namespace types for timers and APIs that have Web/`Bun.*` equivalents.

### Imports

- Prefer `@/*` when crossing module roots under `src/`
- Type imports must be type-only: `import type { … }`
- Dynamic `await import()` without a genuine reason (conditional load / cycle break)

### Type safety

- `any` anywhere — prefer `unknown` and narrow
- Non-null assertions (`!`)
- Empty interfaces — prefer `Record<never, never>` or a concrete union
- `substr()` — use `substring()`
- Truthiness checks on numbers (`if (count)`) — use `count != null`

### Tests

- `jest` imported from `bun:test`, or Jest/Vitest as a dependency
- Conditional assertions inside `if` blocks
- `expect(true).toBe(false)` unreachable sentinels
- Tests with no meaningful `expect()`
- Assertion-restating comments

### Migrations

- `CREATE INDEX` without `CONCURRENTLY` on a table that already exists (an index on a table the
  same file creates is fine)
- `CONCURRENTLY` in a file whose name does not end in `.no-transaction.sql`, or any statement other
  than a concurrent index build or drop in a file whose name does
- `CREATE INDEX CONCURRENTLY` with no `DROP INDEX CONCURRENTLY IF EXISTS` of the same index before
  it in the file, because a failed build leaves an invalid index that `IF NOT EXISTS` skips
  ([ADR 0009](../docs/adr/0009-a-migration-that-cannot-run-in-a-transaction-lives-in-its-own-file.md))

### Decisions

Flag a pull request that meets the ADR bar in
[CONTRIBUTING.md](../CONTRIBUTING.md#architecture-decisions) and neither adds a file under
`docs/adr/` nor names an accepted ADR that already covers the change: a changed layer boundary
or port, a changed meaning of a state machine or the policy table, a changed data-model
invariant or migration approach, a new dependency, external system or authentication path, or a
settled product-level decision.

### YAGNI

Flag speculative helpers, config for values that never change, single-implementation
abstractions, and layers added "for later" with no caller.

### Prose

Flag PR descriptions that narrate the diff instead of explaining why, trade-offs, or
known limits.

---

## Do not flag

- Co-located `*.test.ts` next to source
- Padding blank lines between key statements
- Verbose, intent-revealing names that pass the write-for-humans pseudocode test
- Opt-in use of vendored skills under `.agents/skills/` or the pstack plugin
