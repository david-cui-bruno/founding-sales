# G14: departure holds firms rather than unassigning them

**Date:** 20 September 2026 · **Lane:** G14 retention · **Spec:** 10.3, 4.3, 5.2

## What the brief asked for

"Holds the departed user's enrollments for reassignment."

`enrollments` is lane G8's table and is not on main. This lane could not hold a row
that does not exist, and leaving the automation of a departed person's firms
runnable was not an option.

## Decision

**One `reassignment` hold per firm the departed member owns**, blocking every
automated action kind including `enrollment_advance`, with
`source_event_kind = 'membership.departed'` and
`recovery_action = 'resume_after_review'`.

Enrollments hang off firms and opportunities, and section 11.2 makes the worker
re-read "applicable holds" inside the claiming transaction before every external
action. So the hold stops the enrollments G8 will add without G8 having to know a
departure happened — which is why the hold is the right place for this rather than a
column on a table that does not exist yet. `PENDING_RETENTION_TABLES` names the
follow-up so the build asks for it when `enrollments` lands.

`reassignment` is an existing reason code from section 15's closed list, and it is
the accurate one: the firm needs a new owner and its work is blocked until it has
one. No new hold reason code was invented, because section 15's list is closed and
a departure is not a new *kind* of blockage.

**The assignment is left alone.** Nulling `firms.assigned_user_id` would have made
the firms ownerless, and an admin looking for the work that needs redistributing
would have had nothing to look for. The hold is visible, names the departed owner,
and clears only through the admin's own reassignment.

## Departure is not membership deactivation

`POST /admin/memberships/deactivate` already revokes the membership, the devices, the
sessions and the device credentials. It does not touch the Gmail grant, does not
delete the refresh token and does nothing about the firms.

The two are kept separate rather than merged. Deactivating a membership is a
reversible administrative act — somebody on leave, somebody moved between
workspaces. A departure deletes envelope-encrypted refresh-token material, which
cannot be undone, and records itself in a table with
`UNIQUE(workspace_id, user_id)`. Giving both to one endpoint would have made the
reversible one carry the irreversible one's consequences.

## The mailbox row stays

10.3 deletes "refresh-token material" and keeps "firm-related business
correspondence". Migration 0009 put the token in its own table for exactly this, and
its comment says so: the deletion is one row and leaves every business fact about
the mailbox in place.

Deleting the mailbox row would delete the firm's messages by foreign key — the
history of a company Callie spoke to, removed as a side effect of a person leaving.
So the mailbox is set `revoked` with a disconnect reason, its watch is cancelled
first so Google stops pushing to a mailbox the webhook would then reject, and the
row remains.

## Replay

The `departures` row is claimed before anything is revoked, not after. A second
command finds `departures_one_per_user` already satisfied and reports the first
departure with `replayed: true`, rather than revoking an already-revoked device a
second time and writing a second audit event claiming something happened.
