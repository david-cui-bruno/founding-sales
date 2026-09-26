# G13a: `@electron/packager` and a script, not Electron Forge

**Spec silence.** The brief names `apps/desktop/forge.config.ts` "or the packager
config you choose; note it". The specification says only that the artifact is signed,
notarized and delivered through the S3 and CloudFront channel.

**Decision: `@electron/packager` called from `apps/desktop/scripts/package.ts`.**
There is no `forge.config.ts` in `apps/desktop`.

**Why.** The order of the steps is the whole problem, and it is an order Forge cannot
express.

A fuse is a byte inside the Electron executable. Burning one after the bundle is
signed invalidates the signature, and on Apple silicon an invalid signature is not a
warning — the process will not start. So the sequence has to be: stage, pack, trim the
`Info.plist`, burn the fuses, sign, notarize, staple. Forge signs during packaging,
through `packagerConfig.osxSign`, before any hook that could touch the executable has
run. The old client worked around this with a `postPackage` hook that re-signed
ad-hoc (`build/electronFuses.ts`, `resetPackagedAdHocSignature`) — which is fine for
an ad-hoc build and cannot produce a notarizable one, because the signature Apple
sees would be the second one, applied without the entitlements and the timestamp.

Two smaller reasons. Forge's makers exist to produce installers for four platforms;
this ships one architecture of one platform, and the artifact is a `ditto` zip because
that is what preserves a signature through a round trip. And Forge's Vite plugin
assumes the repository root layout the old client has; the greenfield desktop app is
an npm workspace whose sources are bundled by esbuild, which `bundle.ts` does in
thirty lines with the four build-time values as `define` entries.

**What is given up.** `electron-forge start` for development. The window layer already
runs in chromium through Playwright (`docs/archive/decisions/g2-desktop-test-layers.md`), and a
developer who wants the real shell can run the smoke build, which launches — that is
one of the host tests.

**What would change this.** A second platform, or an installer rather than a zip.
Forge earns its complexity when there are four makers to keep consistent; with one it
is a layer between the script and the two libraries the script already calls.
