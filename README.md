# opencode-session-namer

An [opencode](https://opencode.ai) plugin that gives sessions meaningful names, once, right after the first user message — and never touches them again.

```
[filters registry] Review pull/1226 Strips `version` and `timeUpdated` fields
[compiler] AG-31699 Review pull/386 Add support for local download of…
[browser-extension] AG-56603 Fixing the flaky test
[browser-extension] Add dark mode toggle
```

## How it works

- If the **first user message references a GitHub pull request**, the plugin fetches the PR title and branch via the [`gh`](https://cli.github.com) CLI and names the session after it: the repo, the PR number, the PR title. If the branch or title contains an issue key (e.g. `AG-123`), it is included. The link is detected anywhere in the message — a full URL with any suffix (`…/pull/N/changes`, `#diff…`, `?…`) or the short `owner/repo#N` form. When no link-shaped text is found and `prLinkLlm` is on, a small model is asked which PR the message references. Only `github.com` hosts are accepted — a host from an untrusted message is never forwarded to `gh` (see Security).
- Otherwise, for sessions inside a **git project**, the current auto-title gets a project prefix. Issue keys are picked up from the branch name. When the built-in title has not settled yet (session title still "New session"), the descriptive part is derived from the first line of the user message.
- **Worktrees are detected generically**: a linked worktree has a `.git` *file* pointing into the main repo, so the project label is the main repo name and the issue key comes from the worktree branch — no configuration needed, works with any directory layout.
- Sessions in scratch directories (temp dirs, OpenChamber chat workspaces) keep the plain auto-title; the project-naming path skips them. A first message that references a PR is still named by the PR.
- Sub-agent sessions are skipped.

## Safety rules

- **Renames exactly once per session** (tracked in a state file, survives restarts). Later manual renames are never overridden.
- **A manual/external title is never replaced.** The plugin tracks title-change events: the first title set right after the first user message is assumed to be opencode's auto-title and may be replaced; any other title marks the session as foreign.
- The rename fires ~10s after the first user message (falling back to the first `session.idle` for sessions restored before the plugin saw them). If a title recorded as the built-in auto-title is written again over ours before the first idle, our title is re-applied exactly once; a change from any other source — including a manual rename — wins immediately and closes that correction window. After the first idle, later changes are never touched.
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
cd opencode-session-namer
pnpm install
ln -s "$PWD/src/index.ts" ~/.config/opencode/plugins/session-namer.ts
```

Restart opencode / OpenChamber to load the plugin.

## Configuration

All optional; create `~/.config/opencode/session-namer.json` to override:

| Key | Default | Meaning |
| --- | --- | --- |
| `template` | `[{project}] {agKey} {title}` | Name shape. Slots: `{project}`, `{agKey}`, `{title}`. Empty slots collapse. An empty string falls back to the default. |
| `prPrefix` | `Review pull/{number} ` | Prepended to `{title}` for PR sessions. `{number}` is the PR number. Empty string disables the prefix. |
| `agKeyPattern` | `[A-Z][A-Z0-9]{1,9}-\d+` | Regex for the issue key; an optional capture group selects the key. An empty string falls back to the default. |
| `maxLength` | `90` | Titles longer than this get shortened. |
| `smartShorten` | `false` | Shorten overlong titles with an LLM instead of a hard word-cut. |
| `smartShortenModel` | `null` | `provider/model` for shortening; defaults to `small_model` from the opencode config. |
| `prLinkLlm` | `false` | When no PR link is found in the first message, ask a small LLM (throwaway child session) which PR it references; the reply is validated before use. |
| `renameDelayMs` | `10000` | Delay after the first user message (or first idle) before renaming. |

### Environment overrides

| Variable | Meaning |
| --- | --- |
| `SESSION_NAMER_CONFIG` | Config file path instead of `~/.config/opencode/session-namer.json`. |
| `SESSION_NAMER_STATE` | State file path (rename-once bookkeeping). Entries older than 30 days are pruned on every write. |
| `SESSION_NAMER_DELAY_MS` | Overrides `renameDelayMs` (positive integer of milliseconds; `0`, negatives and non-integers fall back to the default). |

### smartShorten

When enabled, an overlong descriptive part is shortened by a small model through a throwaway child session (created, prompted once, deleted). Only the descriptive part is shortened — the structural prefix (`[project] AG-123 Review pull/N`) stays intact. On any failure the plugin falls back to word truncation.

## Security

- Only `github.com` PR links are fetched. Hosts from untrusted messages are
  never passed to `gh`: `gh` forwards GitHub Enterprise tokens to whatever
  host `GH_HOST` names, so doing so would have exfiltrated the user's tokens
  to an attacker-controlled host. Enterprise hosts are simply not supported.
- Titles are sanitized of C0/C1 control characters and Unicode format
  characters (bidi overrides, zero-width) before `session.update`, so a
  crafted PR title or model reply can neither inject terminal sequences nor
  spoof how the title displays.
- The LLM helpers (`smartShorten`, `prLinkLlm`) run in throwaway child
  sessions with all tools disabled and a fixed system prompt, so a crafted
  PR title or message cannot turn them into an agent.
- The plugin never logs tokens or other secrets.

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
