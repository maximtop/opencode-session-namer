# AI Agent Rules

- [Project Overview](#project-overview)
- [Technical Context](#technical-context)
- [Project Structure](#project-structure)
- [Build And Test Commands](#build-and-test-commands)
- [Contribution Instructions](#contribution-instructions)
- [Code Guidelines](#code-guidelines)
  - [System Design](#system-design)
  - [Architecture](#architecture)
  - [Code Quality](#code-quality)
  - [Testing](#testing)
  - [Dependency Management](#dependency-management)
  - [Configuration & Documentation](#configuration--documentation)
  - [Markdown Formatting](#markdown-formatting)
  - [Other](#other)

## Project Overview

opencode-session-namer is a plugin for
[opencode](https://opencode.ai) that renames sessions to a meaningful,
uniform format once per session, right after the first user message:

- PR link in the first user message →
  `[repo] KEY-123 Review pull/N <PR title>`
- otherwise, inside a git project →
  `[project] KEY-123 <opencode auto-title>`

The plugin is deterministic by default (no LLM calls). Optional LLM modes —
`smartShorten` (shorten overlong titles) and `prLinkLlm` (ask which PR the
first message references) — run in throwaway child sessions with all tools
disabled. A session is renamed at most once; a title not produced by the
built-in auto-title is never overridden.

## Technical Context

- **Language/Version**: TypeScript 5.8, strict mode, ES2022 target.
- **Runtime**: loaded by opencode's plugin system (Bun); plain Node APIs only
  (`node:fs/promises`, `node:child_process`), no Bun-specific imports.
- **Primary Dependencies**: zod at runtime; `@opencode-ai/plugin` as a peer
  dependency.
- **External Tools**: `gh` CLI for PR title/branch lookup (optional; the
  plugin degrades to URL-only naming without it).
- **Storage**: `~/.config/opencode/session-namer.state.json` — rename-once
  bookkeeping, pruned after 30 days; no database.
- **Testing**: vitest with a mock opencode SDK client.
- **Target Platform**: opencode server (CLI/TUI and OpenChamber).
- **Project Type**: library/package — an opencode plugin published to npm.
- **Performance Goals**: one rename per session; no LLM calls unless an LLM
  mode is enabled.
- **Constraints**: `github.com` hosts only; renames only the built-in
  auto-title; `gh` may be missing and naming degrades.
- **Scale/Scope**: single-user plugin; all state under `~/.config/opencode`.

## Project Structure

```text
.
├── src/
│   ├── index.ts               # plugin entry: tracking + event hook
│   ├── rename.ts              # rename orchestration
│   ├── shorten.ts             # smartShorten via a throwaway child session
│   ├── project.ts             # directory/worktree → project name + key
│   ├── pr-link.ts             # PR link extraction from the first message
│   ├── pr-link-llm.ts         # LLM fallback: which PR the message references
│   ├── github.ts              # gh CLI PR info lookup
│   ├── config.ts              # user config loading
│   ├── state.ts               # rename-once state file
│   ├── tracking.ts            # title-provenance state machine (pure)
│   ├── messages.ts            # first/newest message text part helper
│   ├── text.ts                # template/truncate/sanitize helpers
│   └── types.ts               # shared types
├── .github/workflows/         # PR checks; tag-triggered npm publish + release
├── tests/session-namer.test.ts # vitest suite with a mock opencode client
├── package.json               # scripts and dev dependencies
├── tsconfig.json              # strict TS, noEmit
├── .eslintrc.cjs              # airbnb + airbnb-typescript + jsdoc
├── vitest.config.ts
├── Makefile                   # init/lint/type-check/test wrappers
├── CHANGELOG.md               # user-facing changes (Keep a Changelog)
└── DEPLOYMENT.md              # install & release instructions
```

## Build And Test Commands

- `pnpm install` — install dev dependencies
- `pnpm lint` — eslint (Airbnb + TypeScript + JSDoc rules)
- `pnpm type-check` — `tsc --noEmit`
- `pnpm test` — vitest (PR cases make real `gh` calls; needs `gh auth login`)
- `make check` — lint + type-check + test: the full gate

There is no separate formatter (eslint enforces the style) and no build step:
opencode loads `src/index.ts` directly.

## Contribution Instructions

- You MUST verify changes with the linter and the type checker.

    - `pnpm lint` to run eslint
    - `pnpm type-check` to run `tsc --noEmit`
    - no separate formatter exists; eslint enforces the style

- You MUST update the unit tests for changed code.
- You MUST run `pnpm test` to verify that changes do not break existing
  functionality (PR cases hit the real `gh` CLI and need `gh auth login`).
- When changing the project structure, you MUST update the Project Structure
  section of this file.
- If a prompt asks to refactor or improve existing code, phrase the rule and
  add it to the relevant Code Guidelines subsection of this file.
- After completing a task, you MUST verify the new code follows the Code
  Guidelines in this file.
- You MUST add a `CHANGELOG.md` entry under `## [Unreleased]` for every
  user-facing change — one entry, written for a user.
- Even a documentation-only change must pass `make check` before finishing.

## Code Guidelines

### System Design

Design for a plugin library loaded into a host process:

- The plugin runs inside the opencode server process. Keep side effects to
  the documented surfaces: config/state files under `~/.config/opencode`,
  the `gh` CLI, and SDK client calls. Never touch unrelated host state.
- The public API is the `SessionNamer` plugin factory in `src/index.ts`;
  every other module is an implementation detail.
- Keep the dependency footprint minimal — `zod` is the only runtime
  dependency; prefer Node built-ins over adding packages.
- Do not add process listeners, global singletons, or environment mutations.
  The plugin returns hooks and receives the SDK client by injection.
- Ship complete types: strict TypeScript with `noUncheckedIndexedAccess`, no
  `any`.
- Document the plugin factory and every non-trivial function with JSDoc.
- Handle errors at the boundary: never let an exception escape the plugin —
  log via `client.app.log` and degrade to the safest behavior.

### Architecture

The codebase follows these design principles:

- **Separation of Concerns** — one aspect per module: lifecycle,
  orchestration, integrations, pure helpers.
- **Single Responsibility Principle** — every file and function has one
  reason to change.
- **Dependency Direction** — dependencies point downward; pure modules never
  import I/O or SDK modules, and the graph is acyclic.
- **Explicit Boundaries** — the SDK client enters through injection; pure
  helpers take plain data, and `types.ts` derives `PluginClient` type-only
  from the plugin signature.
- **Data Flow Clarity** — events feed tracking, tracking feeds orchestration,
  orchestration performs the single title write.
- **Minimize Coupling, Maximize Cohesion** — modules stay self-contained and
  interact through narrow interfaces; shared helpers live in `text.ts`.
- **Make Invalid States Impossible** — discriminated unions, null-vs-value
  results (`ProjectInfo | null`), zod validation of user config.
- **Observability Built-in** — a `LogFn` is threaded down from the entry; no
  `console` calls. Less critical here: the plugin is single-user and only
  logs.
- **Keep It Boring** — plain Node APIs, no Bun-specific imports, no clever
  abstractions.

The easiest way to achieve these principles is **layered architecture**.
This project's layers, from top to bottom:

- **Entry / lifecycle** — `src/index.ts`: plugin factory, event hook,
  scheduling, state ownership, logging adapter.
- **Orchestration** — `src/rename.ts`: eligibility, evidence gathering,
  title composition, the single `session.update`.
- **Integrations** — `src/project.ts`, `src/github.ts`, `src/config.ts`,
  `src/state.ts`, `src/shorten.ts`, `src/pr-link-llm.ts`: fs, env, `gh`, and
  LLM child sessions.
- **Pure domain and utilities** — `src/tracking.ts`, `src/pr-link.ts`,
  `src/text.ts`, `src/messages.ts`: parsing, provenance, formatting — no I/O.
- **Types** — `src/types.ts`: shared interfaces, erased at runtime.

```text
index.ts (entry, lifecycle, state ownership)
     ↓
rename.ts (title orchestration)
     ↓
project.ts · github.ts · config.ts · state.ts · shorten.ts · pr-link-llm.ts
     ↓
tracking.ts · pr-link.ts · text.ts · messages.ts (pure)
     ↓
types.ts (shared types)
```

`config.ts` and `state.ts` are also loaded by `index.ts` at startup; lower
layers receive their results through injected dependencies. No layer may
depend on a layer above it.

### Code Quality

- Airbnb style: 4-space indent, single quotes, max line length 80.
- No one-line `if` statements — always braces with a multiline body.
- Async `node:fs/promises` everywhere; no sync fs calls.
- JSDoc on non-trivial functions with `@param`/`@returns`.
- Prefer discriminated-union narrowing over hand-written type guards.
- Never throw past the plugin boundary: the `event` hook wraps everything in
  try/catch and logs via `client.app.log`; degraded paths (URL-only naming,
  word truncation) are expected.
- Never rename a session twice; never override a title that was not produced
  by the built-in auto-title.
- Sanitize externally sourced titles (`sanitize` in `src/text.ts`) before
  `session.update`; forward only `github.com` hosts to `gh`; never log
  tokens or secrets.
- Naming: kebab-case file names (`pr-link-llm.ts`), camelCase functions and
  variables, PascalCase types; no `I` prefix on interfaces.
- Imports are relative and extensionless; type-only imports use
  `import type`.
- Do not loosen lint rules to make code pass — fix the code.

### Testing

- Single suite at `tests/session-namer.test.ts`; vitest is configured in
  `vitest.config.ts` with a 30s timeout for real `gh` calls.
- Tests drive the plugin's `event` hook with a mock SDK client and assert the
  captured `session.update` titles; prefer behavior-level assertions over
  internals.
- Fixtures (plain git projects — one on a keyed branch — and a linked
  worktree pair) are created under `.test-fixtures/` next to the repo because
  the plugin ignores sessions in temp/scratch directories.
- PR cases hit the real `gh` CLI (`gh auth login` required); keep them few
  and stable.
- Every behavior change updates or adds tests before the task is done; all
  tests must pass (`pnpm test` or `make check`).

### Dependency Management

- **Pin all dependency versions explicitly** — no ranges that allow
  automatic upgrades to untested versions.
- **Prefer vanilla solutions** — use Node built-ins when they adequately
  solve the problem; only add a dependency for significant value.
- **Reputable sources only** — evaluate download counts, repository
  activity, and known maintainers.
- **Avoid unpopular libraries** — no niche packages with limited adoption.
- **Minimize dependency count** — every dependency adds attack surface and
  maintenance burden; justify each addition.
- **Use the latest stable version** — check the registry when adding a
  dependency; do not copy versions from memory or old lock files.

**Rationale**: fewer, well-vetted dependencies reduce security
vulnerabilities, supply chain risks, and long-term maintenance costs.
Runtime dependencies are installed with pnpm; `zod` is the only runtime
dependency and is pinned exactly (`4.1.8`).

### Configuration & Documentation

- Runtime config lives in `~/.config/opencode/session-namer.json`, all keys
  optional; defaults are defined once in `DEFAULTS` in `src/config.ts`.
- Environment overrides: `SESSION_NAMER_CONFIG`, `SESSION_NAMER_STATE`,
  `SESSION_NAMER_DELAY_MS`.
- Rename-once state is stored in `~/.config/opencode/session-namer.state.json`
  (`SESSION_NAMER_STATE` overrides the path); entries older than 30 days are
  pruned on write.
- Config parsing is per-key fault tolerant: a mistyped value falls back to
  that key's default instead of breaking the plugin.
- Update documentation together with code:
    - `README.md` — user-facing behavior, configuration, requirements;
    - `CHANGELOG.md` — every user-facing change under `## [Unreleased]`;
    - `AGENTS.md` — the Project Structure section when files move or appear;
    - `DEPLOYMENT.md` — install and release process changes.
- Never commit secrets; `gh` credentials stay outside the repo and are never
  logged.

### Markdown Formatting

All Markdown files MUST follow these formatting rules:

- **Line length**: Keep lines at most 80 characters, but don't overwrap the
  lines artificially short just to hit the limit, keep them close to 80
  characters where possible.
  This is not a hard lint gate, but SHOULD be followed for readability.
  Lines inside fenced code blocks are exempt from this limit.
- **Unordered lists**: Use dashes (`-`) for bullet points.
  Indent nested list items by 4 spaces.
- **Continuation lines**: When a list item wraps to the next line, align the
  continuation with the first character of the item text, not the list marker.
  This applies to all list types (ordered and unordered).
- **Emphasis**: Use asterisks (`*`) for emphasis (`*italic*`, `**bold**`). Do
  NOT use underscores.
- **Headings**: Duplicate heading names are allowed only among sibling
  headings (same parent level).
  Avoid duplicates across different levels.
- **Inline HTML**: Avoid raw HTML in Markdown.
  The only allowed elements are `<a>`, `<p>`, `<details>`, `<summary>`, and
  `<img>`.
- **Trailing spaces**: Do NOT leave trailing whitespace on any line.
  Do NOT use two-space line breaks — use a blank line instead.
- **Bare URLs**: Bare URLs are permitted and do not need to be wrapped in
  angle brackets.
- **Table formatting**: Align table columns with padding when the table fits
  within 80 characters.
  If the table exceeds 80 characters or triggers an MD060 linter warning,
  switch to a compact format using single spaces only.
  This applies to the separator row as well—it should be written as
  `| --- |`, not `|--|`.

  Example of correct layout:

  ```markdown
  | Col1 | Col2 |
  | --- | --- |
  | Value1 | Value2 |
  ```

  Do NOT use extra padding or alignment characters beyond single spaces.

There is no markdownlint configuration in this repository; follow these
rules by hand.

**Rationale**: Uniform Markdown formatting improves readability for both
humans and AI agents that consume project documentation.

### Other

- Commit messages: imperative mood, single line, no Conventional Commits
  prefixes (e.g. "Add session-namer plugin", "Ignore .sdd/ spec drafts").
- Keep PRs small and focused; use `gh` for PR operations and target
  `master`.
