# G0: keeping the old gate off the greenfield tree

**Decision.** Four files outside the G0 ownership list carry a one-line additive
exclusion of `apps/` and `packages/`, and one old test gains two fixture paths.

| File | Change |
|---|---|
| `tsconfig.json` | `"apps"` and `"packages"` added to `exclude` |
| `vitest.config.mts` | `'apps/**'` and `'packages/**'` added to `test.exclude` |
| `eslint.config.mjs` | `'apps/**'` and `'packages/**'` added to the global `ignores` |
| `scripts/lintTracked.mjs` | `!/^(?:apps\|packages)\//` added to the tracked-source filter |
| `test/lintTracked.test.mjs` | two paths added to the list the fixture expects to be filtered out |

**Why this was not avoidable.** COMMON-G says "the old CI job stays untouched". Left
alone it would not have been:

* the root `tsconfig.json` has no `include`, so `npm run typecheck` would compile the
  new ESM, `moduleResolution: Bundler` sources under the old loose settings and fail;
* the root Vitest config would collect `apps/**` and `packages/**` test files, so
  `npm test` on the macOS runner would try to start a PostgreSQL cluster;
* `scripts/lintTracked.mjs` passes **every tracked source file** to ESLint with
  `--no-ignore`, so the ESLint `ignores` entry alone is not enough — the filter in the
  script is what actually keeps the new files out of `npm run lint:tracked`.

Each change is additive and mirrors an exclusion the file already had for
`cloud/lambdas/**` or `client/**`. The old gate's behaviour on the old trees is
unchanged; `test/lintTracked.test.mjs` was extended so the new exclusion is itself
tested rather than asserted in a commit message.

**Also added at the root, outside the literal ownership list:**

* `eslint.greenfield.mjs` — the greenfield flat config. ESLint 9 reads one config from
  the working directory and does not cascade, so a config inside `packages/domain/`
  would never be used by a root-level run. A root file named for the tree it governs
  was the smallest arrangement that keeps the two configs from ever seeing the same
  file.
* `scripts/greenfieldServiceClusterCheck.mjs` — a developer tool that runs the gate
  against a service-container-style cluster. Nothing in the product or in CI reads it.

**Reported to the coordinator** rather than assumed: if any of these five files is
owned by another lane in this batch, this lane's version is a one-line addition and
should merge cleanly, but the coordinator should sequence it.
