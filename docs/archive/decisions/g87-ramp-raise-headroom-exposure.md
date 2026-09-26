# g87: a raise is earned, the account has headroom, and the guard counts exposure

**Date:** 25 September 2026 · **Lane:** g87 send-path safety, part 2 · **Spec:** 12.6,
12.7, Appendix G 33 · **Audit:** `GPT6-ASTRA-EXHAUSTIVE-20260925.md` S06, S07, S08

Builds on `g77-dispatch-rechecks-under-the-lock.md`: the gate still runs twice, and its
second run is inside the claiming transaction under the send gate. Nothing here changes
`send.ts`, `sendGate.ts` or `stepPermission.ts`.

## What was wrong

* **S06 (P0).** `setAdminCap` accepted `raiseTo: 75` for any mailbox, and
  `effectiveDailyCap` let the stored raise *replace* the schedule. A mailbox connected
  this morning could send 75 automated messages today. 12.7 allows the raise only
  "after sustained healthy results".
* **S07 (P1).** `countDirectSend` counted a salesperson's own messages in
  `mailbox_send_days.direct_sent`, and nothing read the column. The gate checked the
  automated cap and the domain guard. It had no ceiling for the account as a whole, and
  no reserve for the direct sends the sync has not imported yet.
* **S08 (P1).** The domain guard counted `sent` fences only, so a fence in doubt left
  the count the moment Gmail went quiet. It counted a direct message once, however many
  personal-Gmail recipients it named.

## Decision

### S06: the raise's health rule

A raise is earned when both of these hold (`raiseRefusal` in `outbound/ramp.ts`):

1. **The schedule is finished.** The mailbox has `RAMP_SETTLED_DAY` healthy sending
   days, which is 30, the end of the table's last rung: "After six healthy weeks". If
   not, the refusal is `ramp_not_settled`.
2. **The results are sustained.** The mailbox's last `RAMP_RAISE_HEALTHY_STREAK` closed
   sending days were all healthy. That is 10 days. If not, the refusal is
   `health_not_sustained`.

It is enforced in two places:

* **When the raise is recorded.** `setAdminCap` refuses any non-null `raiseTo` that
  fails the rule. `POST /outbound/cap` returns the code as its 409 `reason`, the same
  way it returns `raise_above_limit`. Lowering and clearing a raise are never refused
  for health, because both only shrink the cap.
* **Before every send.** The gate calls `dailyCapInForce`, which reads the streak when
  the ramp carries a raise. `effectiveDailyCap` bounds the raise by `raiseAllowance`:
  75 when the rule holds, and the schedule's own cap for the day when it does not.

A stored raise is a past decision, but health is a present fact. Checking only when the
raise is recorded would leave three holes:

* a raise recorded before this rule existed;
* a late bounce that takes back the thirtieth day (lane G22);
* a bad fortnight after an honest raise.

With the check at every send, none of these can put a mailbox above what the schedule
allows it that day. That is the brief's "never above the schedule's allowance for that
day". `POST /outbound/status` reports the cap in force, computed the same way.

**Why ten.** The specification gives no number. Ten sending days is the longest step
the table takes ("Weeks 5–6", ten sending days at one cap), so a raise asks for as long
a clean run as any rung does. It is a named constant, and changing it is David's
decision, like `RAMP_MAX_BOUNCE_RATE`.

**What counts as a sending day.** A closed day with at least one automated send. A day
with none is `no_sends` for the ramp, which "neither advances the ramp nor counts
against it", so it neither breaks nor extends a run. An open day has no verdict yet.

**Absent is not null.** `setAdminCap` used to read an absent `lowerTo` or `raiseTo` as
null, which clears the column. The route passes absent through as absent, and the
desktop's bridge sends only the field a person changed. Both are written on the
understanding that absent leaves the column alone. So before g87, lowering a raised
mailbox during an incident also cleared its raise. The function now keeps an absent
column as it was, under a row lock. This lives in the function the brief owns, and it
changes nothing for a caller that sends both fields.

### S07: the account headroom and its reserve

The rule: **an automated send is refused when the mailbox's `automated_sent +
direct_sent`, summed over the claim's business date and the one before it, has already
reached `ACCOUNT_OPERATIONAL_CEILING`.** The refusal is `daily_cap`, and the detail is
`account used/ceiling`.

* `GMAIL_ACCOUNT_DAILY_LIMIT = 2000`. This is Google Workspace's published per-user
  sending limit, counted over any rolling 24 hours. Every mailbox FSS connects is a
  Workspace mailbox, because the Gmail grant checks the hosted domain.
* `ACCOUNT_HEADROOM_RESERVE = 500`, a quarter of Google's limit.
* `ACCOUNT_OPERATIONAL_CEILING = 1500`.

**Why two dates.** The brief asked for a ceiling per business date. The counters are
per business date, but Google's window rolls. At 09:00, yesterday afternoon is still
inside Google's 24 hours. A ceiling on today's row alone would let an account that sent
1,900 messages by hand last evening take FSS's whole cap this morning. Any 24 hours
ending now lies inside today's business date and yesterday's, so summing the two can
only overstate what Google counts, which is the conservative direction. The cost is
that a heavy day is still counted until the end of the next business day, not just for
24 hours. That matters only for an account that sent more than a thousand messages in a
day.

**Why 500.** The reserve covers what the counters cannot yet see:

* **Direct sends the sync has not imported.** The gate refuses automated sending once
  the coverage watermark is older than `COVERAGE_FRESHNESS_SECONDS` (15 minutes). So
  the unseen part is at most a quarter of an hour of a person's own sending, plus the
  import itself. Five hundred messages is more than one mailbox sends in that time,
  mail merges included.
* **The spring-forward hour.** On the night the clocks go forward, a 24-hour window can
  reach one hour into a third business date.

**Why `daily_cap` and no new code.** The specification names no code for this. The fact
is the same kind as the cap: this mailbox has sent enough for now, and time lifts it. It
opens the same recoverable `daily_cap` hold and wakes on the same schedule. The detail
tells the two ceilings apart. The automated cap now reads `automated n/cap` (it was a
bare `n/cap`, and nothing parsed it), and the headroom reads `account used/ceiling`.

**How it is enforced.** The check runs in `decideSend`, after the automated cap and
before the domain guard, in the precheck and again in the claiming transaction. Inside
the claim, `openSendDay`'s upsert has locked today's row, so two claims on one mailbox
read it in turn. Yesterday's row has one writer after the fact: the pipeline counting a
late-imported direct send. That writer takes the send gate exclusive, so it cannot
commit while a claim holds the gate shared.

**What it does not model:**

* **Google's recipient limits.** Workspace also limits recipients per day, and the
  counters count messages. An automated message has one recipient. A person's own
  message may have many, and FSS cannot see its Bcc.
* **Trial Workspace accounts.** Their limit is 500 a day. The constant assumes a paid
  account.
* **A person's own sending past the ceiling.** FSS observes that and cannot stop it. The
  rule stops FSS adding to it.

### S08: recipient exposure

`personalGmailRecipientsInWindow` keeps its `{ automated, direct, total }` shape, which
the desktop parses through `@fss/contracts` (PR 209 and 217). What the numbers count
changes:

* **`automated`** is every fence to a personal-Gmail address whose dispatch began in the
  window, in any state after the claim: `dispatching`, `reconciling`, `sent` and
  `unknown_terminal`. A send in doubt is reserved exactly as a sent one is. Its instant
  is `greatest(dispatch_started_at, sent_at)`, the later of the two, so it stays in the
  window at least as long as either says.
* **`direct`** is the number of distinct personal-Gmail addresses on the `To` and `Cc`
  of each imported outgoing message, summed over the messages. Across messages, two
  messages to one address still count twice, as before.
* **No double count.** An imported message is left out of `direct` exactly when a
  *claimed* fence in the same mailbox has its Gmail id or its deterministic
  `Message-ID`. That is the pair `fenceForOutgoingMessage` matches on. Before g87 the
  match was by Gmail id only, so FSS's own copy imported while its fence was
  reconciling, which has no Gmail id yet, would have been counted as a direct send.

The in-doubt count is inside `automated`, not in a new field. The desktop's unit fixture
is held key for key to the route's answer by `test/release/sendingSection.check.ts`.
Adding a field, even an optional one, would need a desktop change, and that is outside
this lane.

**Serialization.** Counting claimed fences helps only if the next decision can see
them. Every claim holds the send gate *shared*, so two claims to personal Gmail from
two mailboxes can run side by side and each count the other as unclaimed. For a
personal-Gmail recipient, the gate now takes `lockDomainGuard` before it counts. This
is a per-workspace transaction advisory lock, keyed
`hashtextextended('fss.domain-guard:' || workspace_id, 0)`. The claim holds it until
commit, so the next claim waits and then counts this one in `dispatching`.

The lock adds no deadlock. Its lock order is: send gate shared, then the fence, the
enrollment, the ramp row and the day row, then this lock. Only claims take it, always
last. Two claims on one mailbox have already queued on the day row. In the autocommit
precheck it lasts one statement. The status route's headroom question does not take it.

**Not counted:** Bcc, which 12.3's header allowlist does not store, and outgoing mail the
sync has not imported yet.

## Tests and mutations

* `packages/domain/test/outbound/sendingCeilings.test.ts`, on a real PostgreSQL:
  * the bypass: a raise stored on a day-zero mailbox still holds at five;
  * the command's two refusals, with a quiet day inside the run;
  * the raise lapsing at the gate when the streak breaks;
  * absent against null;
  * the account ceiling, including yesterday and excluding the day before;
  * a multi-recipient direct message;
  * an in-doubt reservation, and its imported copy counted once;
  * the serialization, with a second connection holding the guard mid-claim.

  Every refusal is followed by the same shape sending once the one fact is put back.
* `packages/domain/test/outbound/rules.test.ts`: the pure rules.
* `apps/api/test/outbound.test.ts`: the refusals through `POST /outbound/cap`.
* Six mutations are appended to `scripts/releaseMutationCheck.mjs`. Each was applied by
  hand and turns its suite red:
  * the raise replacing the schedule again;
  * the command skipping the health rule;
  * the gate ignoring the headroom;
  * only `sent` fences counting;
  * a direct message counting once;
  * the guard lock removed.
