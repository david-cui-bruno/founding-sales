# G2: what the desktop tests cover, and what they do not claim

**Spec silence.** Section 16.1 asks for "Electron end-to-end tests: authentication,
device rotation, stale cache, minimum-version block, Keychain integration, deep links,
clipboard, `tel:` handoff, signing, notarization, and update verification on a real
macOS runner." It does not say which of those belong to the slice that writes the app
and which belong to the slice that packages it.

**The constraint.** The documented local install is
`npm install --ignore-scripts --no-audit --no-fund` (see `docs/greenfield/workspace.md`),
which deliberately skips the old tree's `postinstall` — and with it the Electron
binary download. There is no Electron executable in `node_modules` on a machine set up
the documented way. A gate that needs one fails for a reason that has nothing to do
with the code.

**Decision: three layers, one of them in the gate.**

| Layer | Where | How it runs | What it proves |
|---|---|---|---|
| Rules | `apps/desktop/test/desktop.test.ts` (vitest) | `npm run gate:greenfield` | Keychain argv, renewal serialisation, real AES-256-GCM cache with its real expiry, the version gate, the wipe-on-revocation |
| Window | `apps/desktop/test/e2e/*.spec.ts` (Playwright, chromium) | `npm run test:desktop:e2e` | The shipped renderer, driven as a person drives it |
| Host | not written by this lane | — | Electron packaging, real Keychain, `tel:`, deep links, signing, notarization, updates |

The window layer is a separate command rather than part of the gate because it needs
a chromium binary, which `playwright install chromium` provides and the documented
`--ignore-scripts` install does not. Section 16.2 puts Electron scenarios in the
release-candidate run rather than in the per-change run, which is the same place.

The Playwright layer runs the **shipped** `renderer.ts`, `index.html` and `styles.css`,
transpiled by esbuild inside a generated test server. The only substitution is the
bridge: in Electron `window.callie` comes from the preload script, and in the test it
comes from a small generated script that posts to the same server. Everything the
specs assert — the sign-in form, the device panel, the stale banner with its actions
disabled, the upgrade screen with nothing to press, a firm name containing a tag shown
as text — is a property of the real file.

**What is honestly not proved here.** That `security add-generic-password` behaves as
`keychainCommand` expects against a real login keychain; that `shell.openExternal`
opens the right browser; that `contextBridge` exposes what `preload.ts` says; that the
built `.app` is signed, notarized and updatable. Those need a real Electron build on a
real macOS runner, they are the packaging slice's work, and this lane does not claim
them. What it does do is leave them as the only untested seam: every rule they would
exercise is already a unit test, so the host layer has to prove wiring rather than
behaviour.

**Running the window layer.** `npm run test:desktop:e2e` at the root. It needs
`npx playwright install chromium` once; on this Mac the browser was already cached, so
the specs run as they stand. They take about a second and a half.
