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

## Install from npm

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": ["@maximtop/opencode-session-namer"]
}
```

opencode installs npm plugins automatically at startup (cached in
`~/.cache/opencode/node_modules/`).

## Release

Releases are automated: pushing a `v*` tag runs
[.github/workflows/release.yml](.github/workflows/release.yml) — checks,
npm publish (OIDC trusted publishing), GitHub Release with generated notes.

1. Bump `version` in `package.json`, land it on `master` with green CI.
2. `git tag v<version> && git push origin v<version>`.
3. Watch the run: `gh run watch`.

The tag must match the `package.json` version (the workflow fails
otherwise). To re-run a failed release for an existing tag:
`gh workflow run release.yml -f tag=v<version>`.

### One-time setup (done for v0.1.0)

Trusted publishing can only be configured on an existing package, so
v0.1.0 was published by hand, once: `npm login && npm publish --access
public` from the tag commit. Then a trusted publisher was added on
npmjs.com → package → Settings → Publishing access: GitHub Actions,
repository `maximtop/opencode-session-namer`, workflow `release.yml`.

## Configuration deployed alongside

The plugin reads `~/.config/opencode/session-namer.json` at startup. See the
README for all keys. A typical local setup enabling LLM shortening:

```json
{
  "smartShorten": true
}
```
