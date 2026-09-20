# G13a: the update manifest — Ed25519, a canonical encoding, and a same-origin artifact

**Spec silence.** Section 14.2 requires "signed update enforcement" and 4.1 gives the
channel as "S3 and CloudFront: signed and notarized Electron packages". Neither says
what is signed, with what, or what "refuses a downgraded build" means precisely.

## What is signed

One object per platform and architecture, at `releases/darwin-arm64/latest.json`:

```json
{ "manifest": { … }, "signature": "<base64 Ed25519>" }
```

The manifest names the format, a schema version, the channel, the release version,
the commit, when it was published, the minimum macOS version, and the artifact's URL,
size and sha256. `strictObject` all the way down: a field nobody declared is a
refusal, not a field to ignore. That is what stops a later `installSilently: true`
from being smuggled past a client that predates it.

## Ed25519, over a canonical encoding

Ed25519 because the key is 32 bytes, the signature is 64, both fit in a repository
secret and a build-time `define`, and `node:crypto` verifies one with no dependency.

The signature covers `canonicalJsonBytes(manifest)` — JSON with object keys sorted,
recursively — rather than the bytes as they arrived. Two reasons, in tension, and both
satisfied: a proxy or a CDN transformation that re-serialises the document must not
break an honest update, and reordering keys must not let a dishonest one through. The
reordering is undone before the check, so the same manifest written two ways verifies
and a manifest with one word changed does not. Both are tests.

## What a signature is still not allowed to do

**Send the Mac somewhere else.** The artifact URL must be on the same origin as the
channel this build was configured with, over HTTPS. If the signing key ever leaks, the
attacker can name a version and a digest, and still cannot point the download at a
host we do not control. (The loopback address is the one exception, so that a test
server can be a channel; it is reachable from nowhere else.)

**Move a Mac backwards.** Strictly newer or nothing. Equal is `up_to_date`; older is
`update_downgrade_refused`, however well signed. A signed old build is the classic way
to reinstate a fixed vulnerability, and the bucket keeps superseded versions for a
year, so those objects exist.

**Be installed by a build that cannot check it.** An empty embedded key refuses
everything with `update_key_absent`, checked before the manifest is even parsed. So
does a key that is not a key.

**Guess.** A running version the semantic-version parser does not recognise is
`update_running_version_unreadable`, not "old enough". An unreachable channel is
`update_offline`, not "nothing to install" — the difference matters exactly when the
API has raised the minimum version and a person is stuck.

## The bytes, before anything opens them

`verifyArtifactBytes` checks the length and the sha256 against the signed values. The
publisher computes the digest with the same function, so the two cannot disagree about
what "the digest of this artifact" means, and a test round-trips a published manifest
through the client's `decideUpdate`.

Gatekeeper checks the notarization ticket when the bundle is opened. That is a second,
independent check by a party that is not us, and it is the reason the update path can
end at "here is the verified zip" rather than at an in-place swap.

## Where the public key lives

Compiled in, as a `define` in `scripts/bundle.ts`, and recorded in the release stamp.
The verifier reads it out of the *packed JavaScript* rather than out of the stamp, so
"embedded at build time" is a property somebody can check on a downloaded bundle.
`publishUpdate.ts` refuses to sign a manifest with a private key whose public half is
not the one the bundle embedded — a mismatch is then a CI failure rather than a
release nobody can install.

No key pair is committed. The tests generate one at runtime
(`apps/desktop/test/support/updateKeys.ts`); a committed pair would be a pair somebody
else could sign a release with.

## Rotation, which is not solved here

There is one key and no way to roll it over. Replacing it means every installed Mac
refuses the next manifest and has to be updated by hand once. With one salesperson on
one Mac that is a five-minute inconvenience; it would not be at ten. The shape that
fixes it is a signed key set with an overlap period, and it is not worth building
before there is a second Mac. Recorded here so it is a decision rather than an
oversight.
