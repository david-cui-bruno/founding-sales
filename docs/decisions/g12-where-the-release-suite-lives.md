# The release suite is `test/release/**/*.check.ts`, and the old gates do not see it

**Lane:** G12 · **Files:** `vitest.release.config.ts`, `test/release/tsconfig.json`, `tsconfig.json`, `eslint.config.mjs`, `scripts/lintTracked.mjs`, `package.json`

## The problem

The brief puts the Appendix G suite at `test/release/**`. That path is inside the old
trees' reach in three separate ways, and each one breaks differently:

1. **vitest.** The repository root has no vitest configuration, so `npm test` collects
   every `**/*.test.ts` outside a workspace package. `apps/` and `packages/` are
   workspace members and are skipped; `test/release` is not, so the old gate — on a
   macOS runner with no PostgreSQL 16 — would have tried to run the release suite.
2. **tsc.** Root `tsconfig.json` excludes `cloud`, `client`, `apps` and `packages` and
   nothing else, with `moduleResolution: node`, which cannot read `@fss/domain`'s
   `exports` map. Every import in the suite would have been an error in
   `npm run typecheck`.
3. **eslint.** `scripts/lintTracked.mjs` skips `^(apps|packages)/` and lints everything
   else with `eslint.config.mjs`, whose import resolver does not know the workspace
   aliases either.

## The decision

The files carry the suffix `.check.ts` rather than `.test.ts`, and the directory is
excluded from all three old gates the same way `apps/` and `packages/` already are:

| Gate | Change |
|---|---|
| `tsconfig.json` | `"test/release"` added to `exclude` |
| `eslint.config.mjs` | `'test/release/**'` added to `ignores`, beside `'apps/**'` |
| `scripts/lintTracked.mjs` | one line mirroring the existing `apps|packages` skip |
| `test/lintTracked.test.mjs` | the new exclusion pinned, as the others are |

and the greenfield chain picks the directory up instead: `typecheck:greenfield` adds
`tsc -p test/release/tsconfig.json`, `lint:greenfield` adds `test/release` to its
targets, and `gate:greenfield` ends with `npm run test:release`.

The suffix is the part worth explaining. `*.check.ts` does not match vitest's default
`include`, so the old root run cannot collect the suite even by accident — and unlike
the three exclusions above, that property survives somebody adding a root vitest
configuration later for an unrelated reason. Belt and braces, on a boundary where the
failure mode is "the old CI starts trying to run a PostgreSQL suite on a macOS runner"
and the symptom is a timeout nobody can place.

## What was considered and rejected

**Putting the suite in a new workspace package.** `packages/release` would have been
picked up by every existing greenfield script for free. It was rejected because the
brief names `test/release/**` and because a *package* implies something importable; the
release suite is not a library and nothing should ever depend on it.

**Editing the root `test` script to exclude the directory.** Vitest's CLI `--exclude`
replaces `test.exclude` rather than adding to it, which would have dropped
`**/node_modules/**` and made the old gate walk the dependency tree.

**Adding a root `vitest.config.ts` that reproduces the defaults plus one exclusion.**
The defaults are a moving target across vitest versions, and `test/test-discovery.test.mjs`
asserts what the old run collects. A configuration file that had to keep matching the
defaults exactly is a maintenance burden with no upside over a file suffix.
