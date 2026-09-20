# Installing Callie on a Mac, and updating it

Specification 4.1, 5.3, 14.2 and 16.2, and Appendix G scenario 40. This is how a
build is made, how it is proved to be a release, how it reaches a Mac, and how that
Mac replaces it later.

## The short version

One architecture (macOS arm64, 13.0 or later), one bundle, one channel. A release is
signed with a Developer ID Application certificate, hardened, notarized by Apple and
stapled, and it carries a stamp naming the commit it came from. The update channel is
a private S3 bucket behind CloudFront (`infra/modules/updates`), and the Mac installs
nothing from it that is not signed by the key that build was made with.

```
apps/desktop/scripts/bundle.ts         the app directory: esbuild, four build-time values
apps/desktop/scripts/package.ts        pack, trim the plist, burn the fuses, sign, notarize, staple
apps/desktop/scripts/verifyPackage.ts  may this be released? — and why not
apps/desktop/scripts/publishUpdate.ts  the zip and the signed manifest the channel serves
apps/desktop/src/main/updateChannel.ts what the Mac will and will not install
.github/workflows/greenfield-desktop.yml
```

## What David must set

Nine repository secrets and three repository variables. Everything in the first list
is a secret; everything in the second is public and may be a plain variable.

### Secrets — Settings → Secrets and variables → Actions → Secrets

| Name | What it is | Where it comes from |
|---|---|---|
| `FSS_MAC_SIGNING_IDENTITY` | The certificate's full name, e.g. `Developer ID Application: Callie Inc (A1B2C3D4E5)` | `security find-identity -v -p codesigning` after importing the certificate |
| `FSS_MAC_TEAM_ID` | The ten-character Apple team identifier | Apple Developer account → Membership |
| `FSS_MAC_CERTIFICATE_P12` | The Developer ID Application certificate and its private key, as base64 | `security export -t identities -f pkcs12 -o cert.p12` then `base64 -i cert.p12` |
| `FSS_MAC_CERTIFICATE_PASSWORD` | The passphrase on that `.p12` | Chosen when exporting |
| `FSS_MAC_KEYCHAIN_PASSWORD` | Any long random string; it protects a keychain that exists for one job | `openssl rand -base64 24` |
| `FSS_APPLE_ID` | The Apple ID that submits to notarization | The Apple Developer account's e-mail |
| `FSS_APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password, not the account password | appleid.apple.com → Sign-In and Security → App-Specific Passwords |
| `FSS_UPDATE_SIGNING_KEY` | The Ed25519 private key that signs update manifests, as base64 PKCS#8 | `openssl genpkey -algorithm ed25519 -outform DER \| base64` |
| `FSS_UPDATE_PUBLIC_KEY` | The public half of that key, base64 SPKI DER — embedded in every build | See below |

`FSS_UPDATE_PUBLIC_KEY` is not secret, but it lives beside its private half so the
two cannot drift; the publisher refuses to sign a manifest with a key that does not
match the one the bundle embedded, so a mismatch is caught in CI rather than on a
Mac.

Both halves are **base64 DER**, and the publisher accepts nothing else: a key pasted
in PEM form is refused by name, with the conversion, before anything is built
(`docs/decisions/g13-update-key-encoding.md`). To produce the pair, on a Mac, once:

```
openssl genpkey -algorithm ed25519 -out callie-update.pem
openssl pkey -in callie-update.pem -outform DER | base64 | tr -d '\n'        # FSS_UPDATE_SIGNING_KEY
openssl pkey -in callie-update.pem -pubout -outform DER | base64 | tr -d '\n' # FSS_UPDATE_PUBLIC_KEY
```

Then put `callie-update.pem` somewhere it will survive — a password manager, not this
repository — and delete it from the disk. Losing it does not brick installed builds;
it means the next release needs a new pair, and every Mac has to be updated by hand
once because it will refuse a manifest signed by the new key.

### Variables — same page, Variables tab

| Name | Example | Why |
|---|---|---|
| `FSS_API_BASE_URL` | `https://api.usecallie.com` | Compiled into the build; the Mac talks to nothing else |
| `FSS_UPDATE_CHANNEL_URL` | `https://d111111abcdef8.cloudfront.net/` | `distribution_domain_name` from `infra/modules/updates` |
| `FSS_DESKTOP_APP_VERSION` | `1.0.0` | The release's version. A release refuses to build at `0.0.0` |

## Building a release

`Actions → Greenfield desktop → Run workflow`, with **release** ticked. Without it,
the workflow runs only the host job, which needs no credential at all.

The release job stops at the first step if any of the nine secrets is absent, and
says which ones by name. It never prints a value: the certificate reaches `security`
through a file it overwrites and deletes, the passwords reach `codesign` and
`notarytool` through the environment, and the only description of the configuration
that is ever printed names variables (`describeSigningPlan`, asserted by a test to
contain no value).

Then: build, sign, notarize, staple, verify, sign the manifest. The verification is
the gate, and it is the same code a person could run against a downloaded bundle:

```
npm run verify:desktop:package -- /Applications/Callie.app
```

It checks, and refuses unless all of it holds:

* exactly one `.app` with an `app.asar`;
* a release stamp inside the asar — and therefore inside the signature — whose commit
  is the commit being released, from a clean tree, at a real version, naming the
  embedded update key;
* `CFBundleIdentifier` is `com.callie.fss.desktop`, the version matches the stamp,
  `NSAllowsArbitraryLoads` is false, the `callie` URL scheme is declared, and the only
  capability the `Info.plist` asks for is the Downloads folder;
* an arm64 Mach-O executable;
* the eight fuses in `scripts/fuses.ts`, read back out of the binary;
* `codesign --verify --deep --strict` passes;
* the authority is a Developer ID Application certificate, not ad-hoc, with the
  hardened runtime and a secure timestamp, and a team identifier;
* the entitlements are exactly `com.apple.security.cs.allow-jit` and nothing else;
* a notarization ticket is stapled and Gatekeeper says `source=Notarized Developer ID`;
* the update public key is present in the packed JavaScript, not merely in the stamp.

`--integrity` runs everything that does not need Apple. That is what the host job
uses, and it is the only mode a smoke build can pass.

### Getting the artifact off the runner

**Open, for the coordinator and David.** The release job builds, verifies and signs,
and then the runner is destroyed. Carrying the artifact away needs either
`actions/upload-artifact` (a third action, which must be pinned to a digest somebody
has checked) or an OIDC role that can write to the bucket (which is the better answer
and belongs with the lane that owns AWS identity). Until one of those is decided, a
release is built on a Mac that holds the certificate:

```
export FSS_DESKTOP_APP_VERSION=1.0.0
export FSS_API_BASE_URL=... FSS_UPDATE_CHANNEL_URL=...
export FSS_MAC_SIGNING_IDENTITY=... FSS_MAC_TEAM_ID=...
export FSS_APPLE_ID=... FSS_APPLE_APP_SPECIFIC_PASSWORD=... FSS_UPDATE_PUBLIC_KEY=...
npm run package:desktop -- ./out
npm run verify:desktop:package -- ./out/Callie-darwin-arm64/Callie.app
FSS_UPDATE_SIGNING_KEY=... node --experimental-strip-types \
  apps/desktop/scripts/publishUpdate.ts ./out/Callie-darwin-arm64/Callie.app ./channel
```

The CI release job is then the reference: its step summary prints the version, the
commit, the artifact's sha256 and its size, and a hand-built artifact of the same
commit must match on version and commit. The zip's own digest will differ — a
notarization ticket is stapled per submission — which is why the manifest carries the
digest of the artifact actually published.

## Publishing to the channel

No AWS credential exists in this repository, so this is an operator step against a
directive, with `bucket_name` and `distribution_id` from `infra/modules/updates`:

```
aws s3 cp "Callie-$VERSION-arm64.zip" \
  "s3://$BUCKET/releases/darwin-arm64/$VERSION/Callie-$VERSION-arm64.zip"
aws s3 cp latest.json "s3://$BUCKET/releases/darwin-arm64/latest.json" \
  --cache-control 'max-age=300'
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" \
  --paths '/releases/darwin-arm64/latest.json'
```

The zip first. A manifest naming an object that is not there yet is a manifest every
Mac refuses — safe, but it looks like an outage. The bucket keeps superseded versions
for a year (`noncurrent_version_expiration_days`), so an earlier compatible build is
still reachable if one is needed; the Mac will not install it, because a downgrade is
refused, but a person can.

## Installing on a Mac

1. Download the zip and unzip it — double-clicking is enough; macOS uses `ditto`.
2. Drag `Callie.app` to `/Applications`.
3. Open it.

There is no Gatekeeper warning. That is the whole point of notarization: macOS checks
the stapled ticket offline, finds a Developer ID signature it trusts, and opens the
app. A build that has not been notarized produces "Apple could not verify Callie is
free of malware", and the honest response to that message is to stop, not to
right-click-open.

The first launch asks for nothing. Signing in opens Google in the system browser
(specification 5.1), and the device secret goes into the login keychain without a
dialog — see `docs/decisions/g13-keychain-acl.md` for why that took a fix.

## How a Mac updates itself

On launch and every six hours, the app reads one object:
`https://<channel>/releases/darwin-arm64/latest.json`. It installs what it finds only
if all of this holds:

* a public key was compiled into this build (an empty one refuses everything);
* the manifest parses exactly — an unknown field is a refusal, not a warning;
* the Ed25519 signature verifies against that key, over a canonical encoding, so a
  proxy may re-serialise the document but may not change a word of it;
* the artifact is on the same origin as the configured channel, over HTTPS;
* the offered version is strictly newer than the running one; equal means up to date
  and older is refused outright;
* the downloaded bytes match the signed size and sha256 before anything writes them.

Then a dialog offers the update once per version. Accepting it stages the verified zip
in Downloads and reveals it in Finder; unzip it and replace `Callie` in Applications.
It does not swap the running bundle in place — `docs/decisions/g13-update-application.md`
says why not, and what would have to be true first.

When the API has raised the minimum client version (specification 5.3), the app shows
the upgrade screen and refuses every mutation, and the update prompt is the only thing
left to do. If the channel cannot be verified at that moment, it stays refused: being
stuck is not a reason to install something unsigned. That is Appendix G scenario 40,
and it is a test — `apps/desktop/test/packaging/scenario40.test.ts`.

## The throwaway build David runs once

G13a deliverable 3. It proves two things no test can: that a fresh Mac opens the app
without a Gatekeeper prompt, and that a real update arrives from the real channel.

**Before starting**, the nine secrets and three variables above must be set, and
`infra/modules/updates` must be applied so the CloudFront hostname exists.

1. Build and publish **1.0.0** by the steps above. Verify it — do not skip
   `verify:desktop:package`; it is the only thing that will tell you the ticket is
   stapled before a Mac tells you it is not.
2. On a Mac that has never held Callie (a fresh account is enough; the point is an
   empty Keychain and an empty Launch Services entry), download, unzip, drag to
   Applications, open. **Expected: no warning of any kind.** A warning means the
   notarization did not staple, and the answer is step 1 again, not "Open Anyway".
3. Sign in. **Expected: the system browser opens on `accounts.google.com`, and no
   Keychain dialog appears at any point.**
4. Now publish **1.0.1** — any trivial change, or the same tree with the version
   bumped. Same build, same verification, same upload.
5. Back on the test Mac, quit Callie and open it again. **Expected: within a few
   seconds, "Callie 1.0.1 is available". Accept it.** The zip appears in Downloads and
   Finder opens on it.
6. Replace the app, open it again, and check the version.
7. The adversarial half, which is the part worth doing. Edit `latest.json` in the
   bucket — change one character of `releaseVersion` — and re-upload with an
   invalidation. Open Callie. **Expected: no prompt at all.** The app refuses a
   manifest whose signature no longer matches and says nothing to the person, because
   there is nothing they could usefully do. Then put the real `latest.json` back.

If step 7 offers an update, stop and report it: the signature check is not doing
anything, and every later release is a way onto that Mac.

## Running the tests

```
npm run gate:greenfield        # includes the desktop rules, the update channel and scenario 40
npm run test:desktop:e2e       # the window, in chromium
npm run test:desktop:host      # macOS only: real Keychain, a real bundle, Launch Services
```

The host layer needs the Electron binary, which the documented install deliberately
does not fetch. Once, in the checkout:

```
node node_modules/electron/install.js
```

Without it the host tests fail on the packaging step rather than on anything real;
with it they take about a minute, most of which is one real `codesign --verify --deep`
over 300 MB of framework.
