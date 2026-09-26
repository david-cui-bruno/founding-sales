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
| The step's eligibility, asked again for a fence | `outbound/stepPermission.ts` (over `sequences/eligibility.ts`) |
| The send gate every stop fact takes | `policy/sendGate.ts` |
| Proven mailbox coverage | `mail/coverage.ts` |
| The one Gmail call, and the claiming transaction | `outbound/send.ts` |
| Sent-folder reconciliation | `outbound/reconcile.ts` |
| 12.7's ramp and the daily counters | `outbound/ramp.ts` |
| 12.6's guard, the DNS checklist and `registerSendingDomain` | `outbound/domainGuard.ts` |
| Routes | `apps/api/src/routes/outbound.ts` |
| Handler and source | `apps/worker/src/handlers/mail.ts`, `scheduler/mailSources.ts` |
| Tests | `packages/domain/test/outbound/**`, `apps/api/test/outbound.test.ts`, `apps/api/test/sendingDomain.test.ts`, `apps/worker/test/mailHandlers.test.ts`, `apps/worker/test/sequenceActionDispatch.test.ts` |

## The nine rules a reader should carry

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

After a database restore the Sent folder is also the only record of a send whose fence
was lost (Appendix E.3, lane g73). `scanSentFolder` lists the folder from the restore
point minus ten minutes and keeps the messages whose whole Message-ID is FSS's for that
mailbox (`fssFenceIdOfSentMessage`). `@fss/domain/restore`'s `recoverSentFolderMessage`
then inserts a `sent` tombstone (`insertSentTombstone`) on the step a lost fence was the
send of. The tombstone takes the lost fence's own id and Message-ID, so the dedupe key
in `prepareOutboundMessage` sees it and `dispatchOutboundMessage` answers
`already_terminal`. See `docs/archive/decisions/g73-missing-fences-are-recovered-from-sent.md`.

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

**A raise is earned, and it counts only while it stays earned** (lane g87, audit S06).
12.7 says "After sustained healthy results they may raise a mailbox to 75". Until g87
`setAdminCap` accepted `raiseTo: 75` for a mailbox on its first day and
`effectiveDailyCap` let the raise replace the schedule, so the whole ramp was one admin
click deep. The rule now has two parts (`raiseRefusal` in `outbound/ramp.ts`):

* the mailbox has finished the schedule: `RAMP_SETTLED_DAY` (30) healthy sending days,
  12.7's "After six healthy weeks". Otherwise the refusal is `ramp_not_settled`.
* its last `RAMP_RAISE_HEALTHY_STREAK` (10) closed sending days were all healthy, with
  no unhealthy one among them. Otherwise it is `health_not_sustained`. A day with no
  automated send is not a sending day and neither breaks the run nor extends it. A
  closed day that a late bounce condemned does break it.

`POST /outbound/cap` refuses any non-null `raiseTo` that fails either part, and the code
is the command's 409 `reason`. Lowering, and clearing a raise, are never refused for
health, because both only shrink the cap. The gate asks the same question again before
every send (`dailyCapInForce`): a stored raise lifts the day's cap only while the rule
holds, and otherwise the schedule's cap governs that day. So a raise written before
g87, a late bounce that took back the thirtieth day, or a bad fortnight after the raise
can never put a mailbox above what the schedule allows it that day. `POST
/outbound/status` reports that cap in force, not the stored column.

Ten is a number the specification does not give. It is the longest step the table takes
("Weeks 5–6", ten sending days at one cap). Changing it is David's decision, like the
rate thresholds below.

**Absent leaves a cap column alone; null clears it** (lane g87). The route passes an
absent field through as absent, and the desktop sends only the field a person changed.
Until g87 `setAdminCap` read absent as null, so lowering a raised mailbox during an
incident silently cleared the raise too, and raising it cleared the lowering.

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
`docs/archive/decisions/g15-the-worker-drains-what-the-lanes-left.md` and
`docs/archive/decisions/g22-a-late-bounce-belongs-to-its-send.md`.

The thresholds `rampHealthFailure` uses — `RAMP_MAX_BOUNCE_RATE = 0.05`,
`RAMP_MAX_OPT_OUT_RATE = 0.1`, `RAMP_RATE_FLOOR = 20`, `RAMP_SMALL_DAY_TOLERANCE = 1` —
are numbers the specification does not give. David confirmed them unchanged on
21 September 2026; they are his values, not a lane's invention, and changing them is his
decision to make.

**A bounce counts against the send that caused it, whenever it arrives** (lane G22).
`RAMP_MAX_BOUNCE_RATE` is a proportion of one day's automated sends, so a report has to
land on the day the send went out, not on the morning it was read. `originatingSend`
joins the report's `In-Reply-To` and `References` against
`outbound_messages.provider_message_id_header` — 12.3's "Message-ID references against
FSS fences", from the same headers — and takes the *fence's* `mailbox_id` and
`business_date`, so a report forwarded into another connected mailbox still counts
against the mailbox that earned it.

`recordBounceAgainstDay` is what counts it, and it re-judges a day that has already
closed:

* an open day is counted and not judged, because the close is what judges;
* a closed day the new count still acquits keeps its verdict;
* a closed day the new count condemns is flipped to `healthy = false`, its failure is
  written to `mailbox_send_ramp.last_health_failure`, and `healthy_sending_days` gives
  back the day it earned — `greatest(n - 1, 0)`, once, guarded by the flip itself;
* a day already closed unhealthy is counted and nothing is taken, because it never
  advanced the ramp.

Two details are load-bearing. The re-judgement reuses the *stored verdict* for the
three non-counter conditions — authentication, coverage, provider warning — rather than
re-reading them, because `healthy = true` on a closed day is the record that they held
that day, and a hold opened this morning must not condemn a day it had nothing to do
with. And `last_advanced_on` does not move, because it is what stops `closeSendDay`
advancing the same date twice; rewinding it would let a later close re-earn the day
that was just taken back. The direction is conservative in every case: the cap falls,
never rises.

A report that names no fence — a daemon that sets neither header, a bounce of a direct
Gmail send that never had one — still counts on the day it arrived. That is the
behaviour before this lane and the known limit of version one.

The day's counter is taken by `UPDATE ... WHERE automated_sent < cap`, in one
statement. Read-compare-write would let two workers each read four, each decide four is
under five, and each send — which is Appendix G 33 failing in the one way that matters.

It is taken **in the claim's transaction** (lane g77, replacing G7-2's "count before
claim"). The counter moves for the workspace business date of the claim itself, and the
claim writes that date onto the fence, so the two commit together or not at all. A
process that dies before the commit leaves neither, and there is nothing to refund.
`claimedAutomatedSends` derives the counter from the fences. The count for a date is
the number of fences whose dispatch began on it, and the send path cannot make the two
disagree. A fence planned for Monday and held into Tuesday is Tuesday's send.

### 7. The domain guard counts the domain, not the mailbox

12.6's 4,000 personal-Gmail recipients per rolling 24 hours lives on `sending_domains`
and is counted across every mailbox plus every direct send the sync imported. Connecting
a second mailbox adds to the same total — the count query takes no mailbox at all,
which is the structural form of "it cannot be bypassed with extra mailboxes".

It is rolling rather than daily (a midnight reset would permit 8,000 in two hours), and
it applies only to recipients on `gmail.com` or `googlemail.com` — a Workspace mailbox on
a customer's own domain is not covered by Google's rule, and holding it would be an
outage on traffic nobody objected to.

**It counts recipient exposure** (lane g87, audit S08). Before g87 it counted `sent`
fences and one per direct message, so a send in doubt left the count the moment Gmail
went quiet, and a mail merge sent as one message to forty Gmail addresses moved it by
one. `personalGmailRecipientsInWindow` now counts:

* **`automated`:** every FSS fence to a personal-Gmail address whose dispatch began in
  the window, in every state after the claim: `dispatching`, `reconciling`, `sent` and
  `unknown_terminal`. A claimed send may have left, so it is reserved against the guard
  exactly as a sent one is. Its instant is the later of the claim and the proven send.
* **`direct`:** every distinct personal-Gmail address on the `To` and `Cc` of every
  imported outgoing message, counted once per message. `Bcc` is not in 12.3's header
  allowlist, so it is the one recipient this count cannot see.
* A message FSS sent is left out of `direct` exactly when its fence is counted in
  `automated`: a claimed fence in the same mailbox with the message's Gmail id or its
  deterministic `Message-ID`. So the sync importing FSS's own copy is counted once.

Across messages it still over-counts on purpose: two messages to one address count
twice. The answer keeps the `{ automated, direct, total }` shape the desktop parses, and
the in-doubt part is inside `automated`.

**The decision is serialized.** Every dispatch claim holds the send gate *shared*, so
two claims to personal Gmail from two mailboxes used to run side by side, each count the
other's fence as unclaimed, and both take the last place. The gate now takes a
per-workspace transaction advisory lock (`lockDomainGuard`, key `fss.domain-guard:` plus
the workspace id) before it counts a personal-Gmail recipient. The claim holds it until
it commits, so the next claim counts this one in `dispatching`. It is taken after every
row lock the claim already holds and by nothing but a claim, so it adds no lock-order
cycle.

### 8. Every outgoing message spends the account's headroom

12.7: "All outgoing Gmail messages, including direct sends, count toward operational
headroom. Automated capacity is conservatively reserved so sync lag cannot approach
Google's account ceiling." Until lane g87 (audit S07) FSS counted direct sends in
`mailbox_send_days.direct_sent` and nothing read them.

The rule: **an automated send is refused as `daily_cap`, with detail `account
used/ceiling`, when the mailbox's `automated_sent + direct_sent` on the claim's business
date and the one before it already reach `ACCOUNT_OPERATIONAL_CEILING` (1,500).** That
is Google Workspace's per-user limit of 2,000 messages in any rolling 24 hours
(`GMAIL_ACCOUNT_DAILY_LIMIT`), less a reserve of 500 (`ACCOUNT_HEADROOM_RESERVE`).

* **Two dates, because Google's window rolls.** At nine in the morning, yesterday
  afternoon's sends are still inside Google's 24 hours. Any 24 hours ending now lies
  inside today's business date and yesterday's, so their sum can only overstate what
  Google counts.
* **The reserve is for what the counters cannot see yet.** That means direct sends the
  sync has not imported. The gate refuses automated sending once coverage is older than
  fifteen minutes, so the unseen part is at most a quarter of an hour of a person's own
  sending. It also absorbs the extra hour a spring-forward night adds to Google's window.
* **It is its own ceiling.** The automated cap still applies first, and it can never
  reach 1,500 on its own (the hard ceiling is 100). So this refusal only fires on an
  account a person is already sending a great deal from by hand. The detail says which
  ceiling: `automated n/cap` for the cap, `account used/ceiling` for this.
* **It is enforced in the claim.** The gate's `openSendDay` upsert locks today's row
  inside the claiming transaction, so two claims on one mailbox read it one after the
  other. Yesterday's row changes only when the pipeline counts a late direct send, which
  takes the send gate exclusive first.

What it does not model is in `docs/archive/decisions/g87-ramp-raise-headroom-exposure.md`:
Google's separate recipient limits, trial Workspace accounts (500 a day), and a
salesperson's own sending beyond the ceiling, which FSS observes and cannot stop.

### 9. The application never queries DNS

12.7 gates automated sending on SPF, DKIM and DMARC. Those are three booleans on
`sending_domains`, set by an admin through `/outbound/authentication`, with who and
when recorded — because a resolver answer is a snapshot of a cache, and a gate that
opened because a cached TXT record looked right is worse than a person who looked and
said so. `sending_domains_enable_requires_authentication` makes the gate a constraint
rather than a check somebody remembers.

## The dispatch sequence (lane g77)

`dispatchOutboundMessage` runs in this order, and the order is the safety property.

1. **Read the fence.** A `held` fence is released back to `prepared`, together with the
   holds its last attempt opened, because every question is about to be decided again.
2. **Precheck.** `decideSend`, outside any transaction, refuses early what can be refused
   without Google.
3. **OAuth.** The refresh token is exchanged for an access token *before* the claiming
   transaction opens, so no lock is ever held across a network call. A revoked grant
   holds the fence with nothing counted.
4. **Recheck and claim, in one transaction.**
   * Take the **send gate** shared.
   * Lock the fence and its enrollment `FOR UPDATE`.
   * Run `decideSend` again. This time the dispatch uses the fence the lock returned and
     the database clock (`clock_timestamp()`).
   * Reserve the day's capacity.
   * Claim.
   * `COMMIT`.

   A refusal holds the fence inside the transaction, and its `active_holds` row is
   opened after the commit.
5. **Send.** The bytes are the claimed row's. A `prepared` envelope can still be
   re-rendered until the token exists.
6. **Record.** `sent` under the token, or `reconciling` and the Sent-folder search.

The recheck is not a second copy of anything:

* **The step's whole permission.** `decideStepPermission` asks `composeEligibility()`,
  the function the sequence engine used to prepare the fence. That covers suppression,
  control mode, the enrollment, every applicable hold (including the owner's mailbox
  scope and the email channel), assignment, the frozen route and its version, proven
  coverage, and the frozen template's approval. It also requires the fence and its
  enrollment to name the same firm, opportunity and owner. A reply's hold, a pause,
  manual mode, a stopped enrollment or a reassignment refuses as `step_ineligible`, with
  the section 15 code as the detail, and opens no second hold.
* **Coverage freshness.** Coverage is proven when the mailbox is `ready` and
  `coverage_watermark_at` is no older than `COVERAGE_FRESHNESS_SECONDS` (15 minutes) on
  the database clock. The watermark is the last *successful* sync. `last_synced_at` is
  the last *attempt*, which a rate-limited failure also writes, and the send path never
  reads it. See `mail/coverage.ts` for the constant's reasoning.
* **The window.** `placeEmailSend` is asked about the decision instant, holidays
  included. The calendar is the union of the one the enrollment froze and the current
  one.
* **The cap.** The cap counts on the workspace business date of the decision, which
  inside the transaction is the claim's.

**The send gate** is a per-workspace transaction advisory lock (`policy/sendGate.ts`).
The claim holds it shared. Every writer of a restrictive stop fact takes it exclusive
before it commits:

* every hold (`openHold`, `reassignFirm`, `commitDeparture`);
* every restrictive suppression event (`recordSuppression`, the journal replay, a
  merge);
* manual mode;
* a stage change;
* `stopEnrollments`.

So a stop that committed first is read by the recheck, and a stop that arrives during a
claim waits for the claim's commit. That is the linearization Appendix G 3 asks for. The
gate comes before any row lock on both sides. `applyClassificationEffects` and the
direct-send counter take it first thing for that reason.

This section supersedes items 3 to 5 of *What the gate refuses* below: those are now one
step, the complete eligibility. Items 7 and 8 now use the holiday-aware window and the
claim's business date. `docs/archive/decisions/g77-dispatch-rechecks-under-the-lock.md` has the
reasoning and what it deliberately leaves out.

## How a sending domain comes to exist

Every checklist command is an `UPDATE`, so it needs a `sending_domains` row to update.
Until lane g57 nothing outside the tests and the rehearsal's drill-evidence seed wrote
one. Production on 24 September 2026 showed the result: `callie@usecallie.com` was
connected and SPF, DKIM, DMARC and Postmaster Tools all passed, but Administration read
**"No sending domain is configured."** and showed no checkboxes. The desktop renders the
checklist only when `/outbound/status` returns a domain, and
`recordAuthenticationChecklist` answers `domain_unknown` when the row is missing.

A correction from lane g69 (release.md 8.0ae): no desktop build before 1.0.4 could render
that section at all. The desktop parsed `personalGmailRecipients` as a number, and the
route sends an object. So whatever Administration showed that day, it was not this
section's line, and the checkboxes would have been missing even with the row in place.
The missing row was real, and it is what g57 fixed. The section itself needs 1.0.4.

`registerSendingDomain(context, { domain, registeredBy })` (`outbound/domainGuard.ts`)
is now the only thing that creates the row. It has three callers:

| Caller | `registeredBy` | When |
|---|---|---|
| The Gmail callback (`apps/api/src/routes/gmail.ts`), after `completeGmailGrant` returns | `mailbox_connect` | Every mailbox connect. This is the zero-step path: the connected address's domain becomes the sending domain. |
| `fss admin workspace bootstrap --sending-domain <domain>`, through `release-bootstrap-workspace.sh` (release.md 5.1a) | `operator` | A workspace whose mailbox connected before g57. Idempotent, so 5.1a can pass the flag on every re-run. |
| `POST /outbound/domain` (admin only, `{ domain }`, command receipt `register_sending_domain`) | `admin` | For a future desktop "Add sending domain" control. No desktop build calls it yet. |

It follows four rules, and each has a test:

* **An existing row is returned unchanged.** The insert is `ON CONFLICT DO NOTHING`,
  and the answer is `existing`. A reconnect or a 5.1a re-run never resets the checklist
  or the enable.
* **A new row is primary only if the workspace has none.** Otherwise it is registered
  beside the primary. A registration never changes which domain the 12.6 guard counts
  against. When two first registrations race, the loser waits on
  `sending_domains_one_primary`, inserts nothing, and on its next pass is registered as
  non-primary.
* **Personal Gmail is refused** (`personal_gmail_domain`). 12.6 treats `gmail.com` and
  `googlemail.com` as a recipient class, not as a domain anyone at Callie can vouch for.
  An `@`, a scheme, a path or an IP address is `domain_invalid`, which is checked against
  the same pattern as the table's `sending_domains_domain_shape`.
* **A new row starts with the checklist unticked and sending off.** Sending opens only
  after an admin records the checklist. Every insert writes a
  `sending_domain.registered` audit event naming the domain, whether it is primary, and
  `registeredBy`.

A failure on the connect path never fails the connect. The mailbox, its token and its
coverage hold are already written when registration runs. A registration that throws
logs a `warn` line (`sending_domain_registration_failed`) and the consent page still
says "Gmail connected". A refused registration logs an `info` line
(`sending_domain_not_registered`, with the reason). A created one logs
`sending_domain_registered`.

**A mailbox connected before g57 is not registered retroactively.** The callback runs
only when a mailbox connects, and nothing scans existing mailboxes. That is why the
bootstrap flag exists.

## What the gate refuses, and in what order

Ordered by *consequence*, not by cost. A suppressed recipient who is also over the
daily cap is reported as suppressed, because that is the fact somebody needs to see.

1. mailbox unknown or not connected;
2. **firm or handle suppressed** (9.2);
3. the frozen route invalidated or retired since preparation (12.3's bounce handling);
4. any open hold blocking `email_send` for this owner or firm (4.2, 12.6);
5. coverage unproved;
6. **the release gate** (16.2), refused as `workspace_sending_not_attested`. The deployment flag and the admin's `sending_enabled` attestation must both say yes. Since lane g71 the release record the attestation names must also be stored, have passed, and carry *this worker's own* image digest. The `detail` says which part said no: `deployment`, `workspace`, `release_record_unknown`, `release_record_not_passing`, `release_record_identity_unknown` or `release_record_digest_mismatch`. It never names the reference. See `docs/archive/decisions/g71-sending-gate-is-bound-to-the-release-record.md`;
7. the sending domain unknown, unauthenticated, or sending disabled (12.7);
8. outside the firm-local window, re-derived rather than trusted (11.2);
9. the mailbox's daily cap (12.7): the cap in force, with a stored raise judged on
   today's health (lane g87), detail `automated n/cap`;
10. the account headroom (12.7, lane g87): automated and direct sends on today's and
    yesterday's business date against 1,500, refused as `daily_cap` with detail
    `account used/ceiling`;
11. the domain guard (12.6), serialized for a personal-Gmail recipient and counting
    recipient exposure (lane g87).

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

* `docs/archive/decisions/g7-held-returns-to-prepared.md` — why the machine has one reverse
  edge, and why no other one would be safe.
* `docs/archive/decisions/g7-count-before-claim.md` — why the cap was counted before the fence
  was claimed; superseded by g77.
* `docs/archive/decisions/g77-dispatch-rechecks-under-the-lock.md` — OAuth first, then the
  recheck, the reservation and the claim in one transaction under the send gate;
  coverage freshness; the claim's business date; holidays at dispatch.
* `docs/archive/decisions/g7-domain-guard-scope.md` — why the guard counts the domain and
  holds the firm, including the over-broad hold the scenario test caught.
* `docs/archive/decisions/g87-ramp-raise-headroom-exposure.md` — the raise's health rule, the
  account headroom and its reserve, and recipient exposure with in-doubt reservation.
* `docs/archive/decisions/g7-no-dns-lookup.md` — why 12.7's authentication gate is a person's
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
npm --workspace @fss/domain run test -- test/outbound/sendingCeilings.test.ts
npm --workspace @fss/api run test -- test/outbound.test.ts test/sendingDomain.test.ts
npm --workspace @fss/worker run test -- test/mailHandlers.test.ts test/sequenceActionDispatch.test.ts
```

Nothing opens a socket. The scenario suite injects the clock rather than reading the
wall clock, because a suite that skipped itself at the weekend would be a suite that
silently stopped testing its own subject.
