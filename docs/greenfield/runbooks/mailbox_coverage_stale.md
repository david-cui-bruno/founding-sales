# mailbox_coverage_stale

**Metric:** `MailboxCoverageAgeSeconds` · **Severity:** warning · **Spec:** 12.3, 12.6, 13.3

## Symptoms

For three consecutive minutes, at least one connected, `ready` mailbox's coverage
watermark has been older than fifteen minutes. The watermark is 12.3's "the instant
through which every relevant message is known processed".

The send path holds every automated email for that mailbox's owner as
`coverage_incomplete` (`packages/domain/mail/coverage.ts`, `COVERAGE_FRESHNESS_SECONDS`).
Replies that arrived since the watermark may be unread. Nothing unsafe follows: the gate
is already holding.

The gauge reads `COVERAGE_FRESHNESS_SECONDS + 1`, 901, for a `ready` mailbox with no
watermark at all, or one more than five minutes ahead of the database clock. The gate
credits neither. A reading of exactly 901 means one of those two cases, not "fifteen
minutes and one second". No datapoint at all means no mailbox is connected and `ready`.

## First checks

1. `GET /diagnostics` as an admin: for each mailbox, check the coverage watermark, the
   last attempt (`last_synced_at`), the last sync error, the sync state and the watch
   expiry.
2. Is `mailbox_heartbeat_missed` or `worker_heartbeat_missed` also open? If so, work
   that page first. A check that is not running cannot move the watermark.
3. The owner's Gmail grant: `GET /gmail/status`.

## Diagnosis

A healthy mailbox is checked once a minute, and a check with nothing new still raises
the watermark to the moment it read. So a watermark fifteen minutes old with a fresh
heartbeat means the checks run and do not finish:

- **Rate limiting.** Gmail answers 429. The last attempt moves and the watermark does
  not, and `last_sync_error` names it.
- **A backlog drained over several capped passes.** Each pass processes part of the
  history and leaves the watermark where it was. This clears on its own and should not
  last fifteen minutes.
- **A history cursor Gmail no longer accepts.** The sync gives up and a recovery should
  follow; `sync_state` leaves `ready`, and this gauge stops reading that mailbox.
- **A watermark in the future** (the 901 reading with a recent last attempt). The host
  that wrote it had a clock well ahead of the database's.

## Safe recovery

- Rate limiting: wait. Do not raise quotas or shorten the check to force it; the next
  successful check moves the watermark and the gate releases on its own.
- A stuck cursor: `fss admin mailbox recover` for the mailbox. That is the proved
  recovery path, and it re-establishes a baseline before the mailbox is `ready` again.
- A future watermark: fix the clock of the host that wrote it, then run a recovery so
  the watermark is rewritten from a real sync.

## Escalation

Escalate after an hour, or when more than one mailbox reads stale, or when the last
attempt has also stopped moving. By then this is a mail-lane fault, not a slow Gmail.

## What must stay held

- Do not move `coverage_watermark_at` by hand. The watermark is the proof, and a
  hand-set one sends email to people whose replies nobody has read.
- Do not switch off the coverage gate to let the queue drain. Held sends are
  rescheduled, not lost.
