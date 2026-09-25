# g65: Today is the home

Lane g65, 25 September 2026. Decides what a signed-in person sees first, how it looks,
and what becomes of the Today window. Reverses part of
`g6-the-today-page-is-its-own-window.md`.

## The gap

Desktop 1.0.2 signed in to a "This Mac" card (device details, the Mailbox row, Sign
out) and a bare list of cached card names with an Open button that opened nothing. The
real Today list — lanes, expansion into contact tasks, snooze or hold, the Call button,
the outcome form — was a second window behind ⌘1. Nothing on screen said what the person
had to do next: connect Gmail, add a calling number, record the domain checklist. G6's
record said so itself: "A later lane that owns `renderer.ts` should replace the panel
with a link to the window."

## Decision

**Home is the main window's signed-in screen.** One column: the business date, a line of
counts, the four lanes in the server's order, the last seven days in four figures, and a
Needs-you list. Beside it a sidebar: the windows with their keys, the system's status,
and "This Mac" as a `<details>` at the foot. Sign-in and the upgrade screen are
unchanged except for the stylesheet.

**The design is Mockup A2**, which David approved as "mockup A but minimal, with design
principles from Notion". Adopted in `apps/desktop/src/renderer/styles.css`, which every
window shares:

- one content column, at most 860px wide;
- sentence-case grey section headers with a small count;
- dividers instead of cards;
- colour only as a 7px dot or a small tag; offline, stale and refusals are grey lines
  with a dot, never coloured banners;
- row actions appear on hover and on keyboard focus;
- the keyboard shortcuts are shown beside the windows they open;
- system status lives in the sidebar;
- an empty state says what to do next: "Nothing today. Add firms and a sequence, and
  tomorrow's list builds at 05:00."

Light theme only, the system font at 15px/1.5, and the mockup's palette as custom
properties. The other windows keep their markup and test ids and pick the design up by
element and by the class names they already write.

**⌘1 focuses the main window, and the Today window is removed** (option (a) of the
brief). `today.html` and its opener are gone, `BUNDLE_WINDOWS` no longer lists it, and
`todayPage.ts` became `todayLanes.ts`, the one code path for the lanes, which Home calls.
Nothing depended on the file: the updater, the release checks and the packaging checks
all read `BUNDLE_WINDOWS` rather than a list of names. Keeping it as a second page over
the same module would have been two places showing one list, which is the duplication
G6 recorded as its own cost. `today.spec.ts` is folded into `home.spec.ts` with its
assertions intact.

**The Window menu** is Today ⌘1, Replies ⌘2, Firms ⌘3, Sequences ⌘4, Administration ⌘5,
and a new **Dashboard ⌘6**, which opens Administration on its Dashboard screen. The
template moved to `main/windowMenu.ts`, which imports no Electron.

**The page opens windows through one channel.** `callie.openWindow({ window })` names one
of `replies`, `firms`, `sequences`, `dashboard`, `administration`. `windowTargetOf`
compares the value with each literal, and anything else opens nothing and answers the
current state.

## Three rules the page keeps

- **It decides nothing.** Sending on or off is the settings snapshot's
  `effectiveSendingEnabled`. The domain row is `/outbound/status`'s
  `authenticationPasses`. The calling number is the one the server marks `usedForCalls`.
  The lanes are the snapshot's own runs, never sorted. The business date is the
  snapshot's `snapshotDate`, read at noon in `businessTimeZone`.
- **A fact that was not read is not a need.** A calling-number list that did not answer
  raises no "Add your calling number", and a salesperson is never shown the domain.
- **The Mac reads without being asked.** At sign-in and at launch Home shows the cached
  list, then reads today's. The figures are read at sign-in and on Refresh. Returning to
  the window re-reads the mailbox and the administration bridge's cached state, never
  the network. The lanes are redrawn only when their list changes, so a half-typed
  snooze reason survives the window regaining focus.

## Given up

- The Today window a person could leave open beside another app. Home is that window
  now.
- The administration bridge is one object behind two windows, so Home's
  `loadDashboard` no longer switches Administration's screen or its thirty-day window.
  Before, the next command Administration sent after a Home read came back drawn on the
  Dashboard.
- Row actions are invisible until hover. On a screen without hover they are always
  shown.
