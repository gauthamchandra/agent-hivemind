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
