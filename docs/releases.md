# Versions and releases

A push to `main` runs [`.github/workflows/release.yml`](../.github/workflows/release.yml). The
workflow mints a token for the shared releaser app, the GitHub App Kinglet already uses, and
passes that token to release-please. The owner renames that app, and both repositories
mint a token from that one app. Renaming keeps the same app id and private key. The workflow
names the app through the secrets `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY`.

When the commits since the last release include a version bump, release-please opens one pull
request titled `chore: release X.Y.Z`. Later pushes to `main` update that pull request until
it is merged. A merge whose commits are only documentation, chores, refactors, or tests does
not open a new release pull request on its own.

The pull request sets the version in `package.json` and `.release-please-manifest.json`, and
writes the notes in `CHANGELOG.md`. A `feat:` commit bumps the minor version. A `fix:` commit
bumps the patch version. A `feat!:` commit or a `BREAKING CHANGE:` footer bumps the major
version. Documentation, chores, refactors, and tests stay out of the changelog.

Merging that pull request is what publishes the release. release-please tags `vX.Y.Z` and
opens a GitHub Release whose notes are the new changelog section. The tag is the versioned
artifact a self-hoster checks out.

```bash
git fetch origin tag v0.1.0
git checkout v0.1.0
```

`CHANGELOG.md` at that tag is the same text as the GitHub Release.

A hosted Fly.io deploy keeps its current configuration and its current trigger. This
workflow does not call it.

## Before the first run

Install that same GitHub App on this repository, then set the Actions secrets `RELEASE_APP_ID`
and `RELEASE_APP_PRIVATE_KEY` to the app's id and private key. Kinglet's release workflow
already uses those two secrets for this app. Until the secrets are set, the token step fails
and no release pull request opens.

## Example

`package.json` is `0.0.1`. On 22 November 2026, `main` at `8afb4c5` has feature commits and no
breaking change, so the first release pull request is `chore: release 0.1.0`. Its changelog
lists those features, including "Hold one lock while pending migrations run". Merging that
pull request tags `v0.1.0`. A self-hoster checks out `v0.1.0` and reads `CHANGELOG.md`.
