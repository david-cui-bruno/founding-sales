# Installing the thin client (slice S6)

The rebuilt core's Mac app is its own package under `client/`. It is not an upgrade of the old app: it has a
different bundle identifier (`com.callie.client`), its own userData directory, and no database, no migrations and
no backups. It can sit beside the old app without either knowing about the other.

## Building it

From the repository root, on a clean working tree at the commit you intend to install:

```
cd client
npm run verify:package
```

That does three things in order. `npm run package` writes the release marker for the current commit — a dirty or
untracked tree refuses it — and runs Electron Forge. Then `scripts/verifyClientPackage.mjs` checks the packaged
bundle: the marker embedded in `app.asar` matches the one on disk and the tree is still clean, the bundle
identifier is `com.callie.client`, the executable is a Darwin arm64 Mach-O, the nine Electron fuses are in the
states `build/electronFuses.ts` flips, `NSAllowsArbitraryLoads` is false, the final code signature verifies, the
Apple bridge helper is present with the right identity, architecture and signature, and there is no
`app.asar.unpacked` directory — this package ships no native module and must not gain one.

It prints a JSON report. Read `releaseMarker.commitSha`: that is the commit you are about to install.

## Notarization

**This build is signed and not notarized.** Neither the root Forge configuration nor the client's declares
`osxNotarize`, so there is no notarization step to copy and no stapled ticket to check. The verifier says so
itself, in the `notarization` field of its report, and it derives that from the two configurations rather than
assuming it — if notarization is added later, the verifier validates the stapled ticket instead.

What that means in practice: Gatekeeper asks once, on first launch. Open the app from Finder with Control-click →
Open, and confirm. After that it opens normally.

## Installing it

1. Open `client/out/` and find the `.app` bundle.
2. Drag it to `/Applications`. Do not run it from `out/`: the fuses require the app to load only from its ASAR,
   and running it in place makes the release marker and the signature harder to reason about later.
3. Open it once from Finder with Control-click → Open (see notarization above).

## First launch: the worker endpoint

The client holds exactly one secret, the device token, in a `safeStorage`-encrypted file. The worker's address is
not a secret and is not compiled in: a packaged build reads it from

```
~/Library/Application Support/Callie/client/worker-endpoint.json
```

which is a file you create, containing exactly:

```json
{ "endpoint": "https://<the worker's API Gateway host>" }
```

The value must be an https origin with no username, password, path, query or fragment. (Plain `http` is admitted
only for the loopback interface, which is where the Playwright stub listens; a packaged build ignores the
`CALLIE_WORKER_ENDPOINT` environment variable entirely.)

Without that file the Pair page says the endpoint is unconfigured rather than guessing one. With it, the app shows
the Pair page and waits for a device code.

## Pairing

Mint a device code with the operator tool (`--mint-device-code`, which writes it to a private file and never
prints it), then paste the code — or the absolute path of the code file — into the Pair page. The code is
one-time; the client deletes the code file after a successful pairing and tells you whether it managed to.

A device token is good for ninety days. To replace a Mac, mint a code with `--replace-device <deviceId>`: the old
device is revoked in the same transaction that pairs the new one.

## What is next

Pairing is step seven of ten in `docs/cutover/RUNSHEET.md`. The remaining steps are the fresh Google consent, the
revoke of the old grant, and recording anything the import flagged.
