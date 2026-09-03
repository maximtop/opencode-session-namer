# Deployment

## Local install (from a checkout)

```sh
git clone https://github.com/maximtop/opencode-session-namer
cd opencode-session-namer
pnpm install
ln -s "$PWD/src/index.ts" ~/.config/opencode/plugins/session-namer.ts
```

`pnpm install` is required: the plugin imports `zod` at runtime, resolved
from the checkout's `node_modules` through the symlink.

Restart opencode / OpenChamber to load the plugin. Edits in the checkout take
effect on the next restart.

## Upgrade

```sh
git pull          # check out a release tag if you want a pinned version
pnpm install      # dependencies changed? re-run; the plugin needs them
```

Then restart opencode to pick up the changes.

A checkout install tracks the default branch; to follow releases instead,
create the checkout at a tag (`git clone --branch v<version> …`, or
`git fetch && git checkout v<version>`).

## Uninstall

Remove the symlink and restart opencode:

```sh
rm ~/.config/opencode/plugins/session-namer.ts
```

The config and state files (`~/.config/opencode/session-namer*.json`) stay in
place; remove them too if the plugin should forget all processed sessions.

## Install from npm (once published)

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": ["opencode-session-namer"]
}
```

opencode installs npm plugins automatically at startup (cached in
`~/.cache/opencode/node_modules/`).

## Release

1. Bump `version` in `package.json`.
2. `make check` must pass (PR test cases hit the real `gh` CLI — needs
   `gh auth login`).
3. `npm publish --access public` (first publish requires
   `npm login` and the package name to be available).
4. Tag the release: `git tag v<version> && git push --tags`.

## Configuration deployed alongside

The plugin reads `~/.config/opencode/session-namer.json` at startup. See the
README for all keys. A typical local setup enabling LLM shortening:

```json
{
  "smartShorten": true
}
```
