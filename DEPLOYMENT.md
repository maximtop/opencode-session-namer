# Deployment

## Local V1 install (from a checkout)

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

## Local V2 install (from a checkout)

Clone the same repository and run `pnpm install`. In the V2 configuration,
register the absolute `src` directory, not an individual file:

```json
{
  "plugins": ["/absolute/path/opencode-session-namer/src"]
}
```

V2 resolves `server.ts` in that directory. Restart V2 and wait for the plugin
to become active before opening the test chat. Do not also register the npm
package. Existing V1 symlinks remain on `src/index.ts`.

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

For a V1 checkout, remove the symlink and restart opencode:

```sh
rm ~/.config/opencode/plugins/session-namer.ts
```

For V2, remove the entry from `plugins` and restart the host. For an npm
installation on V1, remove the entry from `plugin`.

The config and state files (`~/.config/opencode/session-namer*.json`) stay in
place; remove them too if the plugin should forget all processed sessions.

## Install from npm

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": ["@maximtop/opencode-session-namer"]
}
```

V1 uses the singular `plugin` key above. V2 uses:

```json
{
  "plugins": ["@maximtop/opencode-session-namer"]
}
```

The host installs npm plugins automatically. V2 installation is asynchronous;
wait for the plugin to become active before running acceptance scenarios.
The same package selects the appropriate host integration automatically.

## Compatibility gate

Verified targets: V1 1.18.27, V1 1.18.32 and V2 2.0.14. Before publishing,
run `make check` and test one packed archive on all three real hosts. Record
its SHA-256, host versions, package and checkout loading, first-message
naming, manual-title protection and restart results. Mock tests alone do not
establish host loading compatibility.

Use disposable home/config/data/cache/state directories and absolute binary
paths. Never install or activate a test host globally, change shell PATH or
aliases, or point it at working credentials, databases or OpenChamber.
Compare `zsh -lic 'type -a opencode; opencode --version'` before and after;
the primary command and version must remain unchanged. Terminate only the
processes started for the test.

The CLI umbrella packages require their install hook to prepare their
launcher. When installing with `--ignore-scripts`, invoke the executable
inside the official platform package directly, such as
`opencode-darwin-arm64/bin/opencode` or
`@opencode/cli-darwin-arm64/bin/opencode`, under the isolated installation.
Do not fall back to a global install.

On V2, initialize the test location and wait for exactly one active
`session-namer` entry from `GET /api/plugin` before creating the session under
test. Encode its directory query as `location[directory]`. Use a controlled
local provider for model responses; do not copy working API keys into tests.
The expected basic title in a `CompatibilityProject` fixture on `fix/AG-123`
after the first message `Fix crash` is:

```text
[CompatibilityProject] AG-123 Fix crash
```

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
- `CHANGELOG.md` is managed by release-please from the first release on;
  never edit released sections by hand.

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
