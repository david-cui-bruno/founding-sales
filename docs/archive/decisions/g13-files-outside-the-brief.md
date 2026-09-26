# G13a: every file touched outside the brief's ownership list, and why

The brief gives this lane `apps/desktop/forge.config.ts` (or the packager
configuration it chooses), `apps/desktop/scripts/**`,
`.github/workflows/greenfield-desktop.yml`, `apps/desktop/test/host/**`,
`docs/greenfield/install.md` and `docs/archive/decisions/g13-*.md`. Deliverable 2 — "the app
checks the CloudFront URL, verifies the update's signature against a public key
embedded at build time, and refuses unsigned or downgraded builds" — is runtime
behaviour of the app, and cannot live in a build script. This is the complete list of
what was added or changed elsewhere, so the coordinator can see it in one place rather
than in a diff.

G3a's territory was not entered: nothing under `apps/api`, `packages/domain` or
`packages/contracts` is touched at all, not even a test hook.

## New files (nobody else's code, additive)

| File | Why it is not in `scripts/` |
|---|---|
| `apps/desktop/src/main/updateChannel.ts` | The rules the *app* applies to a manifest. Electron-free, so the gate tests it. |
| `apps/desktop/src/main/updater.ts` | The dialog, the download and the staging. The only file that imports `electron` for this. |
| `apps/desktop/src/main/main.ts` | The packaged entry point. G2's `app.ts` exports `start()` and nothing calls it; a packaged bundle needs something that does. |
| `apps/desktop/src/main/bundleScheme.ts` | `callie-app://`, because `file://` cannot read an asar with the fuse burned off. `docs/archive/decisions/g13-bundle-scheme.md`. |
| `apps/desktop/src/main/launchServices.ts` | The `tel:` local-setup check (14.2) reads the Launch Services database. Needed at runtime, not only at build time. |
| `apps/desktop/test/packaging/**` | Gate-run tests for the above. `test/host/**` is for what needs a real Mac, and most of this does not. |
| `apps/desktop/test/support/updateKeys.ts` | A key pair made when the test runs. Beside G2's fixture because a later lane will want it too. |

`main.ts` deliberately calls `start()` rather than reimplementing it, so the window,
the bridge and the session manager are G2's code unmodified.

## Changed files

**`apps/desktop/src/main/keychain.ts`** — one token: `-T ''` removed from
`add-generic-password`. A defect the host layer found; without it every Keychain read
raises a modal dialog and a headless runner hangs. Evidence and reasoning in
`docs/archive/decisions/g13-keychain-acl.md`. G2's unit test asserts the argument vector and
stays green, because what broke was not a property of the argument vector.

**`apps/desktop/src/main/app.ts`** — `DesktopConfiguration` gained an optional
`rendererUrl`, and `openWindow` loads it instead of the file when it is present. Four
lines. Without it a packaged build has no window. The development path is byte-for-byte
G2's behaviour: absent the field, `loadFile` runs exactly as before.

**`apps/desktop/tsconfig.json`** — `scripts/**/*.ts` added to `include`, so a build
script with no test still typechecks.

**`apps/desktop/package.json`** — five `@electron/*` packages and `electron` declared
as devDependencies, and `test:host`, `package` and `verify:package` scripts. The
packages were already in the tree as hoisted transitive dependencies of the old
client's Forge makers; using one from a dependency nobody declared is a build that
breaks when an unrelated package is removed. `npm install` resolved all five from the
existing lockfile, so `package-lock.json` gained six lines and no new version.

**`package.json` (root)** — `test:desktop:host`, `package:desktop`,
`verify:desktop:package`, beside G2's `test:desktop:e2e`. Nothing in
`gate:greenfield` changed.

## What is not changed, and could have been

`apps/desktop/vitest.config.ts` includes `test/**/*.test.ts`, which would run the host
tests in the ordinary gate. Rather than edit it, the host tests skip themselves unless
`process.platform === 'darwin'` and `FSS_HOST_TESTS=1`
(`apps/desktop/test/host/support/hostGate.ts`), so they appear in the gate as skipped —
honest, because they did not run — and `npm run test:desktop:host` runs them.

`apps/desktop/src/preload/preload.ts`, `ipc.ts`, `renderer.ts`, `index.html`,
`styles.css` and `shared/contract.ts` are untouched. The update prompt is a native
dialog from the main process precisely so that the bridge, the preload and the
renderer did not have to grow a channel for it.
