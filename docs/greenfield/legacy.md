# The previous-generation app: what remains, and how to run it

The greenfield product is `apps/api`, `apps/worker`, `apps/desktop`, `packages/contracts`,
`packages/domain`, `infra/` and `test/release`. Everything else at the top of the
repository is the **previous generation**: the local-first Electron app with its
encrypted SQLite database (`src/`), the thin client of the 18 September rebuild plan
(`client/`), the delegated worker Lambda and its Terraform (`cloud/`), the Swift phone
helper and the `safe-log-fs` Node addon (`native/`), and their tests (`tests/`,
`test/*.test.*`) and tooling (most of `scripts/`, the root Forge, Vite, Vitest,
Playwright, ESLint and TypeScript configs).

David does not use the old app (decided 19 September 2026), and the greenfield stack is
what runs in production. The old code stays in the tree because no decision deletes it
yet (below). Since lane g89 (25 September 2026, audit item G10) it no longer runs by
default: not on `npm ci`, not behind the bare `npm` commands, and in CI only when a
change touches it.

## What changed in lane g89

- **The bare root commands are greenfield.** `npm run typecheck` is
  `typecheck:greenfield`; `npm run lint` is `lint:greenfield` plus `lint:root-scripts`
  (the greenfield scripts at the root: `eslint.greenfield.mjs`,
  `scripts/productionSmoke.mjs`, `scripts/releaseMutationCheck.mjs` and
  `scripts/releaseMutationRunner.mjs`, under the root ESLint config that has always
  linted them); `npm test` is `test:greenfield` plus `test:release`. There is no
  `npm start`: nothing greenfield is a development runner, and the old one is
  `npm run legacy:start`. `npm run gate:greenfield` is unchanged.
- **Every old script is `legacy:<its old name>`.** The one exception is
  `verify:secrets`, the Gitleaks scan of the history and the tree, which guards the whole
  repository and kept its name. `test/release/rootScripts.check.ts` holds this shape.
- **`npm ci` builds nothing of the old app.** The root `postinstall` is only
  `install-electron` (the Electron binary, which `docs/greenfield/install.md` says the
  desktop host tests need; the package step does not). The two steps it used to run after that, the `safe-log-fs` node-gyp build
  and the SQLite driver rebuilds for Node and for Electron, are `npm run legacy:setup`.
  The SQLite driver is still a root dependency, so its own install script still fetches
  its prebuilt Node binary during `npm ci` (about 2 MB, no compiler).
- **CI runs the old gates only when the old trees change.** See "In CI" below.

## What remains, and why it stays

`DELETION-MAP-20260918.md` (the reachability audit of 18 September, in the
coordinator's `.context/` notes rather than in the repository) is the authority for what may be deleted, and David's answers of 18 September are the
decisions on it. Everything it allowed to go now is gone; everything that remains is
either a row it keeps or one that can go only after a dependency moves, and it says
nothing about deleting the trees as a whole.

| Path | What it is | Why it is still here |
|---|---|---|
| `src/` | The old desktop app: Electron main, preload, renderer, encrypted SQLite, migrations, domain | Only its dead parts were authorised for deletion ("Safe to delete now", D1a–D1f, plus LinkedIn, meetings and the Apple spike and supervisor). Lanes 44–46 deleted them on 18 September. The rest is "Delete after replacing one dependency" (D2: lifecycle, cadence, prioritization, identity, events, source, the outbound repository, portfolio, jobs) or "Core, keep" (D3: backup, recovery, operations, communications). Nothing has moved those dependencies, and David paused old-shape work (C5) rather than schedule it. |
| `src/main/domain/discovery/discoveryEvidence.ts`, `discoveryTypes.ts`, `src/main/domain/conversations/`, `src/main/jobs/discoveryRecovery.ts` | Leftovers of the D1a discovery graph | Listed as safe to delete, but lane 44 found them still reached (`getLeadDetail` → `getEnrichmentRequestCandidate` → `collectDiscoveryEvidence`; `jobRepository.ts` imports `discoveryRecovery.ts`) and kept them (commit `a0bb21da`). |
| `cloud/` | The delegated worker Lambda, its Terraform module and root | The map's only worker deletion that could go now (`researchCycle.ts`, D1e) is gone; `researchProduction.ts`'s operator half is D2. The worker is still deployed in the shared account until its own cutover (`docs/greenfield/accounts.md`, `docs/greenfield/carry-runbook.md`). |
| `client/` | The thin client of the 18 September rebuild plan (slice S6) | Not in the map, which predates it. |
| `native/apple-bridge/`, `contracts/apple-bridge/` | The Swift phone helper and its protocol | The map keeps `helperPath.ts` and `verifyHelperSignature.ts`, which verify this helper (B3, D3). |
| `native/safe-log-fs/` | A Node addon the old app's logging uses | Not in the map. |
| `tests/`, `test/*.test.*` | The old app's tests and its release tooling's tests | They test code that stays. |
| `scripts/` except the three greenfield scripts above | The old app's build, package, release, backup and scan tooling | They build and check code that stays. `scripts/verifySecrets.mjs` is shared. |
| Root `forge.config.ts`, `forge.env.d.ts`, `vite.*.config.ts`, `vitest.config.mts`, `playwright.config.mjs`, `eslint.config.mjs`, `tsconfig.json`, `knip.json`, `assets/`, `build/`, and `package.json`'s `main`, `productName` and `description` | The old app's build configuration | `npm run legacy:package` reads them. `eslint.config.mjs` also lints the four greenfield root files. |
| `.github/workflows/release.yml` | The old app's exact-SHA release gate (dispatch only) | It runs `npm run legacy:verify:release`. |
| `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/engineering/`, `docs/cutover/`, `docs/archive/`, `.superpowers/` | The old app's documentation and history | They describe code that stays. The old tests read `docs/engineering/release.md` and `docs/archive/`. |

Deleting any of this is David's decision, not a lane's. The D2 rows each name the one
dependency to move first; the whole-tree deletion was planned as slice S7 of the
18 September rebuild and never scheduled.

## How to run it

On an Apple Silicon Mac with Node 24 first on `PATH`:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH"
npm ci --no-audit --no-fund
npm run legacy:setup                  # safe-log-fs, and the SQLite driver for Node and for Electron
while IFS= read -r -d '' lock; do     # each Lambda package is its own npm project
  npm ci --prefix "${lock%/package-lock.json}" --no-audit --no-fund
done < <(git ls-files -z -- 'cloud/lambdas/*/package-lock.json')
npx playwright install chromium       # only for the browser specs
```

`legacy:setup` needs what the old `postinstall` needed: Xcode's command-line tools for
node-gyp, and the network the first time, for the Node and Electron headers. Then, for
example:

```bash
npm run legacy:verify                 # legacy:typecheck, legacy:lint:tracked, legacy:test
npm run legacy:test:browser:native-desk
npm run legacy:start                  # Electron Forge dev app against your own local profile
```

`legacy:start` creates an encrypted SQLite workspace under
`~/Library/Application Support/Callie Founder Sales System/`; the tests never touch it.
The release gate, the pre-release backup, fuses and signing are
`docs/engineering/release.md`. The client package has its own install and scripts
(`npm ci --prefix client`, then `npm run typecheck` and so on inside `client/`), as the
`client` job in CI runs them.

Every old name and its new one:

| Before lane g89 | Now |
|---|---|
| `start`, `package`, `make`, `publish` | `legacy:start`, `legacy:package`, `legacy:make`, `legacy:publish` |
| `typecheck`, `lint`, `lint:tracked`, `test`, `test:watch` | `legacy:typecheck`, `legacy:lint`, `legacy:lint:tracked`, `legacy:test`, `legacy:test:watch` |
| `test:browser:native-desk`, `test:e2e`, `test:helpers:node`, `test:backup:electron`, `test:swift` | the same with `legacy:` in front |
| `build:operational-tools`, `build:swift`, `build:apple-bridge`, `build:safe-log-fs` | the same with `legacy:` in front |
| `rebuild`, `rebuild:native:node`, `rebuild:native:electron` | the same with `legacy:` in front |
| `verify`, `verify:e2e`, `verify:package`, `verify:lambdas`, `verify:release` | the same with `legacy:` in front |
| `release:marker`, `backup:pre-release`, `diagnose:startup`, `export:cutover`, `knip`, `format:css` | the same with `legacy:` in front |
| the native steps of `postinstall` | `legacy:setup` |
| `verify:secrets` | unchanged |

## In CI

`.github/workflows/ci.yml` ("Source security gate") has five jobs:

- `secrets`, every push and pull request, on Linux: `npm run verify:secrets` over the
  full history and the tracked tree, with Gitleaks 8.30.1 from the `linux_x64` tarball,
  pinned by its SHA-256.
- `root-scripts`, every push and pull request, on Linux: `npm run lint:root-scripts`.
- `old-trees-changed`, every push and pull request, on Linux: compares the change with
  the greenfield-only paths (`apps/`, `packages/`, `infra/`, `certs/`, `test/release/`,
  `docs/greenfield/`, `docs/decisions/`, the `greenfield*.yml` workflows, the two
  Dockerfiles and their ignore files, `tsconfig.base.json`, `eslint.greenfield.mjs`, the
  three greenfield scripts, the mutation area files `scripts/mutations/*.mjs`, and the
  root `README.md`).
- `source` and `client`, the old gates, only when `old-trees-changed` finds a changed
  path outside that list. A path the list does not know about runs them, and so does a
  push with no readable base commit. A skipped job reports success to a required status
  check.

Of the 73 pull requests merged between 20 and 25 September, one would have run the old
gates: a `package-lock.json` change, which the old install reads.
`docs/decisions/g89-greenfield-is-the-default.md` has the reasoning.
