# Third-party notices

This repository vendors or adapts third-party material as follows.

## write-for-humans skill

- **Source:** [gauthamchandra/kinglet](https://github.com/gauthamchandra/kinglet)
  at commit `ab99e61b672fb3465adb75c1e030c5cc50cef83d`
- **Path:** `.agents/skills/write-for-humans/`
- **License:** Apache-2.0 (see root `LICENSE`)

## Agentic guardrail patterns

Adapted from kinglet (`AGENTS.md`, `.cursor/BUGBOT.md`, husky hooks, Biome/commitlint/CI
patterns) at the same commit. Licensed Apache-2.0.

## asd-ste100 skill

- **Source:** [danyuchn/asd-ste100-skill](https://github.com/danyuchn/asd-ste100-skill)
  at commit `9c351694439ea1171f36c65b91ba661e7a0499c8`
- **Path:** `.agents/skills/asd-ste100/`
- **License:** MIT (see `.agents/skills/asd-ste100/LICENSE`)
- **Note:** Upstream intentionally does not redistribute the ASD-STE100 dictionary.

## pstack skills (curated subset)

- **Source:** [pstack](https://github.com/cursor/plugins/tree/main/pstack) plugin
  version `0.15.42` (Lauren Tan)
- **Paths:**
  - `.agents/skills/tdd/`
  - `.agents/skills/typescript-best-practices/`
  - `.agents/skills/principle-type-system-discipline/`
  - `.agents/skills/principle-boundary-discipline/`
  - `.agents/skills/principle-prove-it-works/`
  - `.agents/skills/principle-subtract-before-you-add/`
  - `.agents/skills/principle-laziness-protocol/`
  - `.agents/skills/unslop/`
- **License:** MIT (each directory includes a `LICENSE` copy)
- **Note:** These are snapshots for harness-agnostic discovery under `.agents/skills/`.
  The full pstack surface (including `/poteto-mode`) remains available via the Cursor
  plugin enabled in `.cursor/settings.json`. Prefer updating the plugin over editing
  vendored copies unless a project-local fork is intentional.

## Superpowers skills

- **Source:** [obra/superpowers](https://github.com/obra/superpowers)
  at commit `22f0b463e7a5e579904dd6211a520321035526f7`
- **Path:** `.agents/skills/receiving-code-review/`
- **License:** MIT (Copyright (c) 2025 Jesse Vincent; see `.agents/skills/receiving-code-review/LICENSE`)
- **Note:** Snapshots for harness-agnostic discovery under `.agents/skills/`.
