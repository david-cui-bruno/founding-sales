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

**Where this sits in a release.** The desktop build is the *last* step, after the
rehearsal and after the production apply, because it needs a CloudFront hostname that
the apply creates. `docs/greenfield/release.md` section 2.0 is the order, and it is not
rearrangeable. As of 20 September 2026 eight of the nine signing secrets are not set and
`FSS_UPDATE_CHANNEL_URL` does not exist, so the release job fails closed at its first
step and names them; the host job, which needs nothing, runs on every pull request.

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
| `FSS_UPDATE_CHANNEL_URL` | `https://d111111abcdef8.cloudfront.net/` | `distribution_domain_name` from `infra/modules/updates`, with `https://` and a trailing slash |
| `FSS_DESKTOP_APP_VERSION` | `1.0.0` | The release's version. A release refuses to build at `0.0.0` |

All three are compiled into the bundle and therefore covered by its signature; none can
be changed afterwards. The release job refuses, naming each absent one, before it
installs anything.

`FSS_UPDATE_CHANNEL_URL` is the one that will be missing the first time, and not by
mistake: the CloudFront hostname exists only after the first production apply, and
GitHub will not store an empty variable. So the first release cannot be built until the
infrastructure it updates from exists — which is why `docs/greenfield/release.md`
section 2.0 puts the apply before the desktop build. Take the value from the apply:

```bash
cd infra/roots/production
terraform output -raw updates_distribution_domain_name   # d111111abcdef8.cloudfront.net
```

and set the variable to `https://` + that + `/`. `docs/decisions/g13b-an-absent-channel-url-is-a-refusal.md`
says why an absent one is a refusal rather than a default: a build that fell back to an
unapplied hostname would install once, check a name that does not resolve every six
hours, and never update — with no alarm and no symptom until the day the API raises the
minimum version and the upgrade prompt leads nowhere.

## Building a release

`Actions → Greenfield desktop → Run workflow`, on the release commit, with **release**
ticked and `desktop_commit_stamp` set to that same commit. Without **release**, the
workflow runs only the host job, which needs no credential at all and runs on every
pull request.

The stamp field is the release record's (`docs/greenfield/release.md` section 2.0): the
desktop commit stamp *is* the release commit, known before any build, and the workflow
refuses a value that is not the commit the run is on. Leave it empty only for a build
that precedes its rehearsal.

Four refusals come before anything is installed, and each names what is wrong:

1. any of the nine secrets absent — by name;
2. any of the three variables absent — by name, and `FSS_UPDATE_CHANNEL_URL` is the
   one that will be missing first;
3. `FSS_DESKTOP_APP_VERSION` still at the placeholder `0.0.0`, which is below every
   minimum the API could publish and would ship a client that can neither mutate nor
   upgrade past itself;
4. `desktop_commit_stamp` that is not this run's commit.

A fifth comes after the install and before the build: a working tree that is not clean.
`npm ci` is the step most able to have changed something, so the check is after it;
`packageDesktop` and the stamp schema refuse a dirty tree as well, and this one is
simply the version that fails in five seconds and names the files.

No step ever prints a value: the certificate reaches `security` through a file it
overwrites and deletes, the passwords reach `codesign` and `notarytool` through the
environment, and the only description of the configuration that is ever printed names
variables (`describeSigningPlan`, asserted by a test to contain no value).

Then: build, sign, notarize, staple, verify, sign the manifest, compare the stamp with
the commit, print the summary, upload. The verification is the gate, and it is the same
code a person could run against a downloaded bundle:

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
* the update public key is present in the packed JavaScript, not merely in the stamp;
* every window declared in `BUNDLE_WINDOWS` resolves inside the packaged asar, and
  nothing was packed that the scheme will not serve (below).

`--integrity` runs everything that does not need Apple. That is what the host job
uses, and it is the only mode a smoke build can pass.

### Every window is served, not just the first

A packaged build serves its interface over the `callie-app://` scheme rather than
`file://`, because the file-protocol fuse is burned off and Chromium's plain file
loader cannot read an asar. Until 20 September 2026 the map behind that scheme was
hand-written and named three paths, while the build shipped a page and a script per
window — so in a packaged build every window except sign-in answered 404. It was
invisible in development, where windows open with `loadFile` and never reach the
scheme handler.

The map is now derived from one declaration per window, `BUNDLE_WINDOWS` in
`apps/desktop/src/main/bundleScheme.ts`, which the esbuild loop and the copy loop in
`scripts/bundle.ts` read as well. A packaged build therefore serves Today, Replies,
the firm workspace, the sequence editor and administration, and adding a window is
one line rather than three lists to keep equal. `bundleScheme.test.ts` asserts that
every declared page and script resolves and that each page's script tag matches the
entry its window declares. See `docs/decisions/g9-bundle-scheme-map.md`.

That derivation makes "a declared window is in the map" true by construction, and it
cannot say anything about a *bundle*. So `verify:desktop:package` opens the asar and
asks the shipped handler for each window — the same 404 a person would get — and
refuses on either of two findings:

* `bundle_window_unreachable`: a declared window whose page or script is not in the
  archive, or whose page loads a script the map will not serve;
* `bundle_file_unserved`: a file the build put in `renderer/` that the closed map does
  not answer, which is the original bug seen from the artifact's side.

Both were proved by breaking them on real packaged bundles before the check landed, and
neither needs Apple, so `--integrity` checks them too. If you ever see either code, the
window named in the report is broken on every Mac that installs that build.
`docs/decisions/g13b-what-the-packaged-window-check-proves.md`.

### What the run leaves behind

Two things, and they are the whole release.

**The step summary**, which is the record. Four public facts — version, commit, the
artifact's sha256, its size — plus the channel path and the artifact's name. Nothing
else is ever printed; the signing configuration is described by variable name and a
test asserts that description contains no value.

**The artifact**, named `callie-macos-arm64-<version>`, at the top of the run page.
Inside it:

```
Callie-1.0.0-arm64.zip   the signed, notarized, stapled bundle, zipped with ditto
latest.json              the manifest, signed with the Ed25519 update key
```

GitHub wraps any download in a zip of its own, so a download is
`callie-macos-arm64-1.0.0.zip` and there is one unzip before the two files appear.

The upload uses `actions/upload-artifact` pinned to
`ea165f8d65b6e75b540449e92b4886f43607fa02` — v4.6.2, resolved with `git ls-remote` and
confirmed to be a commit rather than a tag object
(`docs/decisions/g13b-the-artifact-leaves-on-a-pinned-action.md`). It runs only after
the verifier passed, the manifest was signed and the stamp matched the commit, and it
has no `if: always()`: a build that failed any of those has nothing worth downloading.

Publishing is still yours (below). The alternative — an OIDC role that writes straight
to the bucket — is the better long-run answer and belongs to the lane that owns AWS
identity; it is not a thing to improvise on a runner that holds a Developer ID
certificate.

### Building one by hand instead

Only on a Mac that holds the certificate, and only when CI cannot run:

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

The CI release job is then the reference: a hand-built artifact of the same commit must
match it on version and commit. The zip's own digest will differ — a notarization ticket
is stapled per submission — which is why the manifest carries the digest of the artifact
actually published. Build from a committed tree: the packager refuses a dirty one, and
the stamp schema refuses `channel: release` with `dirty: true`.

## Publishing to the channel

No AWS credential exists in this repository, so this is an operator step against a
directive, from the two files you just downloaded.

The production root exports only the hostname, because that is the only one a build
needs. The other two you derive or look up once and write down:

```bash
cd infra/roots/production
terraform output -raw updates_distribution_domain_name     # d111111abcdef8.cloudfront.net

# The bucket is "<name_prefix>-updates-<account>", from infra/modules/updates:
BUCKET="fss-prod-updates-326255650484"

# The distribution, by the hostname the output printed:
DISTRIBUTION="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?DomainName=='d111111abcdef8.cloudfront.net'].Id" \
  --output text)"
```

Then, with `VERSION` the version the run summary printed:

```
aws s3 cp "Callie-$VERSION-arm64.zip" \
  "s3://$BUCKET/releases/darwin-arm64/$VERSION/Callie-$VERSION-arm64.zip"
aws s3 cp latest.json "s3://$BUCKET/releases/darwin-arm64/latest.json" \
  --cache-control 'max-age=300'
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" \
  --paths '/releases/darwin-arm64/latest.json'
```

Check it from outside AWS before telling anyone, because the bucket is private and
CloudFront is the only way in:

```bash
curl -fsS "https://$DOMAIN/releases/darwin-arm64/latest.json" | head -20
```

That is exactly the request every Mac makes.

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

**Before starting**, all of this must already be true, and each has its own page:

- the production Terraform is applied, so the CloudFront distribution exists
  (`docs/greenfield/infra-apply-runbook.md`);
- the nine secrets and three variables above are set, `FSS_UPDATE_CHANNEL_URL` from
  that apply;
- `FSS_DESKTOP_APP_VERSION` is `1.0.0`;
- you are on a Mac that has never held Callie. A fresh macOS user account is enough:
  the point is an empty login Keychain and an empty Launch Services entry, so that
  "no dialog appeared" means something.

Set aside about an hour. Notarization is a round trip to Apple and usually takes
minutes, occasionally longer, and you will do it twice.

### 1 — build and publish 1.0.0

Run *Greenfield desktop* with **release** ticked and `desktop_commit_stamp` set to the
commit. When it finishes, read the summary: version `1.0.0`, the commit, a sha256, a
size. Download `callie-macos-arm64-1.0.0`, unzip it once, and publish the two files by
the commands in "Publishing to the channel" — **zip first, manifest second**. Then:

```bash
curl -fsS "https://$DOMAIN/releases/darwin-arm64/latest.json" | head -20
```

**Expected:** a manifest whose `releaseVersion` is `1.0.0` and whose `commitSha` is the
commit the summary printed. If the run failed instead, it named what was absent; nothing
here guesses.

### 2 — install it, and watch for a prompt that should not come

Download the zip from the channel (`https://$DOMAIN/releases/darwin-arm64/1.0.0/Callie-1.0.0-arm64.zip`),
double-click to unzip, drag `Callie.app` to `/Applications`, open it.

**Expected: no warning of any kind.** That is what notarization buys: macOS checks the
stapled ticket without a network call, finds a Developer ID signature it trusts, and
opens the app.

If you get *"Apple could not verify Callie is free of malware"*, **stop**. The honest
response is to go back to step 1, not to right-click-open. You can find out which check
failed without guessing:

```bash
npm run verify:desktop:package -- /Applications/Callie.app
```

### 3 — sign in

**Expected: the system browser opens on `accounts.google.com`, and no Keychain dialog
appears at any point.** The device secret goes into the login keychain silently
(`docs/decisions/g13-keychain-acl.md` is why that took a fix). A Keychain prompt here is
a real finding — report it.

Leave the app signed in. The next step needs a running installation to update.

### 4 — publish 1.0.1

This step was written as a rehearsal of the update path, to be run on any commit. It is
now the real next release. Desktop 1.0.0 has no way to connect the mailbox
(`docs/greenfield/release.md` 8.0x). 1.0.1 is the build that adds the **Mailbox** row and
its **Connect Gmail** button to the "This Mac" card, so it has to be built from the commit
that carries lane g50, not from any commit.

**First, the API.** An API whose published maximum is 1.0.0 refuses a 1.0.1 client every
sign-in, renewal and command (`api_behind_client`, answered as `client_upgrade_required`).
Lane g50 raises `CONTAINER_CLIENT_VERSIONS` to `{ minimum: 1.0.0, maximum: 1.0.1 }`.
Deploy the API from that commit **before** anything below, and confirm it:

```bash
curl -fsS https://api.usecallie.com/auth/client-version
```

**Expected:** `"supported":{"minimum":"1.0.0","maximum":"1.0.1"}`. If the maximum is still
`1.0.0`, stop. Publishing now would offer every 1.0.0 Mac an update that the API refuses.

**Then the build.** The coordinator sets the repository variable
`FSS_DESKTOP_APP_VERSION` to `1.0.1`. Run *Greenfield desktop* with **release** ticked on
the same commit the API was deployed from, and pass that commit as
`desktop_commit_stamp`. Verify, download and publish it as in step 1, **zip first,
manifest second**. Expect a manifest whose `releaseVersion` is `1.0.1` and whose
`commitSha` is that commit.

### 5 — receive it

On the Mac, quit Callie and open it again.

**Expected: within a few seconds, "Callie 1.0.1 is available".** Accept it. The verified
zip is written to Downloads and Finder opens on it. Replace `Callie` in Applications,
open it, and confirm the version.

It does not swap the running bundle in place; `docs/decisions/g13-update-application.md`
says why not.

**Then connect the mailbox.** The "This Mac" card now has a **Mailbox** row reading **Not
connected** and a **Connect Gmail** button. Press it. Google's consent screen opens in
the system browser, as sign-in's does. Grant `gmail.readonly` and `gmail.send` as
`callie@usecallie.com`, then come back to Callie. The button reads "Waiting for your
browser…" until the grant lands, and then the row reads
`callie@usecallie.com · connected · baseline pending`. There is no Disconnect button (the
thirty-day rule in `docs/greenfield/mail.md`). If the browser says "Gmail not
connected", press **Refresh**, then Connect Gmail again. Release runbook 8.0x says how to
read the refusal.

### 6 — the adversarial half, which is the part worth doing

Take the published `latest.json`, change **one character** of `releaseVersion` — make it
`1.0.2` — and re-upload it with an invalidation. Do not re-sign it. Then quit Callie and
open it.

**Expected: no prompt at all, and no message.** The app checks the Ed25519 signature
over a canonical encoding of the document against the public key compiled into the
build, finds it no longer matches, and stops. It says nothing to the person, because
there is nothing they could usefully do about it.

**If it offers you 1.0.2, stop and report it.** The signature check is not doing
anything, which means the channel is a way onto that Mac and so is anything between the
Mac and the channel.

Then put the real `latest.json` back, invalidate again, and confirm with `curl` that the
channel serves the signed one.

### What this proved, and what it did not

Proved: a fresh Mac opens the app with no Gatekeeper prompt; a real update crosses the
real channel; a tampered manifest is refused on a real Mac by the real key.

Not proved: scenario 40's other half, the minimum-version block. That is a test
(`apps/desktop/test/packaging/scenario40.test.ts`) and it needs the API to raise the
minimum, which is not something to do to a live workspace to watch a dialog.

## Running the tests

```
npm run gate:greenfield        # includes the desktop rules, the update channel and scenario 40
npm run test:desktop:e2e       # the window, in chromium
npm run test:desktop:host      # macOS only: real Keychain, a real bundle, Launch Services
```

The gate also reads `.github/workflows/greenfield-desktop.yml`
(`test/packaging/releaseWorkflow.test.ts`): every action pinned to a commit sha, every
secret only ever the value of an env entry named after it, no shell tracing, the
dirty-tree refusal before the build, a summary of public facts only, and a host job
holding no credential. Editing the workflow without reading that test is how a pin
becomes a tag again.

An unsigned smoke package, locally, which passes everything that does not need Apple —
including the window check — takes about a minute:

```
FSS_DESKTOP_PACKAGE_MODE=local-smoke FSS_DESKTOP_APP_VERSION=1.5.0 \
  npm run package:desktop -- /tmp/callie-smoke
npm run verify:desktop:package -- /tmp/callie-smoke/Callie-darwin-arm64/Callie.app --integrity
```

The host layer needs the Electron binary, which the documented install deliberately
does not fetch. Once, in the checkout:

```
node node_modules/electron/install.js
```

Without it the host tests fail on the packaging step rather than on anything real;
with it they take about a minute, most of which is one real `codesign --verify --deep`
over 300 MB of framework.
