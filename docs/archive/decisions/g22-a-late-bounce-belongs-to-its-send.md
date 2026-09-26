# G22: a late bounce belongs to the send that caused it, and may take the ramp back

**Date:** 22 September 2026 · **Lane:** G22, the G15 follow-ups · **Spec:** 12.3,
12.4, 12.7, Appendix D

## What G15 named

> **A bounce counts on the day it arrived.** … The cost is that a bounce for
> yesterday's send, arriving after yesterday's day has been closed, is not counted
> against it. Attributing it to the originating fence's day instead would need the
> bounce report parsed back to a fence, which is detection this lane was told not to
> invent. Named here so it is a decision and not a surprise.

Two things were wrong with the behaviour, not one:

* **The day was wrong even when the day was open.** `RAMP_MAX_BOUNCE_RATE = 0.05` is a
  proportion of *one day's* automated sends. A bounce for a send that went out on
  Monday, read on Tuesday, was counted against Tuesday's denominator. Monday was
  flattered and Tuesday was slandered, and neither figure described anything that
  happened.
* **A closed day could not be corrected at all.** `recordDaySignal` is a bare `UPDATE`
  with no verdict logic, so a report arriving after midnight changed a counter nobody
  would read again, or — once the day had been closed and the ramp advanced — changed a
  counter that had already been used.

## The attribution

No detection was invented. 12.3 already names the mechanism for exactly this: matching
order is "Gmail thread ID; **RFC Message-ID references against FSS fences**; then known
normalized participants". A delivery-status notification carries the failed message's
`Message-ID` in `In-Reply-To` and `References`, both of which FSS already reads and
stores (`mail_messages.in_reply_to`, `reference_message_ids`, from the header
allowlist). The fence holds the deterministic id FSS wrote before sending
(`outbound_messages.provider_message_id_header`) and the business date the cap counted
the send against (`business_date`, added by migration 0010 and described there as "the
business date the cap counted this send against (12.7, Appendix D)").

`originatingSend` in `packages/domain/outbound/fence.ts` is that join, bracketing the
stored ids back up because `mail_messages` stores them unbracketed and the fence stores
them bracketed — the same asymmetry `fenceForOutgoingMessage` already handles.

Three choices in it are deliberate.

* **It is not narrowed to the mailbox the report arrived in.** The fence's own
  `mailbox_id` is the mailbox that sent, and 12.7's rate is a property of the sending
  mailbox's day. A report forwarded into another connected mailbox in the same
  workspace must still count against the mailbox that earned it.
  `provider_message_id_header` embeds the fence uuid, so the value identifies one fence
  whatever mailbox asks, and the read is workspace-scoped like every other.
* **A fence with no `business_date` answers null.** Such a fence was held before
  dispatch and never reached the counter, so there is no day to attribute to.
* **A report that names no fence still counts where it landed.** A daemon that sets
  neither header, or a bounce of a direct Gmail send that never had a fence, falls back
  to the arrival date — the behaviour before this lane. This is a real limit of version
  one and it is named in `docs/greenfield/sending.md` rule 6 and
  `docs/greenfield/mail.md` rule 5 rather than left to be discovered.

## Re-judging a closed day

`recordBounceAgainstDay` in `packages/domain/outbound/ramp.ts` increments the counter
and then decides, in four cases:

| The day | What happens |
|---|---|
| no row | nothing; a day with no automated sends is not a sending day (`no_sends`) and there is nothing to be a proportion of |
| open | counted, not judged; the close is what judges |
| closed, and the new count still acquits it | counted; the verdict stands |
| closed healthy, and the new count condemns it | `healthy` flips to false, `mailbox_send_ramp.last_health_failure` records why, and `healthy_sending_days` gives back the day it earned |
| closed unhealthy | counted; nothing is taken, because it never advanced the ramp |

### The non-counter conditions come from the verdict, not from a fresh read

`rampHealthFailure` takes seven inputs; a bounce changes one. The re-judgement passes
`authenticationPasses: true`, `coverageHealthy: true`, `providerWarning: false` rather
than calling `readSendDayHealth` again, because **`healthy = true` on a closed day is
the record that those three held when the day closed.** Re-reading them would judge
yesterday on today's mailbox state: a coverage hold opened this morning, or a domain
whose DMARC checklist has since lapsed, would condemn a day it had nothing to do with
and take back a day that was genuinely earned. The stored verdict is the evidence, and
the only honest question a late report raises is the one about counters.

### Taking a day back is a decrement, and `last_advanced_on` does not move

12.7's cap is "a function of one stored number — healthy sending days", so a day that
turns out not to have been healthy must leave the count. `greatest(n - 1, 0)` is
`mailbox_send_ramp_days_not_negative` said in SQL.

`last_advanced_on` is deliberately left where it is. It is the guard in `closeSendDay`
(`WHERE last_advanced_on IS NULL OR last_advanced_on < $date`) that stops the same date
advancing the ramp twice; rewinding it would let a later close of that date re-earn the
day this call has just taken away, which is the failure the guard exists to prevent.
The consequence is that the day is removed from the count and can never be re-added,
which is the conservative direction: the cap falls, never rises.

### At most once per day

The flip is `UPDATE … SET healthy = false WHERE … AND healthy`, and the decrement
happens only when that affected a row. The increment `UPDATE` earlier in the same
function already holds the day's row lock for the transaction, so two concurrent late
bounces serialize and the second finds a day that is no longer healthy. The day-level
`mail_message_effects` uniqueness in `applyClassificationEffects` is the other half: the
same report re-imported is not counted twice at all.

## What was considered and rejected

* **Reopening the day and re-running `closeSendDay`.** It would re-read the three
  non-counter conditions (wrong, above), and it would have to clear `closed_at` to do
  it, which puts the day back into `listDaysToClose` and into the sweep's backlog for a
  date the sweep has finished with.
* **A `late_bounces` column, or an `outbound_message_id` on the signal.** Either is a
  migration, and neither answers a question anybody asked: the day's `bounces` is what
  `rampHealthFailure` reads, and the fence's own row is where a "which send bounced"
  question is already answered by `route_invalidated` in `mail_message_effects`.
* **Refusing to attribute without a fence.** A bounce that cannot be traced is still a
  bounce and still evidence about deliverability. Dropping it would make the ramp
  advance on a day that genuinely misdelivered, which is the wrong direction for a
  safety limit.
* **Counting a late *opt-out* against the originating send.** An opt-out is a fact
  about the moment a person asked, not about the send: 12.7's opt-out rate is the
  proportion of the day's recipients who asked to stop, and a request that arrives on
  Tuesday is Tuesday's. Unchanged, and now stated in the code beside the bounce arm so
  the asymmetry is visible.

## No migration

None. `mailbox_send_days.bounces`, `healthy`, `closed_at` and
`mailbox_send_ramp.healthy_sending_days`, `last_health_failure` all exist, and
`mailbox_send_days_verdict_consistent` already admits `healthy = false` with a
`closed_at`. Schema ranges stay at `{15, 15}` where lane G20's migration 0015 left them.
