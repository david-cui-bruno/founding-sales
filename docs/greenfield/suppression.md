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

`journal.append` is awaited inside the command transaction and before the `INSERT`.
See `docs/archive/decisions/g4-journal-port.md` for the two failure modes and why the
surviving-journal one is the safe direction.

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
migration 0001's partial unique index.

A supersession may not change the scope or the canonical key. A CHECK cannot read
another row, so that is an `AFTER INSERT` trigger. It is AFTER rather than BEFORE
because a BEFORE row trigger runs ahead of the table's own CHECKs and would have
reported "the scope does not match" for a row that was really breaking
`suppression_events_supersession_reason_required`.

## The effective view

One view, authoritative for email and for dialing, one row per `(workspace, scope,
canonical key)` carrying the earliest event that made the key suppressed. An event is
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
