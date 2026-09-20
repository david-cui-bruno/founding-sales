# G13a: a verified update is staged and revealed, not swapped in place

**Spec silence.** Section 14.2 requires "signed update enforcement" and does not say
whether the app replaces itself.

**Decision.** `startUpdateWatch` checks the channel, verifies the manifest's
signature, verifies the downloaded bytes against the signed size and digest, writes
the zip to the Downloads folder and reveals it in Finder, with a dialog that says to
unzip it and replace Callie in Applications. It does not replace the running bundle.

**Why not.** Replacing a running `.app` on macOS means Squirrel.Mac — `autoUpdater`
in Electron — and Squirrel refuses to install an update into a bundle that is not
validly signed by a Developer ID. No such signature exists yet, on this machine or in
CI, which means an in-place updater written now would be the one code path in the
product that has never been executed, on the one operation that must not fail
halfway: the app cannot recover from a partial self-replacement, because the thing
that would do the recovering is what was being replaced.

So the choice is between a staged update that is fully verified and fully tested, and
an in-place update that is neither. Under COMMON-G's rule for spec silence — choose
the conservative option — it is the first.

**What is genuinely worse about it.** A person has to unzip and drag. Three steps
instead of one, once per release, for one salesperson. Deliverable 3's throwaway build
is the check that those three steps work.

**What would have to be true to change it.** A Developer ID certificate, a notarized
build, and a rehearsal where the swap is exercised from a real installed bundle to a
real newer one, including the case where the process is killed mid-swap. That is
`autoUpdater` with a local Squirrel feed pointing at the artifact this code already
verifies — the verification does not change, only what happens after it. It is the
right follow-up for G13b or later, and it is a day's work with a certificate in hand
and impossible without one.

**Why Downloads.** It is the one folder outside the app's own container that the
bundle asks macOS for (`NSDownloadsFolderUsageDescription`, the only usage description
`package.ts` leaves in the `Info.plist`), and it is where a person looks for something
they downloaded. Staging inside Application Support would need no permission and would
hide the file.

**One prompt per version.** A person who chooses *Later* is not asked again until the
channel offers something new. A six-hourly dialog is how an update prompt becomes
something people dismiss without reading, and the moment that matters most — a raised
minimum client version, when the app has stopped working — is exactly the moment the
habit would hurt.

**What a refusal looks like.** If the signature does not verify, or the bytes do not
match, the app says it could not verify the update and that it has not been installed,
with the reason code. It does not offer to proceed. When the app is also below the
minimum client version, this leaves a person with nothing to press — which is the
correct end of Appendix G scenario 40, and is asserted as such.
