# gmail_watch_expiring

**Metric:** `GmailWatchHoursToExpiry` · **Severity:** critical · **Spec:** 12.3, 13.3

## Symptoms

A Gmail watch is within two days of expiry. Push notifications stop when it lapses;
the one-minute reconciliation still runs, so the failure is latency rather than loss —
until the reconciliation also fails.

## First checks

1. `GET /diagnostics` as an admin: watch expiry per mailbox, and the generation each
   watch was registered under.
2. Whether a `mail.watch_renew` job exists for that mailbox and generation, and what
   state it is in.
3. The mailbox's grant and status.

## Diagnosis

Watches are renewed daily under the key `watch:{mailbox}:{generation}`: the scheduler
asks for a renewal once the live watch is 24 hours old, so a healthy mailbox reads
between 144 and 168 hours and falling below 48 means about four days of renewals have
not completed. (Before lane g58 the renewal waited for the watch's last day, and this
alarm fired for a day in every six on a healthy system; on such a build, check the
watch's `registered_at` before treating it as a fault.) An approaching expiry means the
renewal is not completing:

- the worker is down or the queue is behind;
- the grant is revoked, so Google refuses the watch;
- the Pub/Sub topic or its IAM binding changed and Google refuses the target;
- the mailbox generation advanced (a reconnection) and the old watch is expiring
  correctly while a new one exists — check the generation before treating it as a
  fault.

## Safe recovery

- Restore the worker or the grant, then let the renewal job run. The key is generation
  scoped, so a replay renews the same watch rather than registering a second.
- If the topic or binding changed, fix it in infrastructure and redeploy; do not
  register a watch by hand against a topic Terraform does not know about.
- While push is down, the one-minute reconciliation is the safety net and is enough for
  correctness, not for speed.

## Escalation

Escalate before expiry, not after. Once the watch lapses the mailbox depends entirely
on reconciliation, and a reconciliation fault then becomes a coverage gap.

## What must stay held

- Do not treat "push is working again" as coverage. Coverage is the watermark, and it
  moves only when an interval is fully processed.
- Do not disable the reconciliation pass to reduce API calls while push is being
  repaired. It is the reason a dropped notification is not a lost reply.
