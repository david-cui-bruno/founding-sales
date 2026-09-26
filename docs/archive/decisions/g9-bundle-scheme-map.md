# One declaration per window, read by three things

Lane G9, 20 September 2026. Authorised by the coordinator after G7b found the bug.

## What was wrong

A packaged build serves its interface over the `callie-app://` scheme rather than
`file://`, because the `GrantFileProtocolExtraPrivileges` fuse is burned off and
Chromium's plain file loader cannot read an asar archive. The handler answers from
`BUNDLE_FILES`, a closed map — which is the right shape, and it was hand-written.

It named three paths:

```
/index.html   /renderer.js   /styles.css
```

By the time five windows existed the build shipped five pages and five scripts. So
`today.html`, `firmWorkspace.html`, `replyCard.html`, `sequenceEditor.html`,
`settings.html` and four of the five scripts were **404 in a packaged build**. Every
window except sign-in was broken.

Nothing caught it, and the reason is worth keeping: in development the windows are
opened with `loadFile`, which never reaches the scheme handler at all. The two paths
diverge exactly where the tests stop. A packaged build was the only place the bug
existed and the only place nobody looked.

There was a second copy of the same disagreement. `scripts/bundle.ts` had two
hand-written arrays — the esbuild entry points and the files to copy — and they had
already drifted once: `settingsPage` was in the page list and missing from the entry
list, so `settings.html` shipped and loaded nothing. That was fixed on its own
(commit `e580c1a9`) before this.

Three lists that must agree, none of them derived from the others, and no test that
compared them.

## What replaced it

One declaration per window, in `apps/desktop/src/main/bundleScheme.ts`:

```ts
export const BUNDLE_WINDOWS: readonly BundleWindow[] = Object.freeze([
  { page: 'index.html',         entry: 'renderer',       ownedBy: 'G2 identity' },
  { page: 'firmWorkspace.html', entry: 'firmWorkspace',  ownedBy: 'G3b CRM' },
  { page: 'today.html',         entry: 'todayPage',      ownedBy: 'G6 today' },
  { page: 'replyCard.html',     entry: 'replyPage',      ownedBy: 'G7b classifier' },
  { page: 'sequenceEditor.html', entry: 'sequenceEditor', ownedBy: 'G8 sequences' },
  { page: 'settings.html',      entry: 'settingsPage',   ownedBy: 'G9 administration' },
]);
```

Three things read it and none of them repeats it: the esbuild loop in
`scripts/bundle.ts`, the copy loop beside it, and `BUNDLE_FILES`, which is now
`flatMap`ped out of the list rather than typed out. Adding a window is one line.

`ownedBy` is there so a stale entry names somebody. It costs nothing and it is the
difference between "this window looks unused" and "ask G7b".

## Why the list lives in `src/main` and not in `scripts`

`bundleScheme.ts` ships inside the application; `scripts/bundle.ts` does not. A
shipped file may not import a build script, so the dependency has to point this way.
The alternative — a third file that both import — is one more file for the same one
fact, and the scheme handler is where the fact is load-bearing at runtime.

## The test, and which half of it has teeth

`apps/desktop/test/packaging/bundleScheme.test.ts` asserts two things for every
declared window:

1. its page and its script resolve through `answerBundleRequest`;
2. the page's one `<script src>` is exactly `./{entry}.js`.

The first is now structurally true — `BUNDLE_FILES` is derived, so a declared window
cannot be missing from it — and it is kept because the derivation is the thing that
could be rewritten later, and a test that only passes because of the current
implementation is worth having when the implementation changes.

The second is the one with teeth, and it was checked by breaking it both ways before
this was committed: renaming the entry, and renaming the page. Both fail the test.
It is also the assertion that catches the failure a derivation cannot: a window whose
declaration is internally consistent but does not match the HTML somebody wrote.

## What is still not tested

Nothing asserts that the file named in `BUNDLE_WINDOWS` exists on disk before the
build runs; esbuild and `copyFile` both fail loudly if it does not, so the build is
the check. And no test opens a packaged build and loads all six windows — that is
`verify:desktop:package` territory and a real packaging run, which this lane did not
add.
