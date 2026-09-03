# AI Agent Rules

## Project Overview

opencode-session-namer is a plugin for [opencode](https://opencode.ai) that
renames sessions to a meaningful, uniform format once per session, right
after the first user message:

- PR link in the first user message → `[repo] KEY-123 Review pull/N <PR title>`
- otherwise, inside a git project → `[project] KEY-123 <opencode auto-title>`

The plugin is deterministic by default (no LLM calls). Optional LLM modes —
`smartShorten` (shorten overlong titles) and `prLinkLlm` (ask which PR the
first message references) — run in throwaway child sessions with all tools
disabled.

## Technical Context

- **Language**: TypeScript, strict mode, ES2022.
- **Runtime**: loaded by opencode's plugin system (Bun); plain Node APIs only
  (`node:fs/promises`, `node:child_process`), no Bun-specific imports.
- **Dependencies**: zod at runtime. Dev: vitest, eslint (airbnb +
  airbnb-typescript + jsdoc), typescript.
- **External tools**: `gh` CLI for PR title/branch lookup (optional; the
  plugin degrades to URL-only naming without it).
- **Config**: `~/.config/opencode/session-namer.json`, all keys optional.
- **State**: `~/.config/opencode/session-namer.state.json` — rename-once
  guarantee across restarts.

## Project Structure

```text
.
├── src/
│   ├── index.ts               # plugin entry: tracking + event hook
│   ├── rename.ts              # rename orchestration
│   ├── shorten.ts             # smartShorten via a throwaway child session
│   ├── project.ts             # directory/worktree → project label
│   ├── pr-link.ts             # PR link extraction from the first message
│   ├── pr-link-llm.ts         # LLM fallback: which PR the message references
│   ├── github.ts              # gh CLI PR info lookup
│   ├── config.ts              # user config loading
│   ├── state.ts               # rename-once state file
│   ├── tracking.ts            # title-provenance state machine (pure)
│   ├── messages.ts            # first/newest message text part helper
│   ├── text.ts                # template/humanize/truncate helpers
│   └── types.ts               # shared types
├── tests/session-namer.test.ts  # vitest suite with a mock opencode client
├── package.json               # scripts and dev dependencies
├── tsconfig.json              # strict TS, noEmit
├── .eslintrc.cjs              # airbnb + airbnb-typescript + jsdoc
├── vitest.config.ts
├── Makefile                   # init/lint/type-check/test wrappers
└── DEPLOYMENT.md              # install & release instructions
```

## Build And Test Commands

- `pnpm install` — install dev dependencies
- `pnpm lint` — eslint
- `pnpm type-check` — tsc --noEmit
- `pnpm test` — vitest (PR cases make real `gh` calls; needs `gh auth login`)
- `make check` — lint + type-check + test

## Code Guidelines

- Airbnb style: 4-space indent, single quotes, max line length 80.
- No one-line `if` statements — always braces with a multiline body.
- Async `node:fs/promises` everywhere; no sync fs calls.
- JSDoc on non-trivial functions with `@param`/`@returns`.
- Discriminated-union narrowing over hand-written type guards.
- Never throw past the plugin boundary: the `event` hook wraps everything in
  try/catch and logs via `client.app.log`.
- Never rename a session twice; never override a title that was not produced
  by the built-in auto-title.

## Testing

Tests drive the plugin's event hook with a mock SDK client (no server). PR
cases hit the real `gh` CLI. Fixtures (plain git projects — one on a keyed
branch — and a linked-worktree pair) are created under `.test-fixtures/`
next to the repo because the plugin ignores sessions in temp/scratch
directories.
