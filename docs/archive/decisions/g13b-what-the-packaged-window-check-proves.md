# G13b: what the packaged-window check proves that the derivation cannot

**The gap.** `docs/archive/decisions/g9-bundle-scheme-map.md` ends with it: "no test opens a
packaged build and loads all six windows — that is `verify:desktop:package` territory
and a real packaging run, which this lane did not add." The coordinator's note of
20 September gave that to G13b.

G9 derived `BUNDLE_FILES` from `BUNDLE_WINDOWS`, so "a declared window is in the
scheme's map" is now structurally true and a test of it passes for reasons that have
nothing to do with the artifact. Two statements remain, both about the bundle rather
than about the source, and neither follows from the derivation:

1. the file a window names is **inside the asar**;
2. nothing is inside the asar that the closed map **will not serve**.

The second is the shape of the original bug: five pages shipped, three paths answered,
every window but sign-in a 404 on a Mac and nowhere else.

**Decision: both, in `verifyPackage`, in both modes.** `checkBundleServing` walks
`BUNDLE_WINDOWS` against the packed archive through `answerBundleRequest` — the handler
the shipped application installs — so the answer is the same 404 a person would get
rather than a second opinion about it. For each window it requires the page at 200, the
declared script at 200, at least one `<script src>` on the page, every such src at 200,
and the declared entry among them. Then it lists the archive's `renderer/` directory and
requires every file there to be a name the map answers.

The two failure codes are `bundle_window_unreachable` and `bundle_file_unserved`.
Neither needs Apple, so both run under `--integrity` as well as in release mode: a build
whose windows 404 is broken whoever signed it, and the smoke build the host job packages
on every change is a real bundle to ask.

## Proved red, twice, on real packaged bundles

Not on a fixture. The scratch run removed the `today` window from `BUNDLE_WINDOWS` and
exercised both directions with one edit:

* against a package built **with** the window, the trimmed map gives
  `PACKAGE: refused — bundle_file_unserved`, naming `today.html` and `todayPage.js` —
  exactly the G9 bug, seen from the artifact's side;
* against a package built **without** it, the restored map gives
  `PACKAGE: refused — bundle_window_unreachable`, with `today.html` at
  `pageStatus: 404, scriptStatus: 404`.

`apps/desktop/test/packaging/bundleServing.test.ts` keeps five of those failures in the
ordinary gate against a fabricated archive, including two the scratch run did not cover:
a page whose script tag names a file the map will not serve, and a page that loads no
script at all. `apps/desktop/test/host/package.host.test.ts` runs the same function
against a bundle `@electron/packager` actually produced, and asserts separately that the
packed `renderer/` directory is exactly the pages, scripts and shared files the windows
declare — which is the one thing the serving check cannot see, because a missing
`styles.css` is neither a declared window nor an undeclared file.

## What it still does not prove

That a window **renders**. The check proves the bytes are reachable at the URL the
window is opened with; it does not start Chromium and it does not execute the script.
The host layer's launch test covers the first window that way — the app starts, stays
up for twelve seconds, and prints no `ERR_FILE_NOT_FOUND` or `Failed to load URL` — and
extending that to all six would mean driving the application's own menu from a test,
which is an end-to-end surface and belongs with `test/e2e`.

It also does not prove the CSP admits the script. `script-src 'self'` resolves to the
bundle origin, so a cross-origin `<script src>` is refused by Chromium and reported here
as a 404 by the same map; the two agree by construction rather than by test.
