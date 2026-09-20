# G14: departure holds firms and enrollments rather than unassigning them

**Date:** 20 September 2026 · **Lane:** G14 retention · **Spec:** 10.3, 4.3, 5.2

## What the brief asked for

"Holds the departed user's enrollments for reassignment."

When this lane started, `sequence_enrollments` was lane G8's table and was not on
main. It landed with migration 0012 before this lane published, so the command does
both halves now, and the interim is recorded below because it is the part worth
reading.

## Decision

**Two `reassignment` holds**, both blocking every automated action kind including
`enrollment_advance`, both with `source_event_kind = 'membership.departed'` and
`recovery_action = 'resume_after_review'`:

* one per **firm** the departed member owns (`scope_kind = 'firm'`);
* one per **live enrollment** assigned to them (`scope_kind = 'enrollment'`, where
  live is 0012's `ended_at IS NULL`).

**Both, because the two sets are not the same set.**
`sequence_enrollments.assigned_user_id` is its own column, so an enrollment the
departed member was running may sit at a firm assigned to a colleague — a firm hold
alone would miss it — and a firm they owned may carry enrollments assigned to
somebody else, which the firm hold catches and should, because the firm itself needs
a new owner. Holding both is the only version that covers the departed member's work
exactly.

Neither hold requires G8 to know a departure happened. `applicableHolds` in
`packages/domain/sequences/resume.ts` reads the workspace, firm, opportunity, owner
and enrollment scopes before every external action, inside the claiming transaction
(11.2). The hold is therefore read by code written before this command existed, which
is why a hold is the right mechanism here and a column on somebody else's table is
not.

**The enrollment itself is untouched.** A departure is not a stop: the work still
needs doing, by somebody else. 11.2's terminal reasons are about the prospect — they
replied, they opted out, the stage closed — and "the salesperson left" is not one of
them. Contrast the deletion workflow, which *does* stop enrollments with `admin_stop`,
because there the prospect's data is gone and there is nothing left to do.

### The interim, and how it was made to expire

While `sequence_enrollments` was still in flight, the command opened only the
firm-scoped holds and relied on the fact that enrollments hang off firms. That was a
real gap and not a complete answer, so it was written into
`PENDING_RETENTION_TABLES` as something G8's table would owe. When 0012 landed the
guard test failed and printed the sentence; the direct hold is here because the build
asked for it.

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
