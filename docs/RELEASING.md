# Releasing

Releases are managed with Changesets. Version and publish from a maintainer
checkout with the scripts below.

## One-time repository setup

1. Enable npm two-factor authentication for maintainers.
2. Configure npm trusted publishing for this GitHub repository when available.
3. Until trusted publishing is configured, add an automation token as the
   `NPM_TOKEN` repository secret.
4. Protect `main` and require the CI and CodeQL checks.
5. Restrict modifications to package metadata through CODEOWNERS or branch
   protection.

## Preparing a change

Add a changeset with:

```bash
npm run changeset
```

Commit the generated `.changeset/*.md` file with the implementation.

## Publishing

On `main`, apply pending changesets and publish:

```bash
npm ci
npm run version-packages
npm run release
```

`npm run release` runs the production gate, then `changeset publish`, which
publishes `grafyx` and creates the Git tag.

## Manual verification

Before publishing:

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
