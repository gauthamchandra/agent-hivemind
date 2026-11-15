# AGENTS.md

Guidance for AI coding agents working in this repository. `CLAUDE.md` is a symlink to this
file, so Claude Code, Cursor, and any other agent that reads `AGENTS.md` get the same rules.

**Human contributors should read [CONTRIBUTING.md](CONTRIBUTING.md) instead.** It is the
single source of truth for the quality bar and the PR process. This file covers agent-specific
mechanics only and defers to CONTRIBUTING.md on everything it also describes.

Cursor reads this file natively. Cursor Bugbot does **not** — it reads only
`.cursor/BUGBOT.md`, which carries the review-time versions of these rules.

## Skill precedence

When skills or plugins disagree, resolve in this order:

1. **This file and [CONTRIBUTING.md](CONTRIBUTING.md)** — repository rules always win.
2. **[write-for-humans](.agents/skills/write-for-humans/SKILL.md)** — default for code,
   commits, PRs, ADRs, and tickets.
3. **[asd-ste100](.agents/skills/asd-ste100/SKILL.md)** — only when the task is to
   disambiguate agent-facing English (tool descriptions, error messages, inter-agent
   instructions). Do not rewrite ordinary PR prose into STE by default.
4. **Vendored pstack skills** under `.agents/skills/` (`tdd`, `typescript-best-practices`,
   `principle-*`, `unslop`) — opt-in slash/workflows. Encode the durable principles below
   in this file so quality does not depend on invoking them.
5. **pstack Cursor plugin** (`.cursor/settings.json`) — `/poteto-mode` and the rest of the
   plugin surface. Plugin-only; not required for non-Cursor harnesses.

## Writing

Agents writing code, commits, pull requests, ADRs, and tickets follow
[write-for-humans](.agents/skills/write-for-humans/SKILL.md). Repository rules win
when they conflict.

## Pull request follow-through

After you open a pull request, stay with it until it is merged or closed. Do this
without waiting to be asked.

- Subscribe to that PR and to CI on its head branch. On GitHub that is
  `subscribe_github_pr` (scope `pr`) and `subscribe_github_ci`. Do not poll.
- When a review comment, Bugbot finding, or CI failure arrives, re-read the thread,
  fix what is valid, push to the same branch, and reply on the thread. If the comment
  is wrong, reply with the evidence and leave the code as it is.
- Re-subscribe when a subscription expires and the PR is still open.
- Do not merge, enable auto-merge, or resolve a review thread unless the human
  asked for that.

## agent-hivemind

A Bun + TypeScript application. This repository is early: treat `src/` as the product
surface and keep scaffolding thin until real domain code lands.

## Commands

### Development

- `bun run dev` — start with watch mode
- `bun run start` — run the entrypoint once

### Testing

- `bun test` — unit tests (`bun:test` only)
- `bun test --watch` — watch mode

### Code quality

- `bun run lint` — `tsc --noEmit` + Biome check
- `bun run lint:fix` — typecheck + Biome with writes
- `bun run format` — Biome format write
- `bun run format:check` — Biome format check

## Planning

For non-trivial work, do not start implementation until the caller has seen a short plan
and answered any questions it raised. The plan should state what will change, what will
not (known gaps and YAGNI cuts), which tests come first, and open design questions.

Docs, CI, lint/format config, and other infrastructure can skip this gate. If the caller
already answered the design questions, do not re-ask — proceed.

## Bun runtime

This project uses Bun as the primary runtime. Prefer:

- `bun <file>` over `node` / `ts-node`
- `bun test` over Jest / Vitest
- `bun build` over webpack / esbuild
- `bun install` over npm / pnpm / yarn
- `bun run <script>` over `npm run`
- `bunx` over `npx`
- Bun loads `.env` automatically — do not add `dotenv`

Prefer Bun and Web APIs (`Bun.serve`, `Bun.file`, `bun:sqlite`, built-in `WebSocket`) over
Node-shaped substitutes when they fit.

### TypeScript types

- Prefer `ReturnType<typeof setInterval>` / `ReturnType<typeof setTimeout>` over `NodeJS.Timeout`
- Prefer standard Web API types and `Bun.*` over `NodeJS.*`
- Prefer `unknown` over `any`
- Avoid non-null assertions (`!`); use narrowing or optional chaining

## Testing

**Pure Bun testing only.**

```ts
import { test, expect, mock, spyOn } from 'bun:test';
```

- Use `mock()` / `spyOn()` — never import `jest` from `bun:test`
- Co-locate tests as `*.test.ts` next to source
- Reset with `mockFunction.mockReset()`
- Every test needs at least one meaningful `expect()`
- Never use `expect(true).toBe(false)` as an unreachable sentinel — use `rejects`
- Never wrap assertions in `if` blocks (conditional asserts silently pass)
- Prefer exact matches and specific matchers over vague `toBeDefined()` when the value is known

### Test-driven development

For non-trivial, non-infrastructure changes, write the tests first, confirm they fail for
the right reason, then implement until they pass. Skip TDD for docs, CI, and lint/format
config.

Prove the change against the real artifact (run the code, read the value, inspect the
diff) — not a proxy or "it compiles."

## YAGNI / over-building

Stop at the first rung that holds. Be lazy about the solution, never about tests or
required structure.

Do not:

- Add something with no caller and no stated gap
- Reimplement a helper or pattern that already lives in this repo
- Hand-roll what Bun, the Web APIs, or an already-installed dependency already do
- Introduce an unrequested abstraction (single-implementation interfaces, factories for
  one product, wrappers around one-liners)
- Grow the diff by adding layers "for later"

Subtract dead code and redundant scaffolding before adding new structure.

## Prose budget

The diff already shows _what_ changed. Leave only what a maintainer cannot infer: why,
trade-offs, and known limits.

- PR free prose — at most about **three paragraphs**
- Commit body optional; if present, add why / trade-off / how verified — not a file list
- Review comments: the finding, or silence

## Commit sign-off

Every commit must be signed off under the identity of the **human who requested the
work**.

Ask that human and get an explicit sign-off before putting their name on the commit.
Do not assume it.

**Cloud agents:** keep `user.name` / `user.email` as the agent. Put the human on both
trailers, and do **not** run `git commit -s` (that appends a banned agent `Signed-off-by`):

```
Co-authored-by: Human Name <human@example.com>
Signed-off-by: Human Name <human@example.com>
```

**Humans committing locally:** `git commit -s` is fine; CI requires `Signed-off-by` to
match the author.

CI rejects any `Signed-off-by` carrying a coding-agent identity.

## Path aliases

- `@/*` — `src/*`

Relative imports within a module are fine. Prefer `@/` when crossing package roots under
`src/`.

## Guidelines

- Sign off every commit under the human who requested the work (see Commit sign-off)
- Prefer `bunx` over `npx`
- When moving code, do not leave diff-narration comments
- Avoid empty interfaces — use `Record<never, never>` or a concrete union
- Prefer padding blank lines between key statements for readability
- Use `substring()` instead of deprecated `substr()`
- Type-only imports: `import type { Foo } from './foo'`
- Prefer static imports over dynamic `await import()` unless there is a genuine need
- For numeric presence checks, use `value != null` (not truthiness — `0` is valid)
