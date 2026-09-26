# g83: a verified update installs itself, at launch and on Restart

Lane g83, 25 September 2026. Audit item G11, and David's request that Callie update
itself when it is opened. This replaces `g13-update-application.md`, whose reason (no
Developer ID signature) stopped being true when 1.0.0 was signed and notarized
(`docs/greenfield/release.md` 8.0t).

## What changed

Before: the check ran every six hours and never at launch. A hit asked a question,
wrote the verified zip to Downloads, and told the person to replace the app by hand.

Now (`apps/desktop/src/main/updateInstall.ts`, bound to macOS by `updater.ts`):

- **At launch**, right after `start(...)` has opened the window, the channel is read. An
  update it offers is downloaded, verified, put in place and relaunched without a
  question. Home's sidebar reads *Updating Callie to 1.0.6…* while that happens, and the
  sign-in and upgrade screens show the same line.
- **While in use**, the six-hourly check downloads, verifies and stages an update, then
  shows *Callie 1.0.6 is ready* and a **Restart to update** link under the version row.
  Pressing it installs and relaunches. Otherwise the next launch installs it.
- **When the API has raised the minimum client version**, the app already refuses every
  mutation (5.3), so a restart loses nothing and the in-use check installs at once.

## What is verified, and in what order

The channel checks are unchanged: signed manifest, artifact on the channel origin,
version above the running one, size and sha256 of the bytes. Then, on the unpacked
bundle in `<userData>/updates/staging/<version>/Callie.app`:

1. The running executable is inside an `.app`, or nothing is installed
   (`update_running_bundle_unknown`).
2. The running bundle has a Team ID, or nothing is installed
   (`update_running_team_absent`). The local smoke build is signed ad hoc and has none.
3. The new bundle's `CFBundleShortVersionString` is the manifest's `releaseVersion`
   (`update_bundle_version_mismatch`), and above the running version
   (`update_bundle_not_newer`).
4. Its `CFBundleIdentifier` is the running bundle's (`update_bundle_identifier_mismatch`).
   The brief did not ask for this. It is one `plutil` read, and it stops another app
   from the same team taking Callie's place.
5. Its Team ID, from `codesign -dv`, is the running bundle's
   (`update_bundle_team_mismatch`).
6. `codesign --verify --deep --strict -R '=anchor apple generic and certificate
   leaf[subject.OU] = "<team>"'` passes (`update_bundle_signature_invalid`). `--verify`
   alone proves only that the seal is intact, and a self-signed certificate can claim any
   Team ID. The requirement adds that Apple issued the chain and that it names the
   running team. Checked by hand against the installed 1.0.4: exit 0 with its team
   `R45248279P`, exit 3 with another team, exit 3 for another vendor's app. The check
   takes about 18 seconds cold.

A refusal at any step installs nothing, deletes what was unpacked, and shows the existing
*Callie could not verify the update* dialog with the code. A channel that cannot be read
or believed stays silent, as before (install.md step 6). A version refused in this run
is not retried until the next launch.

A staged bundle is checked again before Restart or the next launch installs it, because
it has been on disk since it was staged. On the launch path it is installed straight
after staging, so it is checked once.

## The swap

Three renames, with the previous bundle kept beside the new one:

1. `staging/<new>/Callie.app` → `<parent>/.Callie-<new>.incoming`
2. `<parent>/Callie.app` → `<parent>/.Callie-<current>.previous`
3. `.Callie-<new>.incoming` → `<parent>/Callie.app`

Step 1 is the only move between directories. It fails if the staging directory is on
another volume or the person cannot write to `/Applications` (a standard account), and
then nothing has changed. Steps 2 and 3 are in one directory. A failure at 2 takes the
new bundle back; a failure at 3 puts the running one back. Any of these failures, and a
`ditto` that cannot unpack verified bytes, falls back to G13a's behaviour: the verified
zip in Downloads, revealed in Finder, with *Unzip it and replace Callie in Applications*.

The hidden names have no `.app` extension, so Launch Services does not register a second
Callie in Launchpad, Spotlight or the `callie:` scheme, and Finder does not show them.

**Why not one atomic swap.** macOS has `renamex_np(RENAME_SWAP)`, and Node does not
expose it. A helper to reach it (a Swift tool, or JavaScript for Automation through
`osascript`) would be a second signed executable or a scripting bridge on the one path
that must not fail, for a window of two same-directory renames. If the process dies
between steps 2 and 3, `/Applications/Callie.app` is missing and the previous bundle is
intact beside it. install.md's restore covers that case.

**The one unrecoverable case.** If step 3 fails and the rename back also fails, the
running app is at `.Callie-<current>.previous`. The dialog gives the exact `mv` command.
Both renames are in one directory and the first one just succeeded, so this is not
expected to happen.

## The first start after an update

The swap writes `installed.json` (`version`, `previousVersion`). Every start, once
`start(...)` has opened the window, writes `launched.json` with its own version. Only
after that write succeeds does it delete `.Callie-*.previous` and `.Callie-*.incoming`
beside the running bundle. Nothing else there is touched.

If the new version never gets that far, the previous bundle stays, and
`install.md`'s "If an update will not start" restores it by hand. When the restored
build starts, `installed.json` names a version that is not running. That version is
written to `held.json` and is not installed automatically again, so the next launch does
not undo the restore. A newer release is not held.

No record holds a path. Every path comes from a version (a strict semver) and the
layout, so an edited record can name a version that is refused but never a directory
that is deleted.

## What the channel decides

A staged update stays installable only while the channel does not say otherwise. If the
channel answers `up_to_date` or refuses the staged version as a downgrade, it no longer
offers that version (the release was withdrawn or this build caught up), and the staged
copy is deleted. If the channel cannot be read or verified at launch, a staged update
still stands on its own proofs and is installed after it is checked again.

## The page

One bridge, `callieUpdate` (`src/shared/updateContract.ts`). `state()` and `restart()`
take no argument, and one notification carries nothing. The page never sees a path, a
digest or a reason code. The state is `none`, `installing` or `ready` with a version.
It is parsed in the preload like every other state.

## What this cannot prove here

Everything above runs against fakes and a temporary directory, on Linux in CI. No real
signed install has run. The first build that installs itself is the first one built
from a commit that carries g83. The update *to* that build arrives the old way, because
the running build's updater is the one that receives it. The update *from* it is the
first automatic one, so the real proof is the published 1.0.5 → 1.0.6 path. What only a
real Mac can show:

- that macOS's App Management protection lets a Developer ID app rename its own bundle
  in `/Applications` (Apple documents that an app may update itself; if it may not, the
  first rename fails and the zip fallback runs);
- that `app.relaunch` starts the new bundle, and not a cached registration of the old one;
- how long the deep verify takes on a real 1.0.6 bundle.
