# mailbox_heartbeat_missed

**Metric:** `MailboxCheckHeartbeat` · **Severity:** critical · **Spec:** 12.3, 13.3, 4.2

## Symptoms

Three consecutive one-minute windows with no mailbox check. Replies, opt-outs and
bounces may exist in Gmail and be unknown to FSS.

## First checks

1. `GET /diagnostics` as an admin: per-mailbox status, sync state, coverage watermark,
   last sync error and watch expiry.
2. Whether `worker_heartbeat_missed` is also firing — if it is, work that one first;
   the mailbox check runs in the worker.
3. The mailbox's Gmail grant: `GET /gmail/status` for the owner.

## Diagnosis

The mailbox heartbeat is the only workspace-scoped one. Its absence means the
one-minute reconciliation is not running for that mailbox, which is one of:

- the worker is down (see `worker_heartbeat_missed`);
- the grant was revoked, so every call fails and the mailbox is held;
- the history cursor expired and a bounded full synchronization is in progress and
  failing;
- the mailbox row is `disconnected` and should not be checked at all — in which case
  the heartbeat's absence is correct and `mailbox_disconnected` is the real alarm.

## Safe recovery

- Restore the worker, or have the mailbox owner reconnect through `/gmail/connect`.
- A reconnection begins a bounded baseline covering active enrollments, unresolved
  outbound messages and the configured recent-history interval. Automation stays held
  until that baseline completes; that is the recovery working, not a second fault.
- On an expired cursor the worker synchronizes from the earlier of the watermark minus
  one hour and the oldest unresolved outbound message or active enrollment. Let it run
  to completion.

## Escalation

Escalate if the grant cannot be restored by its owner within a business day, or if a
full synchronization fails repeatedly against a valid grant.

## What must stay held

- Every automated step kind for that owner stays held until coverage is complete
  (4.2, 12.6). The coverage watermark is the proof; do not move it by hand.
- Do not advance the history cursor manually to skip a slow recovery. The cursor is
  compare-and-set for exactly this reason.
- Do not delete and recreate the mailbox row to clear the hold; that discards the
  watermark that proves what was read.
