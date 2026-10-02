# Suppression

Specification revision 3, section 10.2, invariant 4, Appendix A, Appendix E and
Appendix G 21, 29 and 30.

## The short version

A suppression is a row nobody may change, written to the object-locked journal before
it is written to the database, effective the moment it commits, and undone only by
another row that says so. A salesperson may correct their own mistaken manual
suppression within ten minutes of database time, and nothing else may be reversed by
anyone but an admin with a documented reason.

## Where everything is

```
packages/domain/db/migrations/0001_foundation.sql  suppression_events, insert-only by privilege
packages/domain/db/migrations/0006_policy.sql      the finalization marker, the view,
                                                   the same-key trigger
packages/domain/db/migrations/0037_suppression_channels.sql
                                                   the channel, the view per channel,
                                                   the same-channel trigger
packages/domain/suppression/journal.ts             the port, the deterministic id, the fake
packages/domain/suppression/events.ts              record, correct, supersede
packages/domain/suppression/effective.ts           the one authoritative read
packages/domain/suppression/finalize.ts            the claim and the finalizer
packages/domain/suppression/handler.ts             the suppression.finalize job
apps/api/src/journal/index.ts                      the S3 client, the local no-op
apps/api/src/routes/suppressions.ts                three writes and one read
apps/worker/src/handlers/suppressionFinalize.ts    the registration
```

## The four rules

### 1. Immediately effective, always

There is no pending state and no flag a reader has to remember.
`effective_suppressions` contains the event as soon as the transaction commits,
including throughout the ten-minute correction window — which is exactly what
Appendix G 29's "never contact during the window" means. The window changes what
happens to *enrollments*, not whether the handle is suppressed.

### 2. The journal is durable before the row is

`journal.append` is awaited inside the command transaction and before the commit: a stop's
before its `INSERT`, a supersession's after its `INSERT` has won the one-supersession index
(brief RF, R1). A lift in the journal that the database refused is the one object a replay
must not apply, so only the winner of a race is journalled.
See `docs/archive/decisions/g4-journal-port.md` for the two failure modes and why the
surviving-journal one is the safe direction for a stop.

**Both processes write it.** The API writes from its three suppression routes; the
worker writes when mail sync imports a prospect opt-out, which is the commonest way a
suppression enters the system at all. Until G12b only the API could: `infra/modules/cluster`
gave the worker `s3:GetObject` and `kms:Decrypt` — read, for Appendix E step 2's replay —
and the journal bucket policy named the API task role as its one permitted writer, so
the first opt-out a credentialed worker imported would have been refused by IAM and the
command would have failed closed. Both task roles now have `s3:PutObject` on the journal
object prefix and `kms:Encrypt`/`kms:GenerateDataKey` on the journal key, and both are
named writers in the bucket policy.

Neither has any `s3:Delete*`, and neither sets a per-object retention: the bucket's
default retention locks every object as it is put, and `s3:PutObjectRetention`,
`s3:PutObjectLegalHold` and `s3:BypassGovernanceRetention` are denied to *every*
principal by the bucket policy, so append-only survives an administrator as well as a
bug. `infra/modules/cluster/tests/services.tftest.hcl` and
`infra/modules/journal/tests/object_lock.tftest.hcl` assert both halves offline.

The event id is a sha256 of what the event *is* — workspace, scope, canonical key,
source, and whichever of the command id or the superseded event id identifies this
assertion. Database time is deliberately not in the digest, because Appendix E replays
the journal after a restore and an id that moved with the clock would defeat the
replay it exists for.

### 3. The claim comes before the write

The ten-minute correction and the finalizer race for one row in
`suppression_finalizations`, whose primary key is the event. Whoever inserts first
wins. `suppression_events` cannot be row-locked at all — `SELECT ... FOR UPDATE`
requires the `UPDATE` privilege, which is revoked — so the insert *is* the lock. See
`docs/archive/decisions/g4-finalization-is-the-lock.md`, including why the correction's
foreign key is deferred.

### 4. Nothing here can change a row that has been written

`UPDATE`, `DELETE` and `TRUNCATE` are revoked from both application roles on
`suppression_events` and on `suppression_finalizations`. There is no delete endpoint
and no undo endpoint, because an endpoint that pretended otherwise would be a lie with
a 500 behind it.

## The scopes

| Scope | Canonical key | Reach |
|---|---|---|
| `firm` | the firm id, lower-cased | that firm, in that workspace |
| `handle` | the E.164 number or lower-cased address | the whole workspace (10.2) |

A handle suppression is global across the workspace, which is why the merge in G3a
does not have to move one and why the suppression list is not narrowed to the caller's
assigned firms: a salesperson who could not see a handle suppression would re-add the
number they were told to stop calling.

Canonicalization is G0's ported rule and its version is stored on every event.
Appendix G 21 requires an unsupported canonicalizer change to be refused rather than
reinterpreted, and the direction of the refusal matters: an event written by a
canonicalizer this build does not understand still **suppresses** — it reads as "this
key is suppressed and I cannot reason about it further" — and it is the *write* paths,
correction and supersession, that refuse to act on it.

## The channels (migration 0037)

David, 2 October 2026 (P1, P2): "Do not call" stops phone calls only; an explicit "don't
contact me again" stops both; an e-mail opt-out stops e-mail only; every stop recorded
before 0037 means all channels. Scope and channel are independent, so every event is one
of `{handle, firm} × {phone, email, all}`. The column defaults to `all` (metadata only: no
rewrite and no UPDATE privilege), so every older row, and every row an older binary
inserts, reads `all`.

`suppression_events_channel_fits_key` refuses a handle stop on a number that is `email`
and one on an address that is `phone`: a stop no reader would ever read. A firm stop takes
any channel. `recordSuppression` refuses the same combination as `invalid_input` before it
journals anything.

**Which stop blocks which action.** "Yes" means refused. A contact's handles are their
numbers and addresses.

| Stop | E-mail send | Call-task step | Dial / dial advice | Terminal enrollment stop | Today new-firm lane | Research |
|---|---|---|---|---|---|---|
| handle, number, `phone` | no | yes | yes (that number and the contact's other numbers) | no | — | — |
| handle, number, `all` | yes | yes | yes | yes | — | — |
| handle, address, `email` | yes | no | no | yes | — | — |
| handle, address, `all` | yes | yes | yes (the contact's addresses are dial keys) | yes | — | — |
| firm, `phone` | no | yes | yes | no | excluded | excluded |
| firm, `email` | yes | no | no | yes | listed | excluded |
| firm, `all` | yes | yes | yes | yes | excluded | excluded |

The rule every reader follows: an e-mail reader (the send gate, the send path's fence
check, an e-mail step's eligibility, the terminal stops) refuses on `channel IN ('email',
'all')`; a phone reader (dialling, the dial advice, a call-task step's eligibility, the
Today new-firm lane, Needs review's stop-scope item) refuses on `channel IN ('phone',
'all')`. `firstSuppressed` takes the channel as a required argument. Research
(`isSuppressed`, the sweep) reads any channel, unchanged and conservative; the listing,
the dashboard and the send-path report show every channel.

A phone-only stop leaves an enrollment running, and its call-task steps are held at
eligibility (`handle_suppressed` / `firm_suppressed`): nothing is sent past them. The
terminal stops end exactly the enrollments whose e-mail steps eligibility refuses.

**Writers state both.** `RecordSuppressionInput.channel` is required:

| Writer | Scope / channel |
|---|---|
| `logCallOutcome` `do_not_call` | the dialled number with `doNotCall.channel` (default `phone`); the firm with the same channel when `doNotCall.scope = 'firm'`. The 1.0.29 checkbox `doNotCallCoversAllContact` (no `doNotCall`): number `phone`, firm `all` |
| Apply's outcome | `edits.outcome.doNotCall`, the same rule |
| an e-mail opt-out (`mail/effects.ts`, a confirmed reply) | handle `email`; the firm (one candidate, or ticked) `email` |
| a deletion tombstone | `all` |
| a merge | the original's channel, and its lift: a stop the source had lifted is copied with the lift linked to the copy, so it stays lifted on the target (brief RF, X7) |
| a correction or an admin supersession | the original's channel; the trigger refuses another |
| replay | the journalled channel, absent `all` |
| the same command again, across the 0037 boundary | the earlier event, when its channel covers the one asked for (`all` covers all): an opt-out journalled before 0037 as `all` and reprocessed after a restore as `email` is that event, not a second one (brief RF, X6) |
| `POST /suppressions/record` | `channel`, absent `all` (the installed desktop's "Stop all contact with this firm") |

**The manual review hold follows the channel** (`reviewHoldBlocks`): `email` blocks
`email_send` only (`enrollment_advance` is read by every sequence channel, so it cannot be
part of an e-mail-only hold); `phone` blocks `call_task` and `dial_authorization`; `all`
blocks all four. Replay opens the same set from the record's channel, on the firm the live
write named: a firm stop's own key, or the `firmId` a handle stop is journalled with since
brief RF (X5). A handle stop journalled before RF names no firm and replays with no hold.

**The journal** carries `channel` under the same schema, `fss.suppression.v1`: the field
is additive, an older parser ignores it and replays the event as `all`, and this parser
reads a body without it as `all` (any other value is `field_missing`). The deterministic
id hashes the channel **only when it is not `all`**, so every id written before 0037, and
every replay of an old object, is unchanged.

**Who 0037 made undialable.** Every stop before 0037 reads `all`, and a person's addresses
are now dial keys, so an old opt-out on an address now stops calls to that person.
`fss admin stop-channels report` (one READ ONLY transaction, ids and counts only) lists, per
workspace, the contacts with such a stop recorded before 0037 was applied, a phone route,
and no other stop on calls (no `phone`/`all` stop on their numbers or their firm). It is read
once after the release that applies 0037 (contract check CC2b).

## Who may undo what

| Source | Salesperson correction | Admin supersession |
|---|:---:|:---:|
| `salesperson_manual`, their own, within ten minutes | yes | yes |
| `salesperson_manual`, someone else's | no (`not_your_event`) | yes |
| `salesperson_manual`, after ten minutes | no (`window_expired`) | yes |
| `prospect_opt_out`, `prospect_do_not_call` | **never** (`not_salesperson_originated`) | yes, with `correction` or `documented_reconsent` |
| `import` | never | yes |

Appendix G 30 is the third column of the fourth row being unreachable from the
salesperson path, and `mayCorrectSuppression` in `@fss/domain` gives exactly three
refusals and no fourth.

There is no claim on the admin path. The ten-minute race belongs to the salesperson's
window; an admin superseding an event the finalizer already finalized is not a race
but a sequence — the terminal stops happened, and the supersession lifts the
suppression from there on. Two admins racing produce one supersession, refused by
migration 0001's partial unique index. The second waits on the first's index entry and,
once the first commits, is refused `already_superseded` under a savepoint, so its command
transaction is whole and its receipt is written; a supersession already committed is refused
before anything is journalled. A correction takes its finalization claim under the same
savepoint, so a correction that loses to an admin lift leaves no claim behind.

**Replay** (`fss admin suppression-journal replay`, brief RF):

- puts originals before what supersedes them, whatever order the bucket lists them in,
  earliest first otherwise (R3);
- keeps one supersession per event: the one the database already holds, else the earliest
  by recorded time and then id; the others are reported as `competingSupersessions`, ids
  only (R2), and a supersession whose original is in neither the database nor the records
  read is reported as `orphanSupersessions` and skipped;
- replays a supersession as a release: it opens no hold, is owed no finalizer, releases its
  original's review hold, and a correction claims its original `corrected` as it did live
  (R4).

A supersession may not change the scope, the canonical key or (since 0037) the channel:
a narrower or wider lift is a supersession followed by a new event. A CHECK cannot read
another row, so that is an `AFTER INSERT` trigger. It is AFTER rather than BEFORE
because a BEFORE row trigger runs ahead of the table's own CHECKs and would have
reported "the scope does not match" for a row that was really breaking
`suppression_events_supersession_reason_required`.

## The effective view

One view, authoritative for email and for dialing, one row per `(workspace, scope,
canonical key, channel)` carrying the earliest event of that channel (migration 0037; one
row per key before it). Per channel, so a key with an earlier `phone` event and a later
`email` one shows both, and an e-mail reader filtering by channel never misses the `email`
event behind the `phone` one. A key can therefore have up to three rows, and the report's
per-scope counts count (key, channel) rows. An event is
effective when nothing directly supersedes it, and a supersession row is never itself
a suppression — it is the record of one being lifted, which is why
`supersedes_event_id IS NULL` is the first predicate rather than a filter on the
source.

Both channels call `isSuppressed` or `firstSuppressed`. A second query that happened
to mean the same thing today is how two channels end up disagreeing next year.

## The finalizer

`suppression.finalize`, Appendix C, idempotency key `suppression-finalize:{event}`,
protected by business uniqueness. Enqueued by the command that recorded the
suppression, in the same transaction, with `run_at` at the ten-minute deadline — so a
finalizer exists for every event that has a window, or neither does. There is no
`DueWorkSource`: a scheduler pass that materialized it separately could only
materialize it late.

Running before the deadline is `not_due` rather than an error. The job's `run_at`
already holds it back, and a scheduler that woke a minute early must not turn a
correctable suppression into a terminal one.

At the deadline it claims, releases the `manual_suppression_review` holds its event
opened, and stops. The terminal enrollment stops belong to the sequences lane, which
reads the marker.

**And it is read now.** `consumeSuppressionStops` in
`packages/domain/sequences/terminalStops.ts`, called by the `sequence.terminal_stop`
job, takes every `suppression_finalizations` row with `outcome = 'finalized'` whose
event is still effective and stops each live enrollment it covers — the firm's, for a
firm-wide do-not-contact; whichever contacts hold the handle, for a handle. It keeps no
cursor: a marker whose stops have happened covers no live enrollment and so offers
nothing to do, which makes the drain idempotent without a column to advance. Until lane
G15 nothing read the marker at all, so a prospect's opt-out suppressed the handle —
`effective_suppressions` and the send gate refused every send from the moment it
committed, which is why this was an enrollment-state gap and never a sending leak — and
left the enrollment running until its next step held.
`docs/archive/decisions/g15-the-worker-drains-what-the-lanes-left.md`.

## Running the tests

```
npm run test --workspace packages/domain -- test/policy/appendixG.test.ts   # G 21, 29, 30
npm run test --workspace apps/api -- test/dial.test.ts                      # the journal seam
npm run test --workspace apps/worker -- test/suppressionFinalize.test.ts    # the job, G 2
```
