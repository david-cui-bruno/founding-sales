# Sending: the at-most-once fence, the ramp and the domain guard

Specification revision 3, sections 12.5, 12.6, 12.7 and 11.2, and Appendices B, C, D,
F and G 5, 6, 12, 16, 33, 36. This is the only part of FSS that does something to a
prospect that cannot be undone.

## The short version

Every FSS email has exactly one row in `outbound_messages` — its **fence**. The fence
is created before anything is rendered into a request, frozen the moment dispatch
begins, and moved through a state machine the database enforces:

```
prepared → dispatching → sent
prepared → dispatching → reconciling → sent | unknown_terminal
prepared → held → prepared
```

Only the atomic `prepared → dispatching` transition mints an **attempt token**, and
only the holder of that token can move the fence to `sent`. A worker that lost its
lease, a replacement that reclaimed the job, a sweep that found an abandoned fence —
none of them has the token, and the only move left to them is `reconciling`, which
observes Gmail's Sent folder and never sends.

`dispatching` never returns to `prepared`. That one sentence is what the whole package
is built around.

## Where everything is

| What | Where |
|---|---|
| Migration | `packages/domain/db/migrations/0010_outbound.sql` — five tables |
| Domain | `packages/domain/outbound/**` |
| The fence and its transitions | `outbound/fence.ts` |
| Everything checked before a send | `outbound/gate.ts` |
| The one Gmail call | `outbound/send.ts` |
| Sent-folder reconciliation | `outbound/reconcile.ts` |
| 12.7's ramp and the daily counters | `outbound/ramp.ts` |
| 12.6's guard and the DNS checklist | `outbound/domainGuard.ts` |
| Routes | `apps/api/src/routes/outbound.ts` |
| Handler and source | `apps/worker/src/handlers/mail.ts`, `scheduler/mailSources.ts` |
| Tests | `packages/domain/test/outbound/**`, `apps/api/test/outbound.test.ts`, `apps/worker/test/mailHandlers.test.ts` |

## The eight rules a reader should carry

### 1. One fence per origin, and `prepare` reuses rather than duplicates

12.5: "A check requires exactly one origin ... partial unique indexes enforce one fence
per origin." `outbound_messages_exactly_one_origin` is `num_nonnulls(step_execution_id,
draft_id) = 1`, and the two partial uniques are what make a retry safe: Appendix B's
first failure row is "Before fence creation | Retry; uniqueness creates or reuses one
fence", and `prepareOutboundMessage` returns `{ created: false }` for the reuse.

### 2. The token is the authorization, and it is single use

`claimForDispatch` is one `UPDATE ... WHERE state = 'prepared'`. One caller wins. The
token it generates is returned only to the winner and the trigger refuses to overwrite
it. `recordSent` demands it. That is Appendix B's "a replacement worker may reconcile
but never send a dispatching fence again", expressed as a value rather than a rule
somebody has to remember.

### 3. `indeterminate` is not a failure

`GmailClient.sendMessage` distinguishes three outcomes, and the middle one is the
reason the type is not a boolean:

* `ok` — Gmail answered with an id;
* `refused` — Gmail answered, and answered no, so provably nothing was sent;
* `indeterminate` — a timeout, a dropped connection, a 5xx, an unparseable body.

Anything indeterminate goes to `reconciling` and is **never** retried. A client
implementation that reported a timeout as `refused` would defeat the entire fence,
which is why the distinction is documented on the type.

### 4. The Sent folder is the only authority on a send

`searchSentByMessageId` runs `rfc822msgid:` against the sending mailbox, for the
deterministic Message-ID FSS wrote *before* it sent (`<fss.{fenceId}@{domain}>`). A
miss is not an answer — Gmail's Sent index lags — so the observation repeats with
backoff for 24 hours. A hit back-dates `sent_at` to `dispatch_started_at`, because 12.5
computes the successor's delay "from the original dispatch time".

### 5. `unknown_terminal` is terminal, whichever the admin chooses

When the window expires the fence is `unknown_terminal` and there is no transition out
of it. An admin marks it `delivered` or `skipped`; neither changes the state, because
both mean the same thing about Gmail. 12.5: "Neither choice ever releases the same step
for resend." What the choice decides is what the *sequence* does, and that is G8's to
read from `readOutboundOutcome`.

### 6. The cap is computed, the counter is conditional, and the day has to be closed

12.7's ramp table is a function of one stored number — healthy sending days — so a
schedule change governs every mailbox the moment it lands. `admin_daily_cap` only
lowers and `raised_daily_cap` only raises, to at most 75, under a database ceiling of
100.

That number only grows if somebody closes the day, and until lane G15 nobody did.
`closeSendDay`, `listDaysToClose`, `recordDaySignal` and `countDirectSend` were built
and tested here with no caller anywhere, so `healthy_sending_days` was zero for every
mailbox that had ever existed, the cap was five a day for ever, and the three counters
`rampHealthFailure` judges a day on were always zero. This rule used to read as though
the ramp advanced by itself; it does not, and the thing that advances it is
`outbound.close_send_day`, materialized by `sendDayCloseSource` once the workspace's own
business date has moved past an open day. The signals are recorded where they are
learned: a bounce and an opt-out in `mail/effects.ts`, a confirmed opt-out in
`classification/confirmations.ts`, a provider error in `outbound/send.ts`, and every
imported outgoing message that has no fence in `mail/pipeline.ts`. See
`docs/decisions/g15-the-worker-drains-what-the-lanes-left.md`.

The thresholds `rampHealthFailure` uses — `RAMP_MAX_BOUNCE_RATE = 0.05`,
`RAMP_MAX_OPT_OUT_RATE = 0.1`, `RAMP_RATE_FLOOR = 20`, `RAMP_SMALL_DAY_TOLERANCE = 1` —
are numbers the specification does not give. David confirmed them unchanged on
21 September 2026; they are his values, not a lane's invention, and changing them is his
decision to make.

The day's counter is taken by `UPDATE ... WHERE automated_sent < cap`, in one
statement. Read-compare-write would let two workers each read four, each decide four is
under five, and each send — which is Appendix G 33 failing in the one way that matters.

It is taken **before** the claim, deliberately: a process that dies between them has
over-counted by one, and a mailbox that sends four instead of five is recoverable. The
reverse order loses the count, and a cap that can be lost is not a cap.

### 7. The domain guard counts the domain, not the mailbox

12.6's 4,000 personal-Gmail recipients per rolling 24 hours lives on `sending_domains`
and is counted across every mailbox plus every direct send the sync imported. Connecting
a second mailbox adds to the same total — the count query takes no mailbox at all,
which is the structural form of "it cannot be bypassed with extra mailboxes".

It is rolling rather than daily (a midnight reset would permit 8,000 in two hours), it
counts messages rather than distinct recipients (deliberately conservative), and it
applies only to recipients on `gmail.com` or `googlemail.com` — a Workspace mailbox on
a customer's own domain is not covered by Google's rule, and holding it would be an
outage on traffic nobody objected to.

### 8. The application never queries DNS

12.7 gates automated sending on SPF, DKIM and DMARC. Those are three booleans on
`sending_domains`, set by an admin through `/outbound/authentication`, with who and
when recorded — because a resolver answer is a snapshot of a cache, and a gate that
opened because a cached TXT record looked right is worse than a person who looked and
said so. `sending_domains_enable_requires_authentication` makes the gate a constraint
rather than a check somebody remembers.

## What the gate refuses, and in what order

Ordered by *consequence*, not by cost. A suppressed recipient who is also over the
daily cap is reported as suppressed, because that is the fact somebody needs to see.

1. mailbox unknown or not connected;
2. **firm or handle suppressed** (9.2);
3. the frozen route invalidated or retired since preparation (12.3's bounce handling);
4. any open hold blocking `email_send` for this owner or firm (4.2, 12.6);
5. coverage unproved;
6. the sending domain unknown, unauthenticated, or sending disabled (12.7);
7. outside the firm-local window, re-derived rather than trusted (11.2);
8. the mailbox's daily cap (12.7);
9. the domain guard (12.6).

Each refusal sets the fence `held` — which by definition means nothing was attempted —
and opens the matching `active_holds` row. A later attempt releases the fence's own
stale holds first, because the gate is about to re-decide every one of those questions
from the database.

## The contract with G8

G8 renders the bytes (a missing required variable holds the step, which is a sequence
decision) and calls three functions:

```ts
prepareOutboundMessage(context, request) // idempotent on stepExecutionId
dispatchOutboundMessage(context, deps, { outboundMessageId })
readOutboundOutcome(context, stepExecutionId) // absent | prepared | held | dispatching | reconciling | sent | unknown_terminal
```

`outbound_messages` carries `enrollment_id` and `step_execution_id` as nullable uuids
with no foreign key, because `enrollments` and `step_executions` do not exist yet. G8's
migration 0012 adds both constraints.

Nothing in `packages/domain/outbound` imports anything of G8's.

## The decisions behind it

* `docs/decisions/g7-held-returns-to-prepared.md` — why the machine has one reverse
  edge, and why no other one would be safe.
* `docs/decisions/g7-count-before-claim.md` — why the cap is counted before the fence
  is claimed, and what each ordering loses.
* `docs/decisions/g7-domain-guard-scope.md` — why the guard counts the domain and
  holds the firm, including the over-broad hold the scenario test caught.
* `docs/decisions/g7-no-dns-lookup.md` — why 12.7's authentication gate is a person's
  checklist and this application never resolves a TXT record.

## What is deliberately not here

* **Sequences.** "Delivered continues the sequence with the next delay calculated from
  the original dispatch time" is G8 acting on `readOutboundOutcome`; what this lane
  records is the resolution and the original dispatch instant.
* **Live credentials.** `mailHandlers(undefined)` in this release, so `mail.reconcile`
  waits in the queue with the other three mail kinds.
* **A guard-change command.** 12.6 calls it "a reviewed product-policy change", so the
  value is a column an operator changes with a record of the review, not a button.

## Running the tests

```
npm --workspace @fss/domain run test -- test/outbound
npm --workspace @fss/api run test -- test/outbound.test.ts
npm --workspace @fss/worker run test -- test/mailHandlers.test.ts
```

Nothing opens a socket. The scenario suite injects the clock rather than reading the
wall clock, because a suite that skipped itself at the weekend would be a suite that
silently stopped testing its own subject.
