# opencode-session-namer

An [opencode](https://opencode.ai) plugin that gives sessions meaningful names, once, right after the first reply — and never touches them again.

```
[filters registry] Review pull/1226 Strips `version` and `timeUpdated` fields
[compiler] AG-31699 Review pull/386 Add support for local download of…
[browser-extension] AG-56603 Fixing the flaky test
[browser-extension] Add dark mode toggle
```

## How it works

- If the **first user message contains a GitHub PR link**, the plugin fetches the PR title and branch via the [`gh`](https://cli.github.com) CLI and names the session after it: the repo, the PR number, the PR title. If the branch or title contains an issue key (e.g. `AG-123`), it is included. GitHub Enterprise hosts work via `GH_HOST`.
- Otherwise, for sessions inside a **git project**, the current auto-generated title gets a project prefix. Issue keys are picked up from the branch name.
- **Worktrees are detected generically**: a linked worktree has a `.git` *file* pointing into the main repo, so the project label is the main repo name and the issue key comes from the worktree branch — no configuration needed, works with any directory layout.
- Sessions in scratch directories (temp dirs, OpenChamber chat workspaces) keep the plain auto-title.
- Sub-agent sessions are skipped.

## Safety rules

- **Renames exactly once per session** (tracked in a state file, survives restarts). Later manual renames are never overridden.
- **A manual/external title is never replaced.** The plugin tracks title-change events: the first title set right after the first user message is assumed to be opencode's auto-title and may be replaced; any other title marks the session as foreign.
- The rename fires ~10s after the first `session.idle`, so it lands after the built-in auto-title (in opencode, the last write wins).
- No LLM calls by default; naming is deterministic. Failures never break the session — the plugin just logs and moves on.

## Install

From npm (once published):

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": ["opencode-session-namer"]
}
```

Or from a local checkout:

```sh
git clone https://github.com/maximtop/opencode-session-namer
ln -s "$PWD/opencode-session-namer/index.ts" \
  ~/.config/opencode/plugins/session-namer.ts
```

Restart opencode / OpenChamber to load the plugin.

## Configuration

All optional; create `~/.config/opencode/session-namer.json` to override:

| Key | Default | Meaning |
| --- | --- | --- |
| `template` | `[{project}] {agKey} {title}` | Name shape. Slots: `{project}`, `{agKey}`, `{title}`. Empty slots collapse. |
| `prPrefix` | `Review pull/{number} ` | Prepended to `{title}` for PR sessions. `{number}` is the PR number. |
| `agKeyPattern` | `[A-Z][A-Z0-9]{1,9}-\d+` | Regex for the issue key; an optional capture group selects the key. |
| `maxLength` | `90` | Titles longer than this get shortened. |
| `smartShorten` | `false` | Shorten overlong titles with an LLM instead of a hard word-cut. |
| `smartShortenModel` | `null` | `provider/model` for shortening; defaults to `small_model` from the opencode config. |
| `renameDelayMs` | `10000` | Delay after the first idle before renaming. |

### smartShorten

When enabled, an overlong descriptive part is shortened by a small model through a throwaway sub-session (created, prompted once, deleted). Only the descriptive part is shortened — the structural prefix (`[project] AG-123 Review pull/N`) stays intact. On any failure the plugin falls back to word truncation.

## Requirements

- PR titles require the `gh` CLI, authenticated (`gh auth login`). Without it, PR sessions are named from the URL alone: `[compiler] Review pull/386`.
- Everything else works with no external tools.

## Development

```sh
pnpm install
make check   # lint + type-check + tests
```

The vitest suite drives the plugin with a mock opencode client; the PR cases
make real `gh` calls and need `gh auth login`.

See also: [AGENTS.md](AGENTS.md), [DEPLOYMENT.md](DEPLOYMENT.md).
