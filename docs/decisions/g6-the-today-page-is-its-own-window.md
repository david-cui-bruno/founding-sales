# G6: the Today page is a third window, and one preload installs all three bridges

**Date:** 20 September 2026 · **Lane:** G6 Today list · **Spec:** 14.2, 5.3

## The question

G2's `renderer.ts` already draws a small Today panel inside the sign-in and device
window. This lane's brief asks for "aggregate cards, expand to contact tasks, dial and
outcome via G4, stale-view rule and last-good cache from G2's scaffold". Does that
replace G2's panel, or sit beside it?

## What was chosen

A third window — `today.html` + `todayPage.ts` — beside G2's `index.html` and G3b's
`firmWorkspace.html`, reached from the application menu, with one preload script that
installs `callie`, `callieToday` and `callieCrm`.

G2's panel is left exactly as it is.

## Why a third window

**It is the precedent this tree already set.** G3b wrote the CRM windows as a second
entry point rather than a fifth screen inside `renderer.ts`, and said why in
`firmWorkspace.ts`: "The Today window is the one a person leaves open all day and it has
to stay small and fast; the CRM windows are opened, used and closed." The same reasoning
gives Today its own window rather than folding a dial panel, an outcome form and an
expandable card list into the page that also holds the sign-in form.

**`renderer.ts` is not this lane's file.** The ownership list is
`apps/desktop/src/**/today*`; rewriting G2's renderer would be editing a file another
lane owns, for a change that has a clean alternative.

**The stale rule is shared rather than copied.** Both windows read the same
`SessionManager`, which is the one thing that knows about the encrypted 24-hour cache,
the "marked stale" rule and the revocation wipe. `todayBridge.ts` projects its state
into `TodayState`; nothing about the cache is re-implemented.

## Why one preload rather than three

Electron gives a window one preload script, and a window only ever calls the bridge it
was built for. Installing all three is not a widening: every channel is answered by a
main-process handler that exists, and a window that never calls one has reached nothing.
Three preload files would be three places for the channel list to drift from
`TODAY_IPC_CHANNELS`, `CRM_IPC_CHANNELS` and `IPC_CHANNELS`, which is the drift those
constants exist to prevent.

`callie` and `callieToday` are parsed on the renderer side against `strictObject`
schemas, as G2 intended: "a state that grew a field it should not have — a token, a body
— fails here instead of reaching the page". `callieCrm` is not, because `CrmState` is an
interface G3b composed from `@fss/contracts` DTOs rather than a schema, and writing a
second schema for it here would be a second definition of G3b's contract.

## Why a menu

The windows need a way in, and this lane owns neither `renderer.ts` (which would have
carried a button) nor `firmWorkspace.ts`. An application menu is where macOS puts a
window that is not the front one, it costs two items, and `windowMenuTemplate` is a
value so it can be asserted without Electron.

## What is given up

* Two places show something called "today": G2's panel, which lists card names from the
  cache, and this window, which is the real thing. A later lane that owns `renderer.ts`
  should replace the panel with a link to the window.
* A person has to open the window. `callie://today` already exists as a deep link in
  `main.ts` and focuses the main window; pointing it at this one is a small change to a
  file this lane also does not own.
