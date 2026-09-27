# Contributing

## Prerequisites

- Node.js 20 or newer
- npm 11.13.0

Install the locked dependency tree:

```bash
npm ci
```

## Development checks

```bash
npm test
npm run test:coverage
npm run lint
npm run format:check
npm run typecheck
npm run build
npm run package:smoke
```

`npm run ci` runs all required checks.

## Tests

Tests use the Node.js test runner with `tsx` for TypeScript loading. Add test
files under an existing `test/` directory with the `.test.ts` suffix; the main
test command discovers them automatically.

Every bug fix should include a regression test. Public API changes must update
`test/public-api.test.ts` and the package smoke test when appropriate.

## Public API changes

Application APIs belong in `grafyx`, `grafyx/graph`, or
`grafyx/reactive`. Low-level extension primitives belong in
`grafyx/advanced`. Avoid exporting implementation details from the
package root.

## Changesets

User-visible changes require a changeset:

```bash
npm run changeset
```

Choose the smallest SemVer bump that accurately describes the compatibility
impact. Breaking changes to any published entry point require a major bump
after 1.0.

## Pull requests

Keep changes focused, document observable behavior, and include benchmark
evidence for hot-path changes. Do not commit generated `dist` artifacts or npm
tarballs.
