# Implementation Plan: Release & PR CI automation (GitHub Actions)

- **Created**: 2026-09-04
- **Status**: Implemented (all 10 tasks done; v0.1.1 released via the pipeline)
- **Type**: Configuration (CI/CD)
- **Input**: «давай прикрутим автоматизацию пром» — automate releases (tag → checks → npm publish → GitHub Release) and add CI checks on PRs, via a PR.

## Problem

The repo has no CI at all (`.github/` does not exist). Releases are a manual
4-step checklist in `DEPLOYMENT.md` (lines 54–61), easy to do wrong and
invisible until done. v0.1.0 was tagged and released on GitHub manually;
npm publish of v0.1.0 is still pending. PRs to master get no automated
lint/type-check/test feedback.

## Research Findings

Explored the repo (read-only). Key facts with evidence:

- `package.json`: scripts are `lint` (`eslint .`), `type-check`
  (`tsc --noEmit`), `test` (`vitest run`) — lines 12–16. No
  `packageManager`, `engines`, or `publishConfig` fields. `version: 0.1.0`,
  `files: ["src", "README.md", "LICENSE"]` (whitelist — tarball already
  verified clean: 16 files, 22.7 kB).
- `Makefile`: `check: lint type-check test` (line 15) — single entry point
  for CI.
- `pnpm-lock.yaml`: `lockfileVersion: '9.0'` → pnpm 9/10 compatible. Pin
  pnpm 10 in CI (`pnpm/action-setup@v4` with `version: 10`, since
  `packageManager` is absent).
- Tests call the real `gh` CLI: single call site `src/github.ts:39`
  (`gh pr view <N> --repo <o>/<r> --json title,headRefName`), 15 s per-call
  timeout (`github.ts:11`), all public-repo reads → the default
  `GITHUB_TOKEN` in Actions suffices via `GH_TOKEN` env (gh reads it
  automatically). 13 tests hit gh, each with a 30 s cap; suite runs ~25 s
  locally.
- Toolchain floor: vite 8.2.2 / vitest 4.1.11, `@types/node` 24 → Node 24
  is a safe runner version. Node 24 ships npm 11.x; npm trusted publishing
  requires npm CLI ≥ 11.5.1 (pin with an explicit upgrade step).
- Default branch: `master`. No branch protection configured.
- No `.github/`, no `.nvmrc`.

### Root Cause

N/A (not a bug). Change needed: two workflow files + doc updates.

### Patterns to Follow

- PR-driven changes to master (PR #1, #2 precedent) — this change also goes
  through a PR.
- `DEPLOYMENT.md` is the deployment source of truth — its Release section
  must describe the new flow.
- `AGENTS.md` project-structure tree must list new top-level entries
  (comment column aligned at index 31, per existing entries).

### Edge Cases

- **OIDC chicken-and-egg**: npm trusted publishing can only be configured
  on an *existing* package → the very first publish (v0.1.0) must be manual
  (`npm login` locally). Trusted publisher is configured after that, then
  all future tags publish from CI.
- **Tag/version mismatch**: pushing `v0.2.0` while `package.json` still
  says `0.1.0` must fail loudly → guard step compares them.
- **Re-run of a failed release**: `npm publish` fails if the version
  already exists, `gh release create` fails if the release exists — visible
  failures, retried via `workflow_dispatch` with the tag as input.
- **Tests in CI need gh auth**: set `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`
  explicitly in the check steps of both workflows.
- **npm provenance** requires a public repo (yes) and
  `id-token: write` + `attestations: write` permissions.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `.github/workflows/ci.yml` | Create | Lint/type-check/test on PRs and pushes to master |
| `.github/workflows/release.yml` | Create | Tag `v*` (or manual dispatch) → checks → npm publish (OIDC) → GitHub Release |
| `DEPLOYMENT.md` | Modify (lines 54–61) | New release flow + one-time trusted-publisher setup |
| `README.md` | Modify (lines 1, 29) | CI + npm badges; drop “(once published)” |
| `package.json` | Modify | Add `repository`/`bugs`/`homepage` (required by npm `--provenance`) |
| `AGENTS.md` | Modify (structure tree) | Add `.github/workflows/` entry |

## Solution

Two workflows:

1. **ci.yml** — `pull_request`/`push` to `master`: checkout → pnpm 10 →
   Node 24 (pnpm cache) → `pnpm install --frozen-lockfile` → `make check`
   with `GH_TOKEN` from `GITHUB_TOKEN`. `concurrency` cancels stale runs
   per ref.
2. **release.yml** — `push` of tag `v*`, plus `workflow_dispatch` with a
   required `tag` input (re-run/recovery path). Steps: checkout the tag →
   guard `tag == v$(package.json version)` → pnpm/Node install →
   `make check` → `npm i -g npm@^11.5.1` → `npm publish --provenance
   --access public` (OIDC trusted publishing, **no** `NODE_AUTH_TOKEN`) →
   `gh release create --generate-notes` (notes from merged PRs).

Publish runs before release creation so a failed publish never leaves a
GitHub release whose notes promise an npm install that does not exist.

### Alternatives Considered

- **NPM_TOKEN secret instead of OIDC** — rejected by user preference;
  OIDC trusted publishing has no long-lived secret to leak/rotate.
- **Separate `test` and `publish` jobs** — rejected: one job is ~2 min;
  a second job would re-checkout/re-install for no isolation gain.
- **Auto release notes vs handwritten** — auto-generated from PR titles;
  the repo is PR-driven, so notes stay accurate by construction.

## Tasks

### [x] Task 1: Create `.github/workflows/ci.yml`

**Files:**

- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Ensure actionlint is available (workflow linter)**

Run: `command -v actionlint || brew install actionlint`
Expected: `actionlint` on PATH (`/opt/homebrew/bin/actionlint`).

- [ ] **Step 2: Create the workflow file**

Create `.github/workflows/ci.yml` with exactly:

```yaml
name: CI

on:
  pull_request:
    branches: [master]
  push:
    branches: [master]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Lint, type-check, test
        run: make check
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 3: Lint the workflow**

Run: `actionlint .github/workflows/ci.yml`
Expected: no output, exit code 0.

**Verification**: `actionlint` passes on the new file.

### [x] Task 2: Create `.github/workflows/release.yml`

**Files:**

- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create the workflow file**

Create `.github/workflows/release.yml` with exactly:

```yaml
name: Release

on:
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      tag:
        description: Existing tag to release (e.g. v0.1.0)
        required: true
        type: string

permissions:
  contents: write      # gh release create
  id-token: write      # npm OIDC trusted publishing
  attestations: write  # npm publish --provenance

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.tag || github.ref_name }}

      - name: Verify tag matches package.json version
        run: test "v$(node -p "require('./package.json').version")" = "$TAG"
        env:
          TAG: ${{ inputs.tag || github.ref_name }}

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
          registry-url: https://registry.npmjs.org

      - run: pnpm install --frozen-lockfile

      - name: Lint, type-check, test
        run: make check
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Ensure npm CLI supports trusted publishing
        run: npm install -g npm@^11.5.1

      - name: Publish to npm (OIDC trusted publishing)
        run: npm publish --provenance --access public

      - name: Create GitHub release
        run: gh release create "$TAG" --verify-tag --generate-notes
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAG: ${{ inputs.tag || github.ref_name }}
```

- [ ] **Step 2: Lint the workflow**

Run: `actionlint .github/workflows/release.yml`
Expected: no output, exit code 0.

**Verification**: `actionlint` passes; file name is exactly `release.yml`
(must match the trusted-publisher config on npmjs.com later).

### [x] Task 3: Rewrite the Release section in DEPLOYMENT.md

**Files:**

- Modify: `DEPLOYMENT.md:54-61`

- [ ] **Step 1: Replace the Release section**

Replace lines 54–61 (the `## Release` header through the 4 manual steps)
with:

```md
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

### One-time setup (before the first automated release)

Trusted publishing can only be configured on an existing package, so
v0.1.0 is published by hand, once:

1. From the repo at the v0.1.0 commit: `pnpm install && npm login &&
   npm publish --access public`.
2. On npmjs.com → package → Settings → Publishing access → add a trusted
   publisher: GitHub Actions, repository `maximtop/opencode-session-namer`,
   workflow filename `release.yml`.
```

**Verification**: `sed -n '54,80p' DEPLOYMENT.md` shows the new section;
no other lines changed (`git diff DEPLOYMENT.md` shows only this block).

### [x] Task 4: README badges and npm-install wording

**Files:**

- Modify: `README.md:1` (after the title line) and `README.md:29`

- [ ] **Step 1: Add badges after the H1**

Insert directly after line 1 (`# opencode-session-namer`), separated by a
blank line:

```md
[![CI](https://github.com/maximtop/opencode-session-namer/actions/workflows/ci.yml/badge.svg)](https://github.com/maximtop/opencode-session-namer/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@maximtop/opencode-session-namer)](https://www.npmjs.com/package/@maximtop/opencode-session-namer)
```

- [ ] **Step 2: Drop the “(once published)” caveat**

In line 29, change `From npm (once published):` to `From npm:`.

The wording becomes true when v0.1.0 is published (Task 8) — same day as
this PR lands.

**Verification**: `grep -n "badge.svg\|From npm:" README.md` shows the two
badge lines and the updated install header.

### [x] Task 5: Add repository metadata to package.json

**Files:**

- Modify: `package.json` (after the `"license"` line)

- [ ] **Step 1: Add repository, bugs, homepage**

After `"license": "MIT",` insert:

```json
  "repository": {
    "type": "git",
    "url": "git+https://github.com/maximtop/opencode-session-namer.git"
  },
  "bugs": "https://github.com/maximtop/opencode-session-namer/issues",
  "homepage": "https://github.com/maximtop/opencode-session-namer#readme",
```

`repository` is **required** for `npm publish --provenance`: npm compares it
against the OIDC token's repository claim and fails the publish on a
mismatch (or absence). `bugs`/`homepage` are what npmjs.com renders as the
package's links.

- [ ] **Step 2: Verify the tarball still packs the same files**

Run: `npm pack --dry-run 2>&1 | grep -c "^npm notice.*kB"` → still 16
entries; `node -e "JSON.parse(require('fs').readFileSync('package.json'))"`
exits 0.

**Verification**: valid JSON; `npm pack --dry-run` unchanged (16 files).

### [x] Task 6: Add `.github/workflows/` to the AGENTS.md structure tree

**Files:**

- Modify: `AGENTS.md` (structure tree, before the `├── tests/` line)

- [ ] **Step 1: Insert the tree entry**

Insert one line immediately before `├── tests/session-namer.test.ts # …`
(comment column aligned with the existing entries — `#` at column index
31):

```text
├── .github/workflows/         # PR checks; tag-triggered npm publish + release
```

**Verification**: the rendered tree keeps aligned comments
(`python3 -c "print(open('AGENTS.md').read().splitlines()[i].index('#'))"`
returns 31 for every tree line with a comment).

### [x] Task 7: Full local verification

**Files:** none (verification only)

- [ ] **Step 1: Lint both workflows**

Run: `actionlint .github/workflows/*.yml`
Expected: no output, exit code 0.

- [ ] **Step 2: Run the repo checks**

Run: `make check`
Expected: eslint clean, tsc clean, 46/46 tests pass (PR test cases hit the
real gh CLI — local `gh auth` must be active).

**Verification**: both commands green.

### [x] Task 8: One-time manual publish of v0.1.0 + trusted publisher setup

**Files:** none (user-side, requires interactive `npm login`)

- [ ] **Step 1: Publish v0.1.0 manually**

From master — it currently points exactly at the v0.1.0 tag commit
(`2b209e7`), so the published artifact matches the tag. Do this **before**
merging the automation PR (Task 9), which moves master past the tag:

```sh
pnpm install
npm login
npm publish --access public
```

Expected: `+ @maximtop/opencode-session-namer@0.1.0`.

- [ ] **Step 2: Configure the trusted publisher on npmjs.com**

npmjs.com → `@maximtop/opencode-session-namer` → Settings → Publishing
access → Trusted publishers → GitHub Actions:

- Repository owner: `maximtop`
- Repository: `opencode-session-namer`
- Workflow filename: `release.yml`
- Environment: (leave empty)

**Verification**: `npm view @maximtop/opencode-session-namer version`
prints `0.1.0`; the trusted publisher entry exists in package settings.

### [x] Task 9: Open the PR, watch CI, merge — PR #4 merged (ddec228)

**Files:** none (git/GitHub only)

- [ ] **Step 1: Push the branch and open the PR**

```sh
git switch -c ci-release-automation
git add .github/workflows DEPLOYMENT.md README.md AGENTS.md package.json
git commit -m "Add CI and release automation: PR checks, tag-triggered npm publish via OIDC"
git push -u origin ci-release-automation
gh pr create --base master --title "Add CI and release automation" --body "## What

Two workflows: \`ci.yml\` (lint/type-check/tests on PRs and pushes to master) and \`release.yml\` (push of tag \`v*\` → checks → \`npm publish --provenance\` via OIDC trusted publishing → GitHub Release with generated notes).

## Why

No CI existed; releases were a manual 4-step checklist. OIDC trusted publishing avoids a long-lived NPM_TOKEN secret.

## Alongside this PR (one-time, manual — Task 8)

1. Publish v0.1.0 by hand from master (\`npm login && npm publish --access public\`) — trusted publishing requires an existing package.
2. Configure the trusted publisher on npmjs.com: repo \`maximtop/opencode-session-namer\`, workflow \`release.yml\`.

release.yml end-to-end verification happens at the next real tag; ci.yml verifies itself on this PR."
```

- [ ] **Step 2: Watch the CI run on the PR (live verification of ci.yml)**

Run: `gh pr checks --watch`
Expected: the `CI / check` job appears and goes green (the workflow runs
on this very PR — this is the live test of ci.yml).

- [ ] **Step 3: Merge**

Run: `gh pr merge --merge`
Expected: PR merged; `release.yml` is now the default-branch workflow
(dispatch-enabled).

**Verification**: PR merged; Actions tab shows a green `CI` run for the
merge commit on master.

### [x] Task 10: End-to-end verification at the next real tag — v0.1.1 released via the pipeline (run 34135532536 green; npm 0.1.1 + provenance attestation; GitHub Release created)

**Files:** none

- [ ] **Step 1: On the next release, verify the full chain**

After any future version bump lands on master:

```sh
git tag v<next> && git push origin v<next>
gh run watch
```

Expected: release.yml run goes green — checks pass, npm shows the new
version (`npm view @maximtop/opencode-session-namer version`), the GitHub
Release appears with generated notes.

**Verification**: npm version and GitHub Release both exist for the tag.

## Final Verification

- [ ] `actionlint .github/workflows/*.yml` — clean
- [ ] `make check` — clean (lint, tsc, 46/46 tests)
- [ ] CI run on the PR — green
- [ ] `npm view @maximtop/opencode-session-namer version` → `0.1.0` (after Task 8)
- [ ] Trusted publisher configured (after Task 8)
- [ ] Next tag: release.yml publishes + releases automatically (Task 10)

## Notes

- The workflows change nothing about the local symlink install; they are
  CI-only.
- No version bump for this change — it ships no plugin code.
- `permissions:` in ci.yml is read-only by design; release.yml gets
  `contents: write` + OIDC permissions only.
- If npm later requires an Environment on the trusted publisher, create a
  GitHub Environment named e.g. `npm`, add `environment: npm` to the
  release job, and put the same name in the npmjs.com trusted-publisher
  entry. Deliberately skipped now (YAGNI).
- Assumption: the npm account `maximtop` has 2FA enabled (required by npm
  for publishing) and rights to publish under the `@maximtop` scope.
