# G9: two configuration slices left `workspace_settings` before it was published

**Date:** 20 September 2026 · **Lane:** G9 · **Spec:** 10.1, 11.2, 12.6, 12.7, 16.2

`workspace_settings` was drafted with seven slices. Two were removed on the
coordinator's instruction before this branch was published, and the two removals draw
a rule worth writing down rather than two separate apologies.

## The rule

**A `jsonb` settings slice is for an operator knob that nothing joins to, nothing
constrains, and nothing freezes a version of.** Anything else belongs in a table of
its own, owned by the lane that owns the behaviour.

The five that remain — the alarm thresholds, the workspace business zone, the
supported client-version range, the postal footer, the production sending
attestation — are all of that kind. Nothing has a foreign key into a setting's
contents, and no stored row records which version of one produced it.

## The holiday calendar (G8, migration 0012)

11.2: "A business-day delay skips weekends and configured workspace holidays, then
resolves in the firm's actual zone. Due instants are stored in UTC together with the
source zone and **rule version**." `WorkspaceHolidayCalendar` in
`packages/domain/src/rules/businessDays.ts` already carries that version, and the
comment on it says why: "a later change to the holiday calendar can then be told
apart from a bug".

That makes the calendar version immutable by requirement. Every stored due instant
points at it. A `jsonb` slice whose next save rewrites the value in place cannot be
pointed at — the version number would survive and the dates behind it would not.
G8's `workspace_holiday_calendars`, with one current row and a version other rows
freeze, is the shape the requirement asks for.

An earlier draft of this lane had `holidayCalendarOf(setting, settingVersion)`
minting `workspace.<n>` from the settings row's version. That would have *looked*
correct — the version did change on every save — while the dates a previously frozen
version referred to were gone. It is deleted.

## The sending limits (G7-2, migration 0010)

12.7 gives an admin a lower bound on the per-mailbox cap and a raise to 75 after
sustained healthy results, under a hard ceiling of 100. 12.6 gives the primary domain
a rolling 4,000-recipient guard. 12.7 also requires SPF, DKIM and DMARC to pass and
Postmaster Tools to be reviewed before automated sending is enabled.

Every one of those is a *constraint*, and G7-2's 0010 writes them as constraints:
`mailbox_send_ramp` holds `admin_daily_cap` and `raised_daily_cap` with 75 enforced
by command and 100 by CHECK, the ramp itself computed from `healthy_sending_days`
rather than stored; `sending_domains` holds the four authentication facts with a
CHECK that forbids enabling without all four.

A `jsonb` blob cannot carry a CHECK. The draft slice had the ceilings as Zod maxima
instead, which is a real bound on the API and no bound at all on a worker, a data
migration or a hand-written `UPDATE`. Configuration that governs outbound mail is
exactly where the database is worth more than a schema. `effectiveMailboxDailyCap`
went with it: combining a ramp with a stored cap in a second place is a second
implementation of 12.7 that can disagree with the constraint, and the constraint is
the one that stops a send.

## What the settings surface does instead

`SETTINGS_ELSEWHERE` gains three entries, so the page links rather than duplicates:

| Topic | Path | Owner |
|---|---|---|
| Workspace holidays | pending: G8 migration 0012 | G8 |
| Sending caps and the ramp | `/outbound/cap` | G7-2 |
| Domain authentication and sending enable | `/outbound/authentication` | G7-2 |

The calendar's entry says *pending* rather than being omitted, because a person will
look for it and "not here" is a worse answer than "not yet". It is one string to
replace at the final merge.

`personal_gmail_guard_per_24h` is rendered read-only and has no control at all: 12.6
calls lowering it a reviewed product-policy change, and G7-2 deliberately exposes no
route for it.

Both `/outbound/*` paths are admin-only with a redacted 403, so the sending section
is gated on role in the view rather than offering a control that answers 403.

## Follow-ups at the final merge

1. ~~After 0010 lands: point the Settings window's sending section at
   `POST /outbound/cap` and `POST /outbound/authentication`, and implement
   `DashboardSources.sending`.~~ **Done**, 20 September 2026, when 0010 reached main.
   The Settings window reads `/outbound/status` for an admin only and posts to
   `/outbound/cap` and `/outbound/authentication`; `personal_gmail_guard_per_24h` is
   rendered with no control and the reason beside it. `sendingFacts` in
   `packages/domain/dashboard/sendingSource.ts` reads `outbound_messages`,
   `mailbox_send_days`, `mailbox_send_ramp` and `sending_domains`, and
   `liveDashboardSources()` is passed at the one call site in
   `apps/api/src/routes/dashboard.ts`.

   Two things the wiring had to decide, both recorded here rather than in code
   comments alone. `/outbound/status` answers a ramp only for a named mailbox — it
   has no list form, and adding one is G7-2's call — so the Settings window takes
   the mailbox ids from `/diagnostics`, which already applies Appendix F row 3 to
   them, and asks for each ramp by id; `mailboxes_one_per_owner` bounds that at one
   per member. And the salesperson's copy of the *dashboard's* posture keeps the
   same row-3 rule: their own mailbox's ramp, and no domain checklist at all,
   because the checklist is admin configuration.
2. After 0012 lands: point the calendar editor at G8's command, or — if G8 exposes
   none — add one in `packages/domain/settings` writing to G8's table, and record
   that here.
3. `WORKER_SCHEMA_RANGE.minimum` stays where G7-2 left it (10) for this lane: with
   both slices gone, no worker code path reads `workspace_settings` at all, so this
   lane's migration raises neither end of the worker's range.

## The third slice, which stays: `sending_enabled`

Ruled by the coordinator on 20 September 2026, after this lane flagged the overlap.

`sending_enabled` stays in `workspace_settings`, because it and G7-2's
`sending_domains.automated_sending_enabled` are **two facts, not two copies of one**:

* G7-2's flag is the **per-domain authentication gate**. It says SPF, DKIM and DMARC
  pass for *this sending domain* and Postmaster Tools has been reviewed, and a CHECK
  forbids setting it without all four (12.7).
* This slice is 16.2's **workspace attestation**. It says an authenticated admin
  enabled production sending against a named `releaseGateReference` — the rehearsal
  run whose artifact digests match what is deployed. It says nothing about DNS, and
  G7-2's flag says nothing about the rehearsal.

**Both must hold before an automated send**, together with the deployment flag this
lane already ANDs in `effectiveSendingEnabled`
(`docs/decisions/g9-sending-enable-is-two-switches.md`). Neither lane's flag is
sufficient alone, and neither is a substitute for the other: a domain with perfect
authentication that nobody rehearsed must not send, and a rehearsed release must not
send from a domain that fails DMARC.

## Who wires the send path

**Not this lane, and not G7-2.** The read of this attestation on the outbound path is
**G12's** (release gates), and the coordinator has recorded it in G12's brief. This
lane owns the storage, the versioned history, the admin command and the surfaces that
show it; G12 owns the moment before a send when all three are consulted.

That is why `effectiveSendingEnabled` takes the deployment flag as an argument rather
than reading configuration for itself: it is a pure rule G12 can call from the
sending path with whatever the deployment says, and it fails to `false` on an
unreadable setting.

Until G12 lands, this attestation is enforced nowhere on the send path. That is safe
only because production sending is off by default at both switches and no automated
send exists yet (G7-2 and G8 are still in flight) — it is a gap in sequencing, not in
the design, and it closes when G12 does.
