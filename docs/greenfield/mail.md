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
FSS registers a Pub/Sub **watch**, and each notification enqueues a coalescing
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
| Envelope seam | `mail/envelope.ts`, `mail/envelopeKms.ts` — see `docs/decisions/g7-kms-adapter.md` |
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
(`IS NOT DISTINCT FROM`), and writes `coverage_watermark_at` in the **same statement**.
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
blocks `email_send`, `call_task`, `linkedin_task` and `enrollment_advance`. Research is
not a step kind and is not blocked.

`releaseMailboxHold` re-reads the row and refuses to release a `coverage_incomplete`
hold unless `sync_state = 'ready'`. A caller cannot talk the database out of a hold it
has not earned.

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
`docs/decisions/g22-a-late-bounce-belongs-to-its-send.md` the reasoning.

`applyDirectSendEffects` switches the firm to manual with `origin: 'direct_send'`, so
the enrollment the switch stops records `direct_send` rather than `human_reply`
(`docs/greenfield/crm.md`, "The manual-mode origin").

### 6. There is no unsubscribe link, anywhere — and no postal address either

A reply-to-stop footer only. `template_versions` enforces it:

```sql
CONSTRAINT template_versions_no_unsubscribe_link
  CHECK (body !~* 'unsubscribe' AND subject !~* 'unsubscribe'),
CONSTRAINT template_versions_approved_has_stop_line
  CHECK (position('Reply "stop"' IN body) > 0)
```

and an approved version is immutable by trigger. G8 extends this table with nullable
columns; it does not create it.

The whole footer is two lines — the workspace sign-off, then

```
Reply "stop" and I will not email you again.
```

`footerBlock` in `packages/domain/src/rules/templates.ts` builds it and the approval
refuses a body that does not end with it (`template_footer_missing`). Between the two
lines there was a postal address until 22 September 2026; David decided there is
none, migration 0015 dropped `template_versions.footer_postal_address`, and
`docs/decisions/g20-automated-email-carries-no-postal-address.md` records the decision
and the three specification lines it deviates from. Nothing is appended at send time:
the footer is inside the approved body, which is why the content hash covers it.

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

A `mail.sync` is single-flight per mailbox: `mail-sync:{mailbox}`, no instant in the
key, so a hundred notifications in a minute are one sync with the **high-water** history
id merged in. `coalesceMailSync` is an upsert with three rules — merge the id upward
only, re-arm a `done` job, never revive a `dead` one — and it is in the mail lane
rather than in `jobs/jobStore.ts` because those rules are mail's contract with
Appendix C, not the queue's.

Each run is bounded and its continuation is the one-minute scheduler, never itself. The
reasoning is in `docs/decisions/g7-sync-transaction-shape.md` and it is the single
easiest thing in this lane to get wrong.

An expired cursor (Gmail answers 404) is not a failure. It bumps the mailbox
generation, sets `recovering`, opens `coverage_incomplete` and starts a recovery from
**watermark minus one hour**, with epoch-second `after:`/`before:` bounds and 500 ids
per page (Appendix D, Appendix G 13). The hold clears only when the whole interval is
processed.

A Gmail watch expires after seven days and a lapsed watch is *silent*.
`mailbox_watches.generation` is a per-renewal counter, independent of
`mailboxes.generation` — so `watch:{mailbox}:{generation}` is a new key every renewal,
and bumping it does not supersede an in-flight recovery. `GmailWatchHoursToExpiry`
reports **zero** for a connected mailbox with no live watch, because no watch is the
state the alarm most needs to fire on.

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

## What is deliberately not here

* **Sending.** G7-2 added it: the at-most-once fence, the reputation ramp and the
  domain guard, in `packages/domain/outbound` and migration 0010. `GmailClient` gained
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
