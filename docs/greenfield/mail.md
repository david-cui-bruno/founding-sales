# Mail: the Gmail grant, the sync, the match and the effects

Specification revision 3, invariant 6, sections 12.1 to 12.4 and 12.6, 10.3, 13.1 to
13.3, and Appendices B, C, F and G 4, 6, 8, 10, 13, 14, 15, 19, 27. This is how a
salesperson's mail becomes something FSS knows about, and — as importantly — how much
of it FSS deliberately never reads.

## The short version

A salesperson connects their Gmail with two scopes: `gmail.readonly` and `gmail.send`.
The control is on the Mac, from desktop 1.0.1: the **Mailbox** row on the main window's
"This Mac" card has a **Connect Gmail** button (`apps/desktop/src/main/mailboxBridge.ts`)
that opens Google's consent screen in the system browser and then shows the address, its
status and the baseline state, with no Disconnect because of the thirty-day rule below.
The callback also registers the connected address's domain as the workspace's sending
domain if it is not registered yet. That registration never changes an existing row
and never fails the connect (`docs/greenfield/sending.md`, "How a sending domain comes
to exist"). FSS registers a Pub/Sub **watch**, and each notification enqueues a coalescing
`mail.sync` for that one mailbox. A sync reads Gmail's history from a stored cursor,
fetches **metadata only** for each new message, tries to match it to an opportunity,
and fetches a **body only if it matched**. A matched message is classified by
deterministic rules, and the classification's effects — a hold, a suppression, a
today-list item, an invalidated route — are applied in the same transaction as the
message.

Everything that can go wrong with that has a defined recovery: an expired cursor starts
a bounded full re-read, a revoked grant holds every automated step for that owner, and
a mailbox whose coverage is unproved holds them too.

## Where everything is

| What | Where |
|---|---|
| Migration | `packages/domain/db/migrations/0009_mail.sql` — eleven tables |
| Domain | `packages/domain/mail/**` |
| Gmail seam | `mail/gmailClient.ts` (interface), `gmailClientFake.ts` (recorded), `gmailClientHttp.ts` (the one that speaks HTTP) |
| Envelope seam | `mail/envelope.ts`, `mail/envelopeKms.ts` — see `docs/archive/decisions/g7-kms-adapter.md` |
| Push token seam | `mail/pushToken.ts` — signature keyed, claims pure |
| Secret seam | `mail/secretProvider.ts` |
| Routes | `apps/api/src/routes/gmail.ts`, `pubsub.ts`, `messages.ts` |
| Handlers | `apps/worker/src/handlers/mail.ts` |
| Scheduler sources | `apps/worker/src/scheduler/mailSources.ts` |
| Tests | `packages/domain/test/mail/**`, `apps/api/test/mail.test.ts`, `apps/worker/test/mailHandlers.test.ts` |

## The six rules a reader should carry

### 1. A body is never fetched speculatively

12.3 permits a body fetch "after a plausible FSS match". `pipeline.ts` enforces it as
an ordering: metadata, then match, then — only if a match was recorded — body. The
`getMetadata` call passes the twelve-header allowlist and the HTTP client turns it into
`format=metadata` with one `metadataHeaders` parameter per header, so Gmail itself will
not return a body. An unmatched message costs one metadata read, and a mailbox full of
mail that has nothing to do with FSS costs nothing else.

`storeMessageBody` throws if the message is not matched. It is not a convention.

Attachments are references only — filename, media type, size, Gmail's attachment id.
10.3: "Attachments are not copied into FSS."

### 2. The cursor moves by compare-and-set, and the watermark moves with it

`advanceCursor` updates `history_id` only where it is still the value the caller read
(`IS NOT DISTINCT FROM`) on the generation and address the caller read (a different
generation throws `StaleMailboxGeneration`; see the four rules below), and writes
`coverage_watermark_at` in the **same statement**.
Two overlapping syncs cannot write each other's progress; the loser is told
`cursor_moved` and stops, which is right, because the winner has already read at least
as much.

The watermark is a claim: "every relevant message up to here is known processed."
Because it is written with the cursor, there is no instant at which the database claims
coverage it has not read. `mailboxes_coverage_needs_cursor` makes a watermark without a
cursor unrepresentable.

### 3. Coverage is a hold, and the hold is on the owner

12.6: "While a mailbox grant is revoked or coverage unhealthy, every automated step
kind for that owner is held." So the hold is owner-scoped, not mailbox-scoped, and it
blocks `email_send`, `call_task` and `enrollment_advance`.

`releaseMailboxHold` re-reads the row and refuses to release a `coverage_incomplete`
hold unless `sync_state = 'ready'`. A caller cannot talk the database out of a hold it
has not earned.

`ready` alone is not proof, though (lane g77). A mailbox stays `ready` through any
number of rate-limited history reads, and `recordSyncError` moves `last_synced_at` —
the last *attempt* — as each one fails. What the send path and the sequence engine ask
is `mail/coverage.ts`: connected, `ready`, and `coverage_watermark_at` — the last
*success* — no older than `COVERAGE_FRESHNESS_SECONDS` on the database clock. A mailbox
that has not proved its coverage in that window holds automated email as
`coverage_incomplete`, exactly as one that never proved it does.

A newly connected mailbox is `baseline_pending` with a `coverage_incomplete` hold from
the moment the grant completes. It becomes `ready` only when the bounded baseline has
processed its whole interval.

### 4. The classifier's model layer is forbidden to decide

`mail_message_classifications` is unique per `(message, layer)`, and

```sql
CONSTRAINT mail_message_classifications_model_cannot_decide
  CHECK (layer <> 'model' OR class = 'uncertain')
```

G7-1 writes only `layer = 'deterministic'`. G7b adds the LLM layer behind a clearly
named seam, and the database is what guarantees the seam stays a *second opinion*: a
model row that is not `uncertain` cannot be inserted. An LLM cannot decide that
somebody opted out.

### 5. Effects are unique per target, and opt-out goes through G4

`mail_message_effects` is unique on `(workspace, message, effect_kind, target_key)`,
and UPDATE and TRUNCATE are revoked on it. Applying a message's effects twice applies
them once. That is what lets `applyDirectSendEffects` implement Appendix G 19 —
"switch this firm to manual because the salesperson sent from Gmail directly" —
exactly once, without a flag anywhere.

An opt-out never writes a suppression row itself. It calls G4's `recordSuppression`,
which writes the object-locked journal before the row (10.2). The handle is always
suppressed; the firm is suppressed only when exactly one candidate matched.

Two of the effects feed 12.7's ramp, and they count on different days. An opt-out is a
fact about the moment a person asked, so it counts on the day the message arrived. A
**bounce is a fact about the send that caused it** (lane G22): `countRampSignal` asks
`originatingSend` for the fence the report's `In-Reply-To` and `References` name, and
counts against that fence's mailbox and business date — re-judging a day that has
already closed, which can take the ramp back. A report that names no fence still counts
where it landed. `docs/greenfield/sending.md` rule 6 has the arithmetic, and
`docs/archive/decisions/g22-a-late-bounce-belongs-to-its-send.md` the reasoning.

Since send-path v2 (30 September 2026) `applyDirectSendEffects` does not switch the firm
to manual: a direct Gmail send is an update to the conversation. Under the send gate it
ends the firm's live prospecting enrollments `direct_send` and spends the one-message
follow-up permissions of its verified To/Cc recipients (`fulfilled_by_direct_send`),
ending their runs `direct_send`; an agreed sequence keeps running
(`docs/greenfield/decisions/follow-up-eligibility-20260929.md` §5).

### 6. There is no visible opt-out link, anywhere — and no mandatory stop line

David, 29 September 2026:

> The presentation decisions are now settled: remove the mandatory 'Reply "stop"'
> footer and remove the blanket database ban on the word 'unsubscribe.' Inspect the
> constraints and their callers before migrating them. Keep the
> no-visible-opt-out-link rule, automatic handling of stop requests in ordinary
> language, and eligibility/suppression checks.

So there are two rules here now where there used to be three, and the one that is left
is about a **link**, not a word. Migration 0024 states it once, as a function both
CHECKs call:

```sql
CONSTRAINT template_versions_no_optout_link
  CHECK (NOT email_has_optout_link(body) AND NOT email_has_optout_link(subject))
```

A visible opt-out link is **a URL or `mailto:` on the same line as, or on the line
immediately before or after, an opt-out phrase** — the phrases being `unsubscribe`,
`opt out` / `opt-out` / `optout`, `remove me`, `stop receiving`, `stop these
emails|messages`, `no longer receive`, `list-manage`, `manage (your) preferences`.
Bodies are plain text and a subject is one line, so that is what "a link and its label"
can mean here: a label above its link, a link above its label, or both in one sentence.
Before matching, the text is normalised — NFKC, then every named dash to `-`, then every
named space to ` `, then case-folded — so `Opt‑out: https://…` with a non-breaking
hyphen is refused like the ordinary spelling.

`outbound_messages_no_optout_link` restates it on the bytes that actually leave, and
`OPT_OUT_LINK_PATTERN` / `hasOptOutLink` in `packages/contracts/src/templates.ts` is the
same rule in TypeScript, so the Mac's refusal, the save's refusal and the two CHECKs
cannot drift apart. One table of examples
(`packages/domain/test/db/support/optOutLinkCases.ts`) is run against the SQL function
and the TypeScript one in the same assertion.

**Three things this rule cannot do, named rather than implied:**

* a **bare shortener** — `https://short.example/a` with no phrase near it — passes, because
  the stored bytes cannot say where it redirects;
* NFKC folds a non-breaking hyphen and a full-width space, but **not a Cyrillic `О` into
  a Latin `O`**;
* and it refuses some innocent copy: *"You can opt out by replying. Our website is
  https://firm.example"* **is** refused, although the website has nothing to do with
  opting out. That is the price of a rule a CHECK can enforce. The fix for a false
  refusal is a **blank line** between the unrelated link and the opt-out phrase — a line
  that merely touches the phrase is adjacent, and adjacency is the rule. The approval
  names the rule when it refuses, so nobody has to guess why.

**The rule is applied to the final bytes, not only to the stored ones.** The sign-off is
a field of its own on `POST /templates`, and a `{firm_website}` is whatever the CRM
holds, so approval checks the subject, the body *and* the sign-off, and the composition
and the fence check the rendered subject and the composed body before anything is
frozen. A violation there is a handled hold and never an exception out of the insert,
with the CHECK as the backstop underneath it: a *step* stopped before its fence exists
holds under the `optout_link` reason code of its own (migration 0024 seeds it), so the
operator can read why an approved template stopped; a fence already prepared refuses
with `footer_not_composed` and carries `optout_link` as its detail.

**The bare word is allowed**, and that is the point of the change: the old CHECK refused
`unsubscribe` anywhere, which made *"just reply unsubscribe and I'll stop"* — the very
sentence Callie wants to offer — unwritable. What happens when somebody replies with it
is unchanged: `packages/domain/src/rules/replyClassification.ts` suppresses on explicit
stop wording in ordinary language and holds ambiguous wording for confirmation
(Appendix G 35), and the eligibility and suppression checks before every send are
untouched by this decision.

The other two guards this section used to name are gone. Migration 0019 dropped
`template_versions_approved_has_stop_line` and the approved-version immutability
trigger, because wave 2 (S3) made an approved version editable in place; 0024 drops it
again, `IF EXISTS`, so the file that reverses the decision says so. And
`sequence_steps_no_unsubscribe_link` went with `sequence_steps.linkedin_message` in
0018.

**The footer is the sign-off**, and, since migration 0020, the `postal_address` setting
under it when the workspace has configured one (`docs/greenfield/settings.md`). Nothing
else. The block is **composed at send** — `composeSendBody` in
`packages/domain/src/rules/templates.ts`, called before the fence stores a body and its
hash — so the bytes the fence freezes are the bytes Gmail receives.

Every template approved and every fence prepared before 29 September 2026 ends with the
sign-off and then `Reply "stop" and I will not email you again.` No migration rewrote
them: the composition recognises that block, in both the with-address and without-address
shapes, and *replaces* it with the block the workspace composes now — so the line
disappears at the next send, from bytes nobody had to edit. A body that is signed but
does not end with a block this workspace's records can rebuild — an address never
configured here, a postscript under the sign-off, a stop line in the middle of the text —
is **held for a person** (`footer_ambiguous`) rather than edited or signed twice. The
block has to stand as whole lines with a blank line above it, so `Hi David` is not a
sign-off and `Hello.\nSam discussed repairs.` is not a signed body; and a legacy stop
line anywhere in the bytes that would leave — above a block that *was* recognised, or
inside a sign-off that still carries the old sentence — is a hold too, because the line
is exactly what this release removes.

## The matching order

12.3, in this order, first match wins the rule but **all** candidates are recorded:

1. **Thread** — the Gmail thread id is already on an FSS message.
2. **Message-ID reference** — `In-Reply-To` or `References` names a message FSS
   recorded. (G7-2 adds the outbound fence as a second source.)
3. **Participant** — an address on the message is a known contact route, excluding
   every address that is itself a workspace mailbox.

Two or more distinct opportunities is **ambiguous**: one `ambiguous_match` hold per
candidate, sourced on the message, and no automation proceeds.
`mail_message_matches_ambiguous_has_hold` makes an ambiguous match without a hold
unrepresentable.

`resolveAmbiguity` opens the keeper's `uncertain_reply` hold **before** releasing the
ambiguity holds, so the selected opportunity is never momentarily unheld. A human
resolution also switches the firm to manual.

Appendix G 15: a candidate whose opportunity is closed is carried to the firm's open
opportunity rather than discarded.

## Sync, recovery and the watch

A `mail.sync` is single-flight per mailbox generation: `mail-sync:{mailbox}:{generation}`,
no instant in the key, so a hundred notifications in a minute are one sync with the
**high-water** history id merged in. `coalesceMailSync` is an upsert with three rules — merge the id upward
only, re-arm a `done` job, never revive a `dead` one — and it is in the mail lane
rather than in `jobs/jobStore.ts` because those rules are mail's contract with
Appendix C, not the queue's.

Each run is bounded and its continuation is the one-minute scheduler, never itself. The
reasoning is in `docs/archive/decisions/g7-sync-transaction-shape.md` and it is the single
easiest thing in this lane to get wrong.

### Four rules of mail-core correctness (C2B-A1)

These four hold the sync, the recovery and the watch together across a generation
change — an account switch, an expired cursor, a restore — and a mailbox far larger than
one run.

**1. Generation fencing.** Every job reads the mailbox's `generation` and
`email_address` at its start, and each of its durable writes is predicated on both,
inside the job's transaction: `mail.sync`'s cursor compare-and-set (`advanceCursor`
takes the fence), the expired-cursor generation advance, a recovery's handoff cursor,
its progress and its completion, and a watch registration (`lockMailboxAtFence` after
`users.watch`, before the insert), and every refusal path's write — a revoked grant
(`holdForRevokedGrant`), a disconnected or coverage hold, a rate-limited sync error. A
path that writes a stop fact takes the send gate first and then the mailbox row
(`lockForFencedStopFact`), never the row and then the gate — and so does every
transaction that updates the mailbox row before it may take the gate: a recovery
adopting a legacy cursor (which then holds the gate through that one run's Gmail reads),
the expired-cursor recovery start and the restore recovery start. A continued recovery
locks the row at its fence to commit before it writes progress, and a sync whose
compare-and-set finds the cursor moved takes the fenced lock before it answers
`cursor_moved`, so its committed prefix is fenced to commit too. The fenced row lock is `FOR NO
KEY UPDATE`: every `mail_messages` insert holds KEY SHARE on its mailbox row, which `FOR
UPDATE` would wait on and NO KEY UPDATE does not, while a generation bump still waits
for it. A mismatch throws `StaleMailboxGeneration` rather
than returning, so the runner rolls back the whole job, message effects included, and
records `stale_mailbox_generation`. The runner then **retries** it, and the retry is
harmless by construction: it re-reads the mailbox and acts for the generation it finds.
A `mail.sync` of a mailbox that is not `ready` (`baseline_pending` or `recovering`)
reads no history and writes only the coverage hold — it starts a recovery only when its
generation has none (`recovery_underway` otherwise); a `mail.recover` for a superseded
generation answers `generation_superseded`; a watch renewal scheduled for an earlier
mailbox generation answers `generation_superseded`, and one for the current generation
registers the current account's watch. The `mail.sync` and watch-renewal keys carry the
mailbox generation (`mail-sync:{mailbox}:{generation}`,
`watch:{mailbox}:{mailboxGeneration}:{renewal}`), so a `dead` job of an earlier
generation — which 13.2 leaves dead — cannot absorb the next generation's work.

**2. The continuous handoff.** `startRecovery` requires `startHistoryId`: the profile's
`historyId`, read *before* the interval's end (`toAt`) is fixed, with `toAt` no earlier
than that read. It is stored as `mailboxes.history_id` when the recovery is created, and
completion adopts exactly that id — there is no profile read after the listing. The
listing covers everything up to `toAt`; history sync after completion covers everything
after the id; a message arriving during the recovery is in one or both, never in
neither. A recovery created before this rule has no cursor, and takes one at the start
of its next run, moving `to_at` to after that read.

**3. Resume by recorded ids.** A recovery run lists its interval in time slices of
`RECOVERY_SLICE_SECONDS` (one day), each by **one** `users.messages.list` call with
`after:`/`before:` epoch seconds and no page token. Gmail documents nothing about a page
token when the mailbox changes between pages — a message deleted before the second page
can shift a survivor off both — so a recovery never follows one. A slice whose answer
has a `nextPageToken` holds more than a page: the answer is discarded and the slice
bisected, down to one logical second. Every slice's `after:` is one second below it and
the last slice's `before:` one second above the window, so the closed interval
`[fromAt, toAt]` and every internal boundary second are listed whichever way Gmail
treats an exact-second bound (a message just outside the window is listed too, and
recording by Gmail id makes that harmless). If the smallest queryable window — one
logical second, queried over two or three — still holds more than a page, the recovery
follows Gmail's page tokens within that one query only, and logs
`mail.recovery_slice_paginated`; the residual there is that a deletion within those
same seconds, during that one listing, could shift a message across a page (the next
run lists the slice again). A run makes at most `RECOVERY_LISTING_CALL_CAP` (400)
listing calls; one that reaches it continues next run, and a window that needs more in
one run (about 50,000 messages at the default page size) cannot complete without a
durable slice checkpoint (a migration). Each slice's ids are checked
once against `mail_messages` (`provider_message_id = ANY(...)`), and the rest are
processed under two budgets: `maxMessages` counts only messages the run newly records
(a proven duplicate or a vanished id writes no row and costs nothing against it), and a
read cap of `RECOVERY_READ_CAP_FACTOR` (3) × `maxMessages` ids bounds the run's Gmail
reads (one metadata read per id, plus one read of the other message on an RFC
Message-ID collision). The whole walk comes before the pipeline, so no listing call
waits behind the send gate; it stops early once it holds more unrecorded ids than the
read cap. The rows are the position, so a message deleted between runs shifts nothing.
The recovery completes only when one run listed every slice of the window and every
listed id is covered — it has a row, or this run found it a proven duplicate, or this
run's metadata read found it gone — and then `sync_state = 'ready'`, the watermark at
`toAt`, `completed_at` and the release of the `coverage_incomplete` hold commit
together, predicated on the generation, the address and `history_id` still equal to the
handoff id; any mismatch throws and rolls back. `pages_completed` is the number of
slices the last walk listed, and is informational.

A cursor is the recovery's captured handoff only if `history_id_updated_at` is no
earlier than the recovery row's `started_at`; otherwise — no cursor, or the expired one
an older expired-cursor recovery left — the run adopts a fresh handoff first.

The residual, and it is a real limit: proven duplicates and vanished ids leave no
record, so every run meets them again, first. While they number no more than the read
cap, a run reads them all, still records up to `maxMessages` new messages, and the
recovery completes in the run whose budget reaches the end. If they alone exceed the
read cap (1,500 at the default page size), every run spends its whole read cap on the
same ids at the front of the listing and neither records anything behind them nor
completes: the recovery does not progress, and the coverage hold stays on. Fixing that
needs a durable record of an id already covered (a migration, not made here). Two
signals make the stall visible: `MailboxCoverageAgeSeconds` includes a `baseline_pending`
or `recovering` mailbox whose current recovery has run for more than
`RECOVERY_STALL_SECONDS` (two hours), reading the recovery's age, and a run that records
nothing and does not complete logs `mail.recovery_no_progress`.

**4. RFC Message-ID conflicts.** `mail_messages_one_per_rfc_id` allows one row per RFC
Message-ID per mailbox. `recordMessage` absorbs a collision instead of raising. A
**proven duplicate** — same direction, same normalised From, same Subject, and the same
`Date` header (the table keeps no `Date`, so the pipeline re-reads the other message's
allowlisted metadata to compare) — is treated as already recorded: the existing row is
returned, no effect runs again, and the pipeline report counts `duplicateRfcId`. Any
other collision is a **conflict**: the new message is recorded with `rfc_message_id =
NULL`, a `mail.rfc_id_conflict` line is logged (mailbox id, both Gmail ids, the RFC id;
no body, no address), the report counts `rfcIdConflicts`, and the message is processed
as new on its **own** metadata — its direction, its classification, its suppression, its
own `In-Reply-To`/`References` for matching. Its fence lookup is by its own Gmail id
only — its row holds no RFC Message-ID, on the first import and on every replay — so it
can never inherit the fence of the message that owns the colliding id. A failed read of
the other message for the duplicate proof is this message's stopped read, like any
other failed Gmail read. An opt-out that reuses an outgoing message's id is therefore still read and
still suppresses.

### The cursor stands on whole history records

`users.history.list` answers `{ history, nextPageToken, historyId }`. Each entry of
`history` is a Gmail `History` record whose own id is **`id`**, and one record can
change several messages. `historyId` at the top is the mailbox's current record;
`historyId` on a *message* is the last record that changed it. No record carries a
`historyId` (https://developers.google.com/gmail/api/reference/rest/v1/users.history/list).

A cursor can only stand on a record's id, because `startHistoryId` returns the records
*after* an id and never the rest of one. So the cap is applied to whole records
(`takeWholeRecords` in `mail/sync.ts`): a run takes records oldest first until it holds
`DEFAULT_SYNC_MESSAGE_LIMIT` (50) distinct messages, and never part of a record. A
capped run writes the id of the last record it took, and every message in every record
at or before that id has been processed. A run can therefore process more than 50
messages, by at most one record's worth less one, and the first record is always taken
whole, however large, or a record bigger than the cap would stop the mailbox. A run
that read to the end of the history (no `nextPageToken`) and took every record it read
is not capped: it writes the top-level `historyId`, raises the watermark and may
release `coverage_incomplete`, as before. A capped run raises nothing.

History ids are uint64 decimal strings. They are compared only through
`compareHistoryIds` and `laterHistoryId` (`mail/historyIds.ts`, `BigInt`), never through
`Number`, which cannot tell `9007199254740992` from `9007199254740993`. `mailboxes.history_id`
is `text` with `^[0-9]{1,20}$`, so the database holds exactly what Gmail sent, and the
adapter refuses a record with no usable `id` as a malformed page rather than guess a
cursor for it. The job queue's high-water merge compares as `numeric` in SQL and was
already exact.

Until lane g76 (25 September 2026, audit items C06 to C08) the adapter read each
record's id from `historyId`, found nothing and used the start cursor. A run under the
cap still wrote the right cursor, from the top-level `historyId`. A capped run wrote
back the cursor it began from, so a mailbox with more than 50 new messages since its
cursor re-read the same first 50 every minute and never reached the rest, until Gmail
expired the cursor and a recovery re-read the interval. Its heartbeat stayed fresh
throughout: the heartbeat proves a check ran, not that the cursor moved. What that
looks like is a `mail.sync` heartbeat whose detail reads `more: true` pass after pass
while `mailboxes.history_id` does not change. The old code never moved a cursor past a
message it had not processed; it stalled instead of skipping. The first correct pass
after the fix reads from the stale cursor, processes the backlog in whole records over
consecutive one-minute passes, and re-reads the first 50 once, which the pipeline's
idempotent writes make harmless (`mail/effects.ts`, "safe to run twice"). The reasoning is in
`docs/archive/decisions/g76-history-records-are-the-unit-of-progress.md`.

### The push token

`POST /integrations/gmail/push` takes no session: the OIDC token Pub/Sub presents is its
authentication. `mail/pushToken.ts` checks the signature against Google's key set, then
`decidePushToken` checks the claims in 4.1's order: issuer `https://accounts.google.com`,
the exact audience, the service-account email (compared lower-cased), `email_verified`,
`exp` not passed (60 s of skew), `iat` not in the future (60 s of skew), and an age of at
most **one hour** plus the skew. A token that fails any of them is a 401 with one
redacted body, logged as a `refusal` line with reason `gmail_push_<refusal>` and a
second with reason `401`, and Pub/Sub retries the message
(`docs/archive/decisions/g7-webhook-rejection.md`). An accepted push is a 200 and writes no log
line; its trace is its `gmail_push_notifications` row and the job id recorded on it.

The age bound is the token's own lifetime. Pub/Sub mints the token for an hour and
presents the same token with every delivery until it mints the next one. Until lane g63
the bound was ten minutes. On 24 and 25 September 2026 production logged 138
`gmail_push_too_old` refusals in three hours: every delivery after a token's eleventh
minute was refused, and the retries carried the same token and were refused too, until
Google rotated it. Mail kept arriving only through the one-minute check below. The hour is a
fact about Google, not a deployment setting, so no environment variable changes it.

With the hour as the bound, a genuine Pub/Sub token cannot reach `too_old`: its `exp`
is an hour after its `iat`, so `expired` refuses it first. A `gmail_push_too_old` line
now means a Google-signed token that claims a longer life than an hour, and it is worth
reading before anything else is changed.

### The mailbox check, once a minute

13.3 alarms on "three missed one-minute mailbox checks", and 12.3 calls the sweep a
one-minute reconciliation. So the scheduler's `mail-sync-reconcile` source asks for one
`mail.sync` of **every connected, `ready` mailbox on every pass**, whether or not a push
synced it a few seconds earlier (`apps/worker/src/scheduler/mailSources.ts`,
`listMailboxesDueForSync`). `coalesceMailSync` makes the ask free while a sync is already
queued or running, and leaves a `dead` sync dead. A mailbox that is `baseline_pending` or
`recovering` is checked by its `mail.recover`, which the recovery source re-arms every
pass and which writes the same heartbeat.

Every check writes the mailbox heartbeat, whatever its outcome: `recordMailboxHeartbeat`,
instance key the mailbox id, `expected_interval_seconds` =
`MAILBOX_CHECK_INTERVAL_SECONDS` = 60. The worker publishes `MailboxCheckHeartbeat` once a
minute, 1 when a mailbox heartbeat is fresh and 0 when not, and
`fss-<prefix>-mailbox-heartbeat-missed` is Sum < 1 for three of three one-minute periods.
So one period is one promised check, and the alarm is three of them missed.

A mailbox heartbeat counts as fresh up to **30 seconds past its promise**
(`HEARTBEAT_GRACE_SECONDS.mailbox` in `packages/domain/jobs/heartbeats.ts`). The check is
asked for by the scheduler pass, which waits 60 s after the previous pass *finishes*, and
performed by a runner slot after a claim, up to a second later when the slot is idle and
longer when it is finishing another job. Two healthy checks are therefore about 61 s
apart, and the metrics loop, a third fixed-delay loop drifting slowly against the other
two, would otherwise sometimes sample in that extra second, several minutes running.
The scheduler's own heartbeat has the same shape and, since 25 Sep 2026, the same grace;
the API and worker heartbeats have none.
From the last check at t0, the alarm reaches ALARM between t0 + 210 s and t0 + 270 s.

What one check costs when nothing is new: one KMS `Decrypt` of the stored refresh token,
one refresh at Google's token endpoint, and one Gmail `users.history.list` from the
stored cursor (2 quota units). That is 1,440 of each per mailbox per day from the sweep,
plus one per push-driven sync; the watch has no label filter, so any change in the
mailbox pushes. Two quota units a minute is about 0.01% of Gmail's per-user limit of
15,000 a minute, and fifty mailboxes are 100 units a minute against a per-project limit
of 1,200,000. KMS at $0.03 per 10,000 requests is about $0.13 per mailbox per month. The
access token is not cached between checks; caching it for its hour would take the token
refreshes and decrypts to 24 a day per mailbox, and is a later change, not a correctness
one.

Until lane g58 the sweep asked only for a mailbox five minutes past its last sync (288
checks a day), while the heartbeat promised sixty seconds. Production's one mailbox,
sending off, was fresh only when a push happened to arrive, and the alarm fired in every
quiet three minutes (24 September 2026, `docs/greenfield/release.md` 8.0z).

**Not yet per mailbox.** `MailboxCheckHeartbeat` is one datapoint for the component: 1
if *any* mailbox heartbeat is fresh (`collectJobMetrics`). With one mailbox that is the
mailbox. With several, a stuck mailbox hides behind a healthy one, and 13.3 says "every
mailbox". The lane that connects a second mailbox owes a per-mailbox reading: every
*connected* mailbox fresh, so that a disconnected one's stale row does not alarm for
ever.

An expired cursor (Gmail answers 404) is not a failure. It bumps the mailbox
generation, sets `recovering`, opens `coverage_incomplete` and starts a recovery from
**watermark minus one hour**, with epoch-second `after:`/`before:` bounds and 500 ids
per page (Appendix D, Appendix G 13). The hold clears only when the whole interval is
processed.

A Gmail watch expires after seven days and a lapsed watch is *silent*.
`mailbox_watches.generation` is a per-renewal counter, independent of
`mailboxes.generation` — so `watch:{mailbox}:{mailboxGeneration}:{generation}` is a new
key every renewal, and bumping it does not supersede an in-flight recovery. The mailbox
generation is in the key too (rule 1 of the four above), and a registration commits only
while the mailbox is still the generation and address the renewal read before its
`users.watch` call; its `mail.watch_registered` log line names the watched address. `GmailWatchHoursToExpiry`
reports **zero** for a connected mailbox with no live watch, because no watch is the
state the alarm most needs to fire on.

The watch is renewed **daily**, by its age: `listWatchesDue` returns a mailbox whose live
watch was registered 24 hours ago or more, has less than 24 hours left, or does not
exist. `GmailWatchHoursToExpiry` is read every minute but only moves when a renewal runs,
so a daily renewal holds it between 144 and 168 hours, and the 48-hour alarm fires only
after four days of failed renewals. Until lane g58 the source renewed only inside a
watch's last day, which is day six of seven, so every connected mailbox would have held
`fss-<prefix>-gmail-watch-expiring` in ALARM for the day before each renewal. A renewal
is one `users.watch` call (100 quota units) a day per mailbox.

## Two workspaces, one address

Appendix G 8: the same provider message id, thread id, RFC message id and push
notification id can exist in two workspaces, and every uniqueness in this migration is
scoped by `workspace_id` to allow it.

The webhook is the exception that proves it. A push notification carries an email
address and no workspace, so `receivePushNotification` looks the mailbox up
**unscoped** — and refuses `mailbox_ambiguous` if that address is a connected mailbox
in two workspaces. Guessing would deliver one workspace's mail into the other's
history, which is the worst failure this system has. The refusal is loud and the
operator disconnects one of them.

## Mailbox lifecycle: the thirty-day rule

A mailbox that has sent automated mail in the last thirty days is not disconnected and
its Google authorization is not revoked. The reason is 12.6's reply-only opt-out: a
prospect stops FSS by replying, the reply arrives in the mailbox that wrote to them,
and a mailbox nobody is syncing is a mailbox in which a "stop" sits unread. Keeping the
connection alive for thirty days after the last automated send is how the workspace
makes sure a late stop is still received and honoured. This is the workspace's own
operating rule, decided by David on 21 September 2026, and not a reading of anybody
else's requirement. It is a rule people follow and not yet a guard the software
enforces: nothing in this release refuses a disconnect or a revoke on those grounds,
and the built guard — a refusal on the disconnect route, with an admin override that is
audited — belongs to a later lane. Until then it lives here, in
`docs/greenfield/release.md` section 6, and nowhere else.

### The per-mailbox thirty-day opt-out window is the same kind of rule

David's 19 September 2026 note asked for a per-mailbox thirty-day opt-out-processing
window, "tracked per mailbox". The 21 September deviations sweep found no column,
constraint or code path for it, and David's decision 3 of that day made it a **written
operational rule for version one**, with a built guard belonging to a later lane. Lane
G22 re-checked the code and the answer has not changed: there is no window column, no
expiry on a suppression, and nothing anywhere that refuses or permits an action on the
strength of a thirty-day clock. `effective_suppressions` has no time term at all, and
`suppression_events` records no expiry — a suppression is superseded by an explicit,
audited event or it stands for ever.

The docs are aligned to the code rather than the reverse, and deliberately, because the
code is already *stronger* than the rule. Invariant 4 is "suppressions are effective
immediately and database-enforced", and `decideSend` reads `effective_suppressions`
before every single dispatch (`docs/greenfield/sending.md` rule 3), so a reply-based
stop takes effect at the next send attempt and never lapses. A window is a deadline for
processing; FSS has no queue of unprocessed opt-outs to put a deadline on. What version
one does not have is a *record* that the obligation was met per mailbox, which is what
the later guard lane is for.

## Switching the mailbox

Call-to-booking slice A2 (30 September 2026): the owner's mailbox moves from one Google
account of the hosted domain to another — `callie@usecallie.com` to
`david@usecallie.com` — **in place**. The `mailboxes` row keeps its id, so everything
that references it carries over. Automated sending stays paused; nothing here touches
the pause.

### The contract

* **Intent, at `POST /gmail/connect`.** `switchTo` names the new account. It is refused
  before any consent screen with `mailbox_switch_same_address` (the mailbox's own
  address), `mailbox_switch_wrong_domain` (not the hosted domain) or
  `mailbox_switch_pending_sends` (any fence of the mailbox in `prepared`, `held`,
  `dispatching` or `reconciling`). Otherwise the lowercased address goes into the signed
  grant state (state version `g2`, with a fresh `attemptId`) and into the consent URL as
  `login_hint`. Every connect gets an `attemptId`, returned in the result; only a switch
  gets a hint. An owner with no mailbox has nothing to switch: that is a plain connect.
* **The callback refuses a silent switch.** A re-consent whose chosen account is not the
  mailbox's address is `mailbox_switch_not_requested` unless the state carries the
  intent, and `mailbox_switch_address_mismatch` when the intent names another account.
  An intent for the address the mailbox already is — a second attempt after the first
  completed — is `mailbox_switch_same_address`; a re-consent without intent is accepted
  as before. The older refusals (hosted domain, address taken, scopes, no refresh token) are
  unchanged. Every callback refusal writes `mailbox.grant_refused { reason, attemptId }`
  on the user and changes nothing else; `/gmail/status` reports the latest one after the
  latest `mailbox.connected` or `mailbox.switched` as `lastGrantRefusal`, which is how
  the Mac learns what the browser page deliberately does not say. An expired state is
  audited the same way (`authorization_request_unknown`), and so is a consent the owner
  cancelled (`error=access_denied`, no code: `grant_refused`). A state this process did
  not sign is attributed to nobody and not audited.
* **One commit.** Every provider call comes first, outside any lock: the code exchange,
  the profile read (address and `historyId`), then `toAt`; the old account's refresh
  token is decrypted and held in memory. Then one transaction on the request's session,
  in this lock order: the exclusive send gate, the mailbox row `FOR UPDATE NOWAIT`, the
  fence re-check. The row lock is strong because the revive changes `email_address`, a
  unique-index column, which conflicts with the `KEY SHARE` an import holds from its
  message rows; `NOWAIT` because such an import then waits for the gate, and a callback
  that held the gate while waiting for the row would deadlock with it. A busy row rolls
  the transaction back — releasing the gate — and it is retried, about five seconds in
  all (no Google call is repeated). The switch's instant is `clock_timestamp()` read once
  both locks are held, never the transaction's `now()`: a sync that committed against
  the old account while the callback waited stays the old account's. The fence
  re-check (a fence prepared since the connect refuses `mailbox_switch_pending_sends`
  and rolls back). A switch then resets the account's history state
  (`resetAccountState`: cursor, watermark, sync error, last sync) and cancels the current
  watch row — `listWatchesDue` treats the mailbox as due at once, so the new account's
  watch registers on the next scheduler pass — before the revive (address, account id,
  generation + 1, `baseline_pending`), the token replacement, the `mailbox_accounts`
  rows, the coverage hold, the new generation's baseline from the profile's `historyId`,
  the release of every `mailbox_disconnected` hold of the mailbox (nothing released it
  before A2, on reconnect either), and `mailbox.switched { from, to, attemptId,
  switchedAt }`. Only after the commit, and only for a switch, is `users.stop` called on
  the old account's watch with the old token, best effort; the answer is recorded as
  `mailbox.switch_old_watch { attemptId, oldWatchStopped }`. A refused or rolled-back
  switch changes nothing at Google. A same-address re-consent is what it was, plus the
  `mailbox_disconnected` release.
* **`mailbox_accounts` (migration 0027).** One row per account interval, at most one
  open. No rows means the mailbox has only ever had its current address. A switch closes
  the open row, or writes the old account's closed interval from the mailbox's creation
  (the old account held it since generation 1), and opens the new account's.

### What carries over, and what is bounded

The conversation history, suppression, follow-up permission evidence, fences, the
send-ramp history and the links to old messages all carry over, because all of them
reference the mailbox id or nothing mailbox-specific at all.

Two things are bounded by the account, both by Gmail internal date and both only on the
outgoing side (`mail/effects.ts`, `sequences/followUpPermissions.ts`):

* an outgoing message sent before the current account's `active_from` is never a direct
  send — the new account's own Sent folder from before the switch is that account's
  history, not the salesperson writing through Callie's mailbox;
* a message consumes a permission only if sent at or after the permission's creation,
  and ends an enrollment only if sent at or after the enrollment's creation (so a
  delayed import of an old message does not spend a newer grant).

Every boundary is compared exactly, against the stored internal date: "sent at or after
X" is `internal_date >= X` to the microsecond, so a message dated 12:00:00.123 is before
a permission created at 12:00:00.123900.

Inbound processing — replies, opt-outs, suppression — is not bounded: an opt-out the new
account received before the switch still suppresses. The open-in-Gmail link
(`retention/attachments.ts`) names the account the message was **recorded** under
(`mail_messages.recorded_at` against the intervals), so a message recorded while the row
was `callie@` still opens in `callie@`'s Gmail.

### The operator's steps

1. In `callie@usecallie.com`'s Gmail settings, forward all mail to `david@usecallie.com`
   and **keep a copy** in the old inbox. A prospect who replies to an old thread writes
   to `callie@`; the forwarded copy is what reaches the synced account.
2. Run `fss admin mailbox switch-preflight` on the operations task. It is one READ ONLY
   transaction: the mailbox, message counts, fences by state, live permissions and
   enrollments, open holds, watch rows, mail jobs (in both key formats: a
   `mail-sync` or `watch` row from before lane A1's generation-keyed keys is reported as
   `orphaned_pre_generation`, never as live work), send-day totals, the account
   intervals, and `wouldRefuse`. Wait while `wouldRefuse` lists
   `non_terminal_fences` (settle them first) or
   `old_account_not_synced_within_2_minutes` (the old account's last reads must be in).
3. David starts the switch from the Mac, naming `david@usecallie.com`, and consents as
   that account. The Mac reads the outcome from `/gmail/status`: the new address and
   `baseline_pending`, then `mailbox.baseline` progress; or `lastGrantRefusal` with the
   attempt's id.
4. `fss admin send-path preview` shows, for every prepared or held fence and due e-mail
   step, every condition the dispatch claim can refuse on — fence state, mailbox,
   suppression, permission, cold outreach, firm exclusivity, control mode, enrollment,
   holds, assignment, route and its version, coverage, template approval, the claim's
   own composition, the workspace attestation (**stored half only**), domain switch,
   window, cap, the direct-send quiet window, the step's schedule and the footer — each on
   its own, and the sender it would leave from: the new address once the switch has
   committed.

### Residuals

* The old account's refresh token is replaced, not revoked: the `callie@` grant stays
  listed in that Google account's third-party access until someone removes it there.
* The old watch is stopped after the switch commits, best effort. If the stop fails, the
  old account's Gmail watch lives until it expires (at most seven days) and pushes for it
  no longer resolve to a mailbox that reads that account; nothing acts on them.
* A reply that reaches `callie@` after the switch is seen only through the forwarded
  copy, as an incoming message of the new account. Forwarding off means such a reply —
  including an opt-out — is not read.
* A switch waits for every non-terminal fence, `held` ones included. While the domain
  switch is off a held fence does not settle by itself; the preflight names them.
* The ramp is the mailbox's, so the new account inherits the old account's sending days.
  Nothing is sent while the pause stands; the choice is recorded here for when it lifts.

## What is deliberately not here

* **Sending.** G7-2 added it: the at-most-once fence and the reputation ramp, in
  `packages/domain/outbound` and migration 0010 (its domain guard was deleted on
  26 September 2026). `GmailClient` gained
  `sendMessage` and the `rfc822msgid:` Sent-folder search, and nothing about the read
  surface changed. See `docs/greenfield/sending.md`.
* **The LLM classifier.** G7b, behind the seam rule 4 describes.
* **Live credentials.** `mailHandlers(undefined)` in this release, so `mail.sync`,
  `mail.recover` and `mail.watch_renew` wait in the queue unclaimed. Both adapters are
  real and tested; the change that reads a deployment's client secret and KMS key is
  reviewed on its own.
* **Reply cards.** `POST /messages` is a minimal message view, redacted by
  `decideFirmRead` visibility (Appendix F): a member who is neither the assignee nor an
  admin gets the envelope and not a word of the body.

## Running the tests

```
npm --workspace @fss/domain run test -- test/mail
npm --workspace @fss/api run test -- test/mail.test.ts
npm --workspace @fss/worker run test -- test/mailHandlers.test.ts
```

Nothing in any of them opens a socket to Google. The Gmail fixture is recorded, the
push tokens are RSA pairs generated at runtime, the envelope key comes from
`randomBytes`, and the HTTP client's test serves the Gmail API itself from a loopback
port.
