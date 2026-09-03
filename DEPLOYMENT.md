# Deployment

## Local install (from a checkout)

```sh
git clone https://github.com/maximtop/opencode-session-namer
ln -s "$PWD/opencode-session-namer/src/index.ts" \
  ~/.config/opencode/plugins/session-namer.ts
```

Restart opencode / OpenChamber to load the plugin. Edits in the checkout take
effect on the next restart.

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
2. `make check` must pass.
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
