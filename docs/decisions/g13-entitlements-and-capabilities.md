# G13a: one entitlement, one capability, and the list of what is refused

**The requirement.** G13a deliverable 1: "hardened runtime and the entitlements the
app needs (no more)".

## The entitlements

```
com.apple.security.cs.allow-jit
```

That is the whole list, in `apps/desktop/scripts/entitlements.ts`, and the verifier
refuses a bundle whose signature carries anything else.

Callie is a Developer ID app, not a Mac App Store app, so it is not sandboxed and the
`com.apple.security.*` sandbox entitlements — network client, files, Keychain access
groups — would be decoration that grants nothing and implies something. What it is is
hardened, and the hardened runtime forbids writable-executable memory, which V8 needs.
That is the one exception.

Two things it conspicuously does not need. It spawns `/usr/bin/security`, and the
hardened runtime permits spawning a platform binary with no entitlement at all. And it
reads the login keychain, which for a non-sandboxed app is governed by the item's own
access control list (`docs/decisions/g13-keychain-acl.md`), not by an entitlement.

## The refused list

```
com.apple.security.cs.allow-dyld-environment-variables
com.apple.security.cs.allow-unsigned-executable-memory
com.apple.security.cs.debugger
com.apple.security.cs.disable-executable-page-protection
com.apple.security.cs.disable-library-validation
com.apple.security.get-task-allow
```

Each of these turns off a part of the hardened runtime. Several appear in Electron
signing guides and in `@electron/osx-sign`'s own default entitlements files, which is
how they arrive in projects that never decided to have them:
`allow-unsigned-executable-memory` and `allow-dyld-environment-variables` are in the
package's defaults. `get-task-allow` makes a build that cannot be notarized at all.
`disable-library-validation` is the one an ad-hoc build is tempted by — see
`docs/decisions/g13-local-smoke-mode.md` — and is refused for that reason.

The verifier treats a forbidden entitlement and an undeclared one as different
failures, because they are different mistakes: one is somebody turning off a
protection, the other is somebody adding a capability.

## Capabilities in the Info.plist

Electron's stock `Info.plist` promises a reason for the camera, the microphone,
Bluetooth, contacts, reminders, calendars, the photo library, speech recognition,
Apple Events, system administration and half a dozen folders. None is true of this
app. A usage description is not an entitlement, but it is what macOS shows a person
when it offers to grant something, and a plist listing eleven of them describes an app
that might do eleven things.

`package.ts` deletes every `*UsageDescription` key except one, before the signature
covers the file, and the verifier fails
`info_plist_claims_unused_capabilities` if the remaining set is not exactly:

```
NSDownloadsFolderUsageDescription
```

which is where a verified update is staged
(`docs/decisions/g13-update-application.md`), and is the only folder outside its own
container the app ever writes to.

## An entitlement present but false

Counted as absent. `codesign -d --entitlements` prints what the signature carries, and
a build that declared `allow-jit` as `false` would be a build V8 cannot run in; the
comparison says `missing`, which is the honest description.
