# The root defaults to the greenfield product; the old app runs only when it changes

**Lane:** g89 · **Audit item:** G10 (P1) of `GPT6-ASTRA-EXHAUSTIVE-20260925.md`, "The
unused legacy app remains the default development and CI workload."

## What was open

The root `package.json` belonged to the previous-generation Electron app. `npm start`
was Electron Forge; `npm test`, `npm run typecheck` and `npm run lint` ran the old
trees' gate; `postinstall` built the `safe-log-fs` addon with node-gyp and rebuilt the
encrypted SQLite driver three times, for Node, Electron and Node again. And
`.github/workflows/ci.yml` ran two macOS jobs for that app, `source` and `client`, on
every push and pull request. They waited 20 to 40 minutes for a macOS runner and gated
every greenfield pull request, although no greenfield change could alter what they
tested. `source` also carried the only secret scan that ran on every change.

## Decisions

**1. Every old script is `legacy:<its old name>`, and the bare names are greenfield.**
`typecheck` is `typecheck:greenfield`; `lint` is `lint:greenfield` and
`lint:root-scripts`; `test` is `test:greenfield` and `test:release`. There is no
`start`: nothing greenfield is a development runner, and pointing `npm start` at a
packaging step would be a surprise. One prefix for every old script, rather than for
only the names that collide, makes the rule checkable:
`test/release/rootScripts.check.ts` requires every unprefixed script to be on its list.
`verify:secrets` keeps its name because it guards the whole repository and
`greenfield-infra.yml`, which this lane may not edit, runs it by that name.

Renaming meant following the old names into the old tree, or its gate would break the
first time it ran: `scripts/verifyRelease.mjs` runs its stages by name, and
`test/verifyRelease.test.mjs`, `test/releaseDocumentation.test.mjs` and
`.github/workflows/release.yml` pin them. Each is the same rename, and no assertion was
weakened. The old manuals (`docs/engineering/release.md`, `docs/ARCHITECTURE.md`,
`cloud/README.md`, `docs/cutover/RUNSHEET.md`) have their commands renamed and a
dated note about the rest. `docs/archive/` and `.superpowers/` are history and keep the
old names.

**2. `postinstall` fetches Electron and nothing else.** The two native steps it ran after
`install-electron` are `npm run legacy:setup`, which `source` and `release.yml` now run
after `npm ci`. `install-electron` stays even though packaging does not need it: with
`node_modules/electron/dist` moved aside,
`FSS_DESKTOP_PACKAGE_MODE=local-smoke npm run package:desktop` still produced a bundle,
because `@electron/packager` takes Electron from its own download cache (and downloads
it when the cache is empty). `docs/greenfield/install.md` says the desktop host tests
need the installed binary, `greenfield-desktop.yml` fetches it for them, and a plain
`npm ci` should leave every greenfield command runnable. The SQLite driver stays a
root dependency, because `src/` still uses it, so its own install script still fetches
a prebuilt Node binary during `npm ci`. npm 11.19's `allowScripts` could deny it, but
`legacy:setup` rebuilds it through `npm rebuild`, which honours the same policy, so
the denial would need its own change to the old tree.

**3. The old gates are skipped by a job-level guard, not a `paths:` filter.** A
workflow-level `paths:` filter would stop the secret scan too, since it lives in the
same workflow, and a workflow that never starts leaves a required check waiting
forever. A job skipped by `if:` reports success to a required check. The guard,
`old-trees-changed`, runs on Linux with only `actions/checkout` (already pinned) and
`git diff`.

**4. The guard lists the greenfield-only paths, not the legacy ones.** A change
confined to `apps/`, `packages/`, `infra/`, `certs/`, `test/release/`,
`docs/greenfield/`, `docs/decisions/`, the `greenfield*.yml` workflows, the two
Dockerfiles and their ignore files, `tsconfig.base.json`, `eslint.greenfield.mjs`, the
three greenfield scripts or the root `README.md` skips `source` and `client`; any other
path runs both. So a new top-level path, the lock file, `.gitleaks.toml` or this
workflow runs the old gates until somebody decides otherwise, rather than skipping them
until somebody notices. Each greenfield-only entry was checked against what the old
gates read: `tsconfig.json`, `vitest.config.mts`, `eslint.config.mjs` and
`scripts/lintTracked.mjs` already exclude `apps/`, `packages/` and `test/release/`, and
no old test reads `docs/greenfield/`, `docs/decisions/`, `certs/` or the root README.
For a pull request the base is the merge commit's first parent, which is exactly the
change being merged; for a push it is `before`. With no readable base the old gates
run. Of the 73 pull requests merged between 20 and 25 September, one would have run
them, for a `package-lock.json` change.

**5. The greenfield files at the root keep their old lint.** `scripts/productionSmoke.mjs`,
`scripts/releaseMutationCheck.mjs`, `scripts/releaseMutationRunner.mjs` and
`eslint.greenfield.mjs` were linted on every pull request only because the old
`lint:tracked` reads every tracked script outside `apps/`, `packages/` and
`test/release/`. `releaseMutationCheck.mjs` changed in 50 of those 73 pull requests, so
treating it as an old path would have kept the macOS wait on most of them. Instead
`lint:root-scripts` runs the same config on the same four files, in its own Linux job
on every change and in `npm run lint`.

**6. The secret scan is its own job, on every change, on Linux.** It is the unchanged
`npm run verify:secrets` after `npm ci --ignore-scripts`, with the same Gitleaks 8.30.1
installed from the `linux_x64` tarball. That tarball is pinned by SHA-256
`551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`, and verified with
`sha256sum -c` before the version check. The coordinator took the value from the
v8.30.1 release's checksums file. The `darwin_arm64` line in that file matches the pin
`source` and `release.yml` already carry, so both pins come from one source. This
lane made no network call to check it again; a tarball that does not match fails the
job. The job was first written on macOS for want of that value, and moved once the
coordinator supplied it. `greenfield-infra.yml`'s own `secrets` job still installs the
`darwin_arm64` tarball on `macos-15`. That file belongs to another lane, and it runs
only on `infra/**` changes. `source` keeps both of its scans; the second covers the
generated operational tools.

**7. Nothing was deleted.** `DELETION-MAP-20260918.md`, in the coordinator's `.context/` notes, is the authority. Its
"Safe to delete now" rows (D1a–D1f), and the LinkedIn, meetings and Apple spike and
supervisor rows David moved to "now", were deleted by lanes 44–46 on 18 September.
The four D1a files lane 44 found still reached were kept on purpose (commit
`a0bb21da`). The other rows are "Delete after replacing one dependency" or "Core,
keep", and the map says nothing about deleting whole trees. `docs/greenfield/legacy.md`
lists what remains and why.
