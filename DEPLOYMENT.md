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

Releases are automated with
[release-please](https://github.com/googleapis/release-please):

1. Commits to `master` follow
   [Conventional Commits](https://www.conventionalcommits.org) (`feat:`,
   `fix:`, `chore:` …). A `feat` or `fix` commit makes release-please open or
   update a release PR.
2. The release PR bumps `version` in `package.json` and updates
   `CHANGELOG.md`; review and merge it.
3. On merge, release-please creates the tag and GitHub Release with generated
   notes, and the same run of
   [.github/workflows/release.yml](.github/workflows/release.yml) runs the
   checks and publishes to npm via OIDC trusted publishing.

To re-publish a failed release for an existing tag:
`gh workflow run release.yml -f tag=v<version>`.

Release settings:

- `release-please-config.json` holds the release strategy; released versions
  are tracked in `.release-please-manifest.json`.
- The npm trusted publisher must keep pointing at the `release.yml` workflow
  file.
- Repository setting "Allow GitHub Actions to create and approve pull
  requests" is enabled (Settings → Actions → General).
- The release PR is opened by `github-actions[bot]`, so by default no CI runs
  on it (GitHub suppresses workflow runs for `GITHUB_TOKEN`-created events).
  The publish run re-checks the tagged commit with `make check` before
  publishing. To run CI on release PRs, add a PAT as the
  `RELEASE_PLEASE_TOKEN` secret; the workflow picks it up automatically.

**Bootstrap note**: the `## [Unreleased]` section in `CHANGELOG.md` predates
release-please. When the first release PR appears, move that entry into the
generated version section and delete the `## [Unreleased]` section;
release-please manages the changelog from then on.

### One-time setup (done for v0.1.0)

Trusted publishing can only be configured on an existing package, so
v0.1.0 was published by hand, once:
`npm login && npm publish --access public` from the tag commit. Then a
trusted publisher was added on
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
