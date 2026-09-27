# Releasing

Releases are managed with Changesets and
`.github/workflows/release.yml`.

## One-time repository setup

1. Enable npm two-factor authentication for maintainers.
2. Configure npm trusted publishing for this GitHub repository when available.
3. Until trusted publishing is configured, add an automation token as the
   `NPM_TOKEN` repository secret.
4. Protect `main` and require the CI and CodeQL checks.
5. Restrict modifications to release workflows and package metadata through
   CODEOWNERS or branch protection.

## Preparing a change

Add a changeset with:

```bash
npm run changeset
```

Commit the generated `.changeset/*.md` file with the implementation.

## Publishing

When changesets reach `main`, the release workflow opens or updates a release
pull request. That pull request applies package versions and changelogs.

Merging the release pull request runs the full production gate and publishes
`grafyx` with npm provenance. The workflow also creates the corresponding
Git tag and GitHub release through Changesets.

## Manual verification

Before merging a release pull request:

```bash
npm ci
npm run ci
npx changeset status
```

After publication, install the registry artifact in a clean project and test
all four entry points:

- `grafyx`
- `grafyx/graph`
- `grafyx/reactive`
- `grafyx/advanced`

Do not publish directly from a developer workstation except during an explicit
release-recovery procedure.
