# Today: one card per firm, derived from its tasks

Specification revision 3, sections 8.2 and 8.3, Appendix A rows "Reassign firm" and
"Callback confirm/complete", Appendix C's `today:{workspace}:{business_date}:{algorithm}`,
Appendix D, and Appendix G 8 and 33. This is the shape of the daily list and the rules
that govern changing it.

## The short version

`today_items` is the truth: one row per contact task on one workspace business date.
`today_snapshots` is the *card*, and every column that describes a firm's position in
the list is recomputed from that firm's unfinished items by a row trigger, inside
whatever transaction touched them. `today_snoozes` outlives both, because a task
snoozed until Thursday must not come back in Wednesday's 05:00 rebuild.

Deriving the card rather than writing it is what makes 8.2's hardest sentence true by
construction: "The firm's lane and sort instant come from its highest-priority and
earliest-due unfinished item." A writer cannot forget to update the card, because no
writer updates the card.

## Where everything is

```
packages/domain/db/migrations/0008_today.sql  the tables, the recompute, the triggers
packages/domain/today/types.ts                lanes, kinds, refusal codes, the algorithm version
packages/domain/today/lanes.ts                8.2's ordering, as pure functions
packages/domain/today/snapshots.ts            the reads and the one write path
packages/domain/today/build.ts                the 05:00 build and its sources
packages/domain/today/promotions.ts           the interface G7 and G8 call
packages/domain/today/snooze.ts               snooze, and the hold an automated send gets
packages/domain/today/dto.ts                  the list, the expanded card
apps/worker/src/handlers/todayBuild.ts        the job and its scheduler source
apps/api/src/routes/today.ts                  GET /today, POST /today/firm
apps/api/src/routes/snooze.ts                 POST /today/snooze, /today/snooze/cancel
apps/desktop/src/renderer/today*.ts           the lanes: contract, view model, drawing (todayLanes.ts)
apps/desktop/src/renderer/home*.ts            Home, the main window that shows them (lane g65)
apps/desktop/src/main/todayBridge.ts          the main-process half of its bridge
apps/desktop/src/main/telHandoff.ts           the tel: driver and the two dial commands
apps/desktop/src/main/crmBridge.ts            G3b's CRM windows, wired
apps/desktop/src/main/todayWindow.ts          the other windows and their channels; the menu is windowMenu.ts
```

## The four rules a reader should carry

### 1. The card is derived, and nothing writes it

`today_refresh_card(workspace, date, firm)` reads the firm's open items and writes the
card: the lane and sort instant from `ORDER BY today_lane_precedence(lane), due_at,
item_key LIMIT 1`, the four counts as `count(*) FILTER`, and the assignee from
`firms.assigned_user_id`. A row trigger on `today_items` calls it after every insert,
update and delete.

The tiebreak is `item_key` and not `id`, and that is load-bearing: a generated uuid is
not the same in two databases, so a build of the same data in two places would choose a
different "earliest" task among ties. The property test in
`packages/domain/test/today/determinism.test.ts` builds the same firms and callbacks
twice, in two different insertion orders, on two databases, and compares the lists.

When the last item is finished the card keeps the lane and instant it had and its
`open_items` reaches zero. It stops being on the list — the reader filters `open_items
> 0` — and stays in the table as the record of what that day's list contained. That is
8.2's "Completing one item leaves the firm visible while another qualifying item
remains", from the other end.

### 2. A promotion commits with its source event, and the source lane never learns about Today

8.2: "Event-driven reply and callback promotions commit with their source event."

**Callbacks are a trigger.** `callbacks_today_promotion` fires inside G4's
`createCallback` transaction. Nothing in `packages/domain/today` is called and nothing
in `packages/domain/dial` knows this table exists; a rolled-back callback leaves no
Today entry, which `today.test.ts` proves by rolling one back and finding none.
Completing or cancelling the callback finishes its task the same way — Appendix A's
"Callback and Today promotion/removal".

**Reassignment is a trigger.** `firms_today_transfer` fires on any change of
`firms.assigned_user_id`, so G3a's `reassignFirm` transfers the day's entries without a
line in its file. The transfer is an update of the card's assignee, which is transfer
*without duplication* by construction: there is one card per firm per date and nothing
to copy. The items carry no assignee of their own, because a firm has at most one
assigned salesperson and a per-task copy could only ever disagree with the firm.

**Replies are a function**, because G7's tables do not exist yet and there is nothing to
put a trigger on. `promoteReply(context, { firmId, contactId?, messageId, receivedAt })`
is what the classification lane calls, in the same transaction as the message and its
holds — Appendix A's "Record uncertain or ambiguous reply" row commits "message,
candidates, independent active holds, Today entries, audit" together, and this is the
fourth of those. Uncertain and ambiguous messages use the same kind: 8.2's lane 1 is
"replies, including uncertain and ambiguous messages", so there is deliberately no
second kind for them, and 8.3's classification content is G7b's.

`promoteTodayItem` is the general form, for the sequences lane's due work.

### 3. The build decides which tasks exist, and cancels only what it enumerated

`buildTodaySnapshot` asks each `TodaySource` for its contributions and upserts them.
Two sources have a table to read today — `callbackSource` (lane 2) and `newFirmSource`
(lane 4) — and the reply and due-work lanes are sources the lanes that own those tables
will add to the array. Nothing in `build.ts` changes when they do.

A rebuild cancels the tasks its sources no longer produce, and only for the
`source_kind`s a source actually declared. A reply promoted at 09:00 by a lane with no
source in this build is not something the build knows is gone, and there is a test that
a rebuild leaves it alone.

Two rules live in `today_upsert_item` and nowhere else: a finished task is never
reopened by a rebuild, and an active snooze wins over a rebuild.

### 4. An automated send is held, not snoozed, and the server decides which

8.2: "Salespeople may snooze manual tasks with a required reason and explicit return
instant. Automated sends are not snoozed ad hoc; delaying them creates a recorded hold."

One endpoint, `POST /today/snooze`, and the server reads `today_items.automated` to
decide. That is deliberate: a client that had the choice would be the thing that let an
automated send go out on time with nobody expecting it, because its card was drawn
before the task changed. The answer says which of the two happened and the window
renders that.

A manual task becomes a `today_snoozes` row keyed by `item_key`, so it survives the
05:00 rebuild. An automated one opens an `active_holds` row against the firm for the
action kind the task belongs to, and the day's entry is closed: the send is not
happening today, and what brings the work back is releasing the hold, not a clock. See
`docs/decisions/g6-delaying-an-automated-send.md`.

## The job

Appendix C: `today:{workspace}:{business_date}:{algorithm}`, protected by "snapshot
uniqueness". All three parts of the key matter — the workspace because the list is per
workspace, the business date because a pass at 05:00 and one at 05:01 are the same
work, and the algorithm version because changing the ordering rules makes it *different*
work rather than a second attempt at the old work.

`todayBuildSource` materializes it from the first scheduler pass at or after 05:00 in
the workspace's own zone, computed by PostgreSQL from `workspaces.business_time_zone`.
A workspace whose scheduler was down at 05:00 gets its list on the first pass after it
comes back, which is also what makes 13.3's "Today snapshot absent at 05:10 workspace
time" an alarm about a real outage.

`TODAY_ALGORITHM_VERSION` in TypeScript and `today_algorithm_version()` in SQL are the
same string, and a test compares them.

## The Mac

Three windows now: G2's sign-in and device page, G3b's CRM windows, and this lane's
Today page. Three renderer entry points, one preload script that installs all three
bridges, and one main process that answers their channels.

**Since lane g65 there is no Today window.** The lanes are the main window's signed-in
screen, Home, beside a status sidebar, the last seven days and a Needs-you list
(`docs/decisions/g65-today-is-the-home.md`). `todayPage.ts` became `todayLanes.ts`,
which Home calls; ⌘1 brings the main window forward. The bridge, the view model and
every rule below are unchanged, and G6's Playwright scenarios run against Home in
`apps/desktop/test/e2e/home.spec.ts`.

**The cards are cached and the expansion is not.** `GET /today` returns exactly the
shape of `cachedTodaySchema` in `apps/desktop/src/shared/contract.ts` — G2 wrote it as
a `strictObject` with no field a body, a note or a person's name could occupy, and it is
written to disk encrypted for 24 hours (5.3). The expanded card names contacts, so it
lives in a type the cache has never heard of, and an offline window shows the cards
marked stale with nothing under them. That is 4.2's "unexpired cached Today view marked
stale" and "mutations fail closed", and it is a unit test in `todayView.ts` rather than
a screenshot.

**The window never holds a ticket.** `bridge.dial()` performs the setup proof, the
authorization, the consumption and the `tel:` open in the main process, through G4's
`dialHandoff.ts` and this lane's `telHandoff.ts`, which is the macOS binding of its two
ports: the launch-services probe for the proof and `shell.openExternal` for the open.
There is no Swift helper — section 2's decision table, and David's confirmation. The
driver opens a `tel:` URI with an E.164 number and throws for anything else, so
`shell.openExternal` is unreachable from that module for any other scheme, and a probe
that answers `absent` *or* `unknown` is `no_tel_handler`: an unreadable Launch Services
database is not a proof of anything. A setup proof older than a ticket's own sixty
seconds stops being current, because the real check reads an `lsregister -dump` that
cannot happen between consuming a ticket and opening a URI. The renderer sends the firm, the route and the *displayed* route
version — 9.2's "authorization uses the route version displayed on the card" — and gets
back a state with a notice. The calling identity is the one the server reported with the
card, because 9.1 requires it to be the actor's own and there is nothing there to
choose.

**The card needs the person's own attested number (lane g60).** `readTodayFirm` reports
`callingIdentityId` from `currentCallingIdentityId`: the most recently attested of the
actor's verified, enabled calling numbers. Until someone has registered and attested a
number (the Settings screen's **Your calling number**, `docs/greenfield/settings.md`) it
is null. The card then has no Call button, and says so: a card with a usable route and
no calling identity shows *"Callie has no attested number of yours to call from. Add it
in Window › Administration, under Your calling number."* (`NO_CALLING_NUMBER` in
`todayView.ts`). Before g60 no product path could make one, so every production card was
in that state. Once the number is attested, the next expansion carries it and the Call
button appears. A retired number stops being offered at once, because both the card and
`authorizeDial` read `enabled`. See `docs/decisions/g60-calling-identities-are-attested-in-version-one.md`.

### What this lane wired that it did not write

G3b built `firmWorkspace.ts`, `firmPage.ts`, `pipelineBoard.ts` and `firmMerge.ts` and
left them unreachable: `globalThis.callieCrm` was declared in
`firmWorkspaceContract.ts` and installed by nobody. Added here, with no change to G3b's
renderer code:

* `apps/desktop/src/main/crmBridge.ts` — the six methods its contract declares,
  answered from `/crm/firm-page`, `/pipeline/stages`, `/firms`, `/contacts/update`,
  `/opportunities/stage` and `/merges/firms`;
* `apps/desktop/src/preload/preload.ts` — `callieCrm` and `callieToday` beside G2's
  `callie`;
* `apps/desktop/src/main/todayWindow.ts` — both windows, their IPC registration, and
  the application-menu items that open them (a menu rather than a button, because this
  lane does not own `renderer.ts`);
* `apps/desktop/scripts/bundle.ts` — the two new renderer entry points and their HTML,
  so a packaged build contains them;
* `apps/desktop/src/main/sessionManager.ts` — one method, `accessToken()`, which goes
  through the existing `liveSession` so renewal stays serialised. Without it a second
  window would have to hold the refresh credential, and reuse revokes the device (5.3);
* `apps/desktop/src/main/telHandoff.ts` — the macOS binding of G4's two handoff ports,
  and `createDialApi`, which is the two commands of 9.2 through the window's
  authenticated client.

One thing the wiring cannot do yet, recorded rather than faked:

* **Stage changes from the board.** `GET /firms` returns `FirmIdentityDto`, which
  carries the open opportunity's stage and not its id, so the board can only offer a
  stage change for firms whose Firm page has been opened. See
  `docs/decisions/g6-pipeline-board-opportunity-ids.md`; the gap belongs to the lane
  that owns Appendix F's read matrix.

## Adding a source or a lane

1. Write a `TodaySource` with the `source_kind`s it is authoritative for, and add it to
   `defaultTodaySources()`.
2. For an event-driven promotion, call `promoteTodayItem` in the transaction that
   records the event. Do not write `today_snapshots`; the trigger does.
3. Pick an `item_key` that is deterministic from the row that produced it, so a replay
   is an upsert.
4. `npm run gate:greenfield`.

## Running the tests

```
npm run gate:greenfield
npm run test --workspace packages/domain -- test/today            # G 8 and G 33, determinism
npm run test --workspace apps/api -- test/today.test.ts           # the routes
npm run test --workspace apps/worker -- test/todayBuild.test.ts   # G 1 and G 2 for this handler
npm run test --workspace apps/desktop -- test/today.test.ts       # the view model and both bridges
npm run test --workspace apps/desktop -- test/telHandoff.test.ts  # tel: only, and the probe
npm run test:desktop:e2e                                          # the window, in chromium
```
