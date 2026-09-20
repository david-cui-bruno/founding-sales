# G7b: the reply bridge exists and is not yet installed

**Date:** 20 September 2026 · **Lane:** G7b reply classifier · **Spec:** 8.3, 14.2

## The situation

This lane owns `apps/desktop/src/**/reply*`. The card *shell* — the window, its HTML,
its place in the Today surface — is G6's, and three files that install a bridge are
nobody's in particular:

* `apps/desktop/src/preload/preload.ts` — `contextBridge.exposeInMainWorld`
* `apps/desktop/src/main/todayWindow.ts` — which window gets which preload
* the bundle list in the packaging script

Editing them would be editing outside the ownership list, which the lane brief
forbids, and they are exactly the files two lanes editing at once corrupts.

## Decision

The lane ships the three pieces that are its own and stops at the seam:

| File | What it is |
|---|---|
| `src/renderer/replyContract.ts` | the state, the card, the request, the bridge interface, all Zod-parsed |
| `src/renderer/replyView.ts` | the pure view model, including the authority boundary |
| `src/main/replyBridge.ts` | `createReplyBridge`, `REPLY_IPC_CHANNELS`, the API calls |

They are complete, typechecked and tested — `apps/desktop/test/reply.test.ts`, fifteen
cases, no Electron — and they are not reachable from a running application, because
nothing calls `ipcMain.handle(REPLY_IPC_CHANNELS.…)` and nothing exposes
`callieReplies` on a window.

## What the wiring is, exactly

Three edits, by whoever owns those files next. This is the whole of it:

1. **`src/main/app.ts`** (or wherever `createTodayBridge` is constructed): build
   `createReplyBridge({ api, session })` from the same `AuthedClient` and session
   manager, and register the five channels:

   ```ts
   ipcMain.handle(REPLY_IPC_CHANNELS.state, async () => await replies.state());
   ipcMain.handle(REPLY_IPC_CHANNELS.refresh, async () => await replies.refresh());
   ipcMain.handle(REPLY_IPC_CHANNELS.open, async (_event, input) => await replies.open(input));
   ipcMain.handle(REPLY_IPC_CHANNELS.collapse, async () => await replies.collapse());
   ipcMain.handle(REPLY_IPC_CHANNELS.confirm, async (_event, input) => await replies.confirm(input));
   ```

2. **`src/preload/preload.ts`**: a fourth bridge beside `callie`, `callieToday` and
   `callieCrm`, parsing with `replyStateSchema` the way `invokeToday` parses with
   `todayStateSchema`.

3. **The renderer**: call `buildReplyView(state, chosen)` and render it. The view model
   is designed so the page is a `for` loop and an event handler; the rules are all on
   this side of it.

## Why this is safe to leave

Nothing regresses. The desktop's existing tests are untouched and pass; the new files
are imported only by the new test.

The API surface is complete and tested from the server side
(`apps/api/test/replies.test.ts`), so the reply card is fully usable by any client
before the Electron window catches up — which matters, because the classification
lane's value is in the server: the hold, the suggestion, the confirmation and the
audit all happen whether or not a Mac is rendering them.

And the precedent is G3b's, which shipped the CRM bridge before the firm workspace
window existed, for the same reason and with the same note.
