# G7b: the reply cards are a fourth window, and what it may ask for

**Date:** 20 September 2026 · **Lane:** G7b reply classifier · **Spec:** 8.3, 12.4, 14.2

## The silence

8.3 describes a reply card in detail and says nothing about where it lives. G2 opened
one window, G3b added the CRM windows, G6 added Today. A reply card could have been a
panel inside Today — the reply lane is lane 1 of that list — or its own window.

14.2 says Electron "owns presentation" and "contains no authoritative sequence,
suppression, policy, eligibility, or send logic", which constrains what the window may
do and not where it is.

## Decision

A fourth window, `replyCard.html` + `replyPage.ts`, on the application menu at
`⌘2` between Today (`⌘1`) and Firms (`⌘3`), with its own bridge on five channels.

Three reasons, in order of how much they matter.

**Retention.** G6's `DesktopState.today` is the cacheable shape, written to disk
encrypted for 24 hours (5.3), and it is a `strictObject` with no field a body or a
person's name could occupy. A reply card is a message somebody wrote. Putting it
inside the Today state would either put a body in the cache or add a
never-cache-this-field rule to a type whose whole guarantee is that it has no such
field. A separate type the cache has never heard of is the same rule made structural,
which is the reason G6 gives for splitting `todayContract.ts` from
`shared/contract.ts` in the first place.

**Shape of the work.** Today is the window a person leaves open all day and it has to
stay small and fast. Reading replies is a sitting-down task — the body, the quotation,
the firm-wide impact, six choices and a callback field — and it is opened, used and
closed, which is the shape G3b's note describes for the CRM windows.

**The authority boundary is easier to hold in a small surface.** `ReplyBridge` has
five methods: `state`, `refresh`, `open`, `collapse`, `confirm`. None of them closes an
opportunity, records a suppression, releases a hold or resumes automation, and the
unit test asserts the method list. Folded into `TodayBridge`, which already has seven
methods including a dial, that assertion would be about a mixed list and would say
much less.

## What is wired

All of it, as of this lane:

| File | Edit |
|---|---|
| `src/main/replyBridge.ts` | `createReplyBridge`, `REPLY_IPC_CHANNELS` |
| `src/main/todayWindow.ts` | `registerReplyBridge` — five `handleOnce` channels, arguments checked field by field |
| `src/main/app.ts` | built from the same `AuthedClient` and session manager; the `Replies` menu item |
| `src/preload/preload.ts` | `contextBridge.exposeInMainWorld('callieReplies', …)`, parsed with `replyStateSchema` |
| `scripts/bundle.ts` | `replyPage` as a fourth entry point, `replyCard.html` as a fourth page |

The accelerator for Firms moved from `⌘2` to `⌘3`. That is a user-visible change to
another lane's window and it is the smallest one available: the alternative was a
reply window at `⌘4`, out of the order a person reads them in.

## What the window may not do, and how that is held

* **It cannot preselect an answer.** `buildReplyCardView(state, card, chosen)` takes
  the person's choice as a parameter and Confirm is disabled until it is non-null. See
  `g7b-the-suggestion-is-not-a-default.md`.
* **It cannot act on confidence.** No condition anywhere reads it; the test compares
  the whole view at 0.99 and at 0.12.
* **It cannot commit the model's callback.** The proposal is a prefill in a date field.
  A confirmation that leaves it empty is refused by the server with
  `callback_required` and the bridge does not fill it in on the way past.
* **It cannot show a body to somebody who may not read one.** Appendix F redaction
  happens on the server; the view renders a sentence saying so and offers no answer.
* **It renders everything through `textContent`.** This window shows the text of
  somebody's mail, which is the string in this application most likely to contain a
  tag. The Playwright spec proves it with `<img src=x onerror=…>`, as G6's does.

## One thing this did not fix

`BUNDLE_FILES` in `src/main/bundleScheme.ts` maps three paths — `/index.html`,
`/renderer.js`, `/styles.css`. The secondary windows are not in it, so in a *packaged*
build `callie-app://bundle/today.html`, `firmWorkspace.html` and now `replyCard.html`
are all 404. That is a pre-existing gap affecting all three windows equally, and
`bundleScheme.ts` belongs to no lane in flight; it is reported rather than edited here,
because a one-window fix would hide a three-window bug. The development path
(`loadFile`) is unaffected, and so is every test, which is exactly why it has survived.
