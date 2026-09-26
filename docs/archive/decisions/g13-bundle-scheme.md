# G13a: the packaged window loads from `callie-app://`, not from `file://`

**Spec silence.** Section 14.2 gives Electron "presentation" and "secure deep links"
and says nothing about how the bundled interface reaches the window.

**The observation.** A packaged build whose window is opened with
`loadFile(<inside the asar>/index.html)` fails with `ERR_FILE_NOT_FOUND`, on a bundle
whose asar demonstrably contains that file at that path.

The cause is a fuse. `GrantFileProtocolExtraPrivileges` is burned off
(`apps/desktop/scripts/fuses.ts`), which is what stops a `file://` page from being
treated as a privileged, non-opaque origin able to reach the rest of the disk as
same-origin. In Electron 44 the same fuse decides which loader serves `file://`: with
it enabled, Electron's own asar-aware loader; with it disabled, Chromium's plain file
loader, which knows nothing about asar archives. Turning the fuse back on makes the
window load — measured, on this Mac, with everything else unchanged — and gives up a
real privilege to do it.

**Decision: a privileged custom scheme.** `apps/desktop/src/main/bundleScheme.ts`
registers `callie-app` as standard and secure, with no fetch support, no CORS, no
service workers and no CSP bypass, and answers three exact paths — `/index.html`,
`/renderer.js`, `/styles.css` — from a closed `Map`. The window is opened at
`callie-app://bundle/index.html`.

The fuse stays off. This is also what the old client concluded: its comment in
`build/electronFuses.ts` says "Callie serves bundled UI through `callie://` and never
needs `file://`'s legacy universal-access privileges."

**Why a closed map rather than a path join.** A custom protocol handler that resolves
`new URL(request.url).pathname` against a directory is a file server, and a file
server inside the app is one encoding trick away from serving `release-stamp.json`,
`main/main.js`, or anything else reachable from the renderer directory. Three names
cannot be traversed. `apps/desktop/test/packaging/bundleScheme.test.ts` asserts that
six shapes of traversal and two other origins are refused *and* that no filesystem
call is made for any of them.

**Why the renderer needed no change.** `index.html` declares
`default-src 'none'; script-src 'self'; style-src 'self'` and references `./renderer.js`
and `./styles.css`. Under a standard, secure scheme those resolve to
`callie-app://bundle/...` and `'self'` is that origin, so the shipped file — the same
one the Playwright layer drives — is unmodified.

**The one change to a file this lane does not own.** `openWindow` in
`apps/desktop/src/main/app.ts` gained an optional `rendererUrl`, and loads it instead
of the file when it is present. Four lines. The development path is untouched: without
`rendererUrl`, `loadFile` behaves exactly as G2 wrote it, and only a packaged build
sets it. Recorded in `docs/archive/decisions/g13-files-outside-the-brief.md`.
