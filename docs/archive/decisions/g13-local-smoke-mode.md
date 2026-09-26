# G13a: the local smoke mode, and the two things that make it not a release

**The constraint.** No Developer ID certificate, no notarization credential and no
Apple account exists on this machine or in CI. The brief allows an ad-hoc signature
only "in a clearly separated local smoke mode that the verifier refuses to accept as
a release".

**Decision.** `FSS_DESKTOP_PACKAGE_MODE=local-smoke` is a mode that must be asked for
by name. It never appears as a fallback: a release build with a missing credential
refuses and names the variable, rather than quietly producing something ad-hoc.
`resolveSigningPlan` has a test for each of those.

The smoke build differs from a release in exactly two ways, and the second one is a
decision rather than an absence.

**One: no Developer ID, no ticket.** It is signed `codesign --sign -`. There is no
authority, no team identifier, no secure timestamp and no notarization, and the
release verifier reports every one of those by name.

**Two: no hardened runtime.** Deliberately. The hardened runtime validates loaded
libraries by team identifier; an ad-hoc signature has no team identifier and each
ad-hoc signature is its own identity. A hardened ad-hoc bundle therefore cannot load
its own Electron framework, and dies in dyld before a line of its code runs —
measured on this Mac:

```
dyld: Library not loaded: @rpath/Electron Framework.framework/Electron Framework
  Reason: ... mapping process and mapped file (non-platform) have different Team IDs
```

The ways round that are a real Developer ID, which is the release path, or
`com.apple.security.cs.disable-library-validation`, which is on
`FORBIDDEN_ENTITLEMENTS` and would make the smoke build's entitlements a lie about
what a release asks for. So the smoke build gives up the hardened runtime and gains
what a bundle that cannot launch could never prove: the burned fuses did not brick the
binary, the packed ESM entry point resolves inside the asar, the sandboxed preload is
found, and `callie-app://` serves the page. That is a host test, and it is the reason
this mode exists at all.

The entitlements are still the release's entitlements, and the fuses are still the
release's fuses, so those two comparisons are real.

**What the verifier does with it.** In `release` mode, a smoke bundle fails on nine
counts: `stamp_channel_not_release`, `signature_adhoc`,
`authority_not_developer_id`, `hardened_runtime_absent`, `secure_timestamp_absent`,
`team_identifier_absent`, `notarization_ticket_absent`, `gatekeeper_rejected`,
`update_public_key_absent`. The first of those is independent of everything Apple
does: the stamp inside the asar says `local-smoke`, and the stamp is inside the
signature, so a smoke build cannot be relabelled without breaking
`codesign --verify`.

In `integrity` mode — signature valid, fuses burned, entitlements exactly the declared
set, stamp this commit, arm64, the plist asking for one capability — it passes, and
that is what the macOS host job runs on every change.

**A smoke build has no update key.** `FSS_UPDATE_PUBLIC_KEY` is not required for it,
and without one `decideUpdate` refuses every manifest with `update_key_absent`. A
development bundle that installed whatever the channel offered would be the easiest
way onto a developer's Mac.
