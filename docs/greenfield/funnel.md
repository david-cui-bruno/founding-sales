# The funnel

One table, `funnel_facts` (migration 0022), and one way to write to it. Every slice
of the CRM — research, telephony, meetings, warm mail, offers, demos, publishing —
records what it did here, and the dashboard reads the whole funnel from one place
instead of from eight tables with eight shapes.

## What a fact is, and what it is not

**A count, not a record: ids and codes, never a name, an address, a phone or an
e-mail.** A row says one thing happened once. What it carries is the ids of the
records it happened to, a lower-case dotted kind, the module that wrote it, an actor,
an instant, and a small `detail` object of flags and codes.

There is no field a person could go in, and that is the property rather than a
convention: a later change cannot leak a name by forgetting to strip one.

**Free text never enters this table**, and the reason is a deletion one. A firm-less
fact — a demo visitor, a published post — has no firm for the deletion workflow to
find it by, so it has no deletion path at all; a column that could hold a name would
be a name nothing could ever redact. Three rules keep that true:

* `dedupe_key` matches `^[0-9a-zA-Z_:.-]{1,200}$`. Ids, colons, dots and dashes —
  enough for `<uuid>:<code>` and a provider's reference, and no space, so no name.
* `detail` is bounded at 4 000 characters and checked to be an object by the
  database, and `recordFunnelFact` narrows it further: a **flat** object, at most 32
  keys, whose every value is a boolean, a finite number, null, or a string matching
  `^[0-9a-zA-Z_:.-]{1,64}$` — an id or a code. No nesting, no arrays, no sentences.
  `{ assigned: true, revision: 3, fit: 'yes' }` is a detail; `{ note: 'Dana said to
  call back' }` is refused with `invalid_detail`.
* Everything else is an id, a kind or a code.

A fact is **not** the business record. The call is in `call_logs`, the message is in
`mail_messages`, the firm is in `firms`. A fact is the sentence "this happened", kept
in the one shape a funnel can be counted from.

## The kind is open

`funnel_facts.kind` has no closed list. What the database enforces is a shape —
`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$`, at most 64 characters — so a typo is
refused and a free-text sentence can never become a dashboard key, and nothing more.

A closed CHECK would make every new kind a migration and a stop-migrate-start
release before the slice that wants it could emit anything. The v1 dictionary is
`packages/domain/funnel/kinds.ts`: documentation constants a lane extends in the same
pull request that starts emitting, with `isFunnelFactKind` to ask whether a kind is
one of them. `recordFunnelFact` deliberately does not consult it — a kind a slice
invented is recorded, and it is the dashboard's business to show a key it did not
expect rather than to lose the fact.

| Kind | Slice | Dedupe key |
|---|---|---|
| `firm.created` | J-facts | the firm id |
| `firm.researched` | R | the research run id |
| `call.placed`, `call.connected`, `call.engaged` | C | the call log id |
| `meeting.booked`, `meeting.held` | M | the calendar event id |
| `mail.warm_sent` | W | the outbound message id |
| `mail.replied` | W | the inbound mail message id |
| `offer.sent`, `offer.accepted` | O | the offer id |
| `payment.received` | O | the provider's payment id |
| `demo.started`, `demo.completed` | D | the demo session id |
| `post.published` | L | the provider's post id |

## One child id, never both

A fact may name a contact **or** an opportunity, never both
(`funnel_facts_one_child`), and `recordFunnelFact` refuses the pair with
`invalid_subject` before the insert.

This is a merge rule rather than a taste. `crm/merges.ts` moves contacts before
opportunities, so a fact naming both would have its `firm_id` cascaded to the target
by the contact triple while its opportunity triple still pointed at the source firm,
and the opportunity key would fail *inside* the merge transaction. No kind of the v1
dictionary needs both — a call or a meeting names a contact, an offer names an
opportunity — so the constraint costs nothing, and making the keys deferrable to buy
a shape nobody wants would have been the wrong trade.

What a merge does to the facts, and it is what `crm_domain_events` does: a fact with
a contact and a fact with an opportunity both follow their record to the target
through `ON UPDATE CASCADE`; a firm-only fact stays on the merged source row, because
the firm key does not cascade and a merged firm is a record that survives rather than
one that is deleted.

## The dedupe rule

`UNIQUE (workspace_id, kind, dedupe_key)`, named `funnel_facts_dedupe`.

**The key is the ids that identify the thing, never a timestamp.** A replayed command
or a re-run handler produces one fact. A key with a clock in it would produce two,
and the second would be indistinguishable from a real second event.

`recordFunnelFact` inserts `ON CONFLICT ON CONSTRAINT funnel_facts_dedupe DO NOTHING`
and answers `{ recorded: false, reason: 'duplicate' }`. It never throws for a
duplicate: a unique violation would abort the transaction the caller is replaying
inside, which is the bug this shape exists to prevent.

Everything else it can refuse, it refuses *before* the statement, for the same
reason — the caller's transaction stays alive and gets a reason:
`invalid_kind`, `invalid_source`, `invalid_key`, `invalid_subject`,
`invalid_detail`.

## The emit rule

**Commit the fact in the business transaction that produced the thing.** The
recorder opens no transaction of its own and runs inside whatever the caller holds,
so a fact exists exactly when the thing it counts does, and a rolled-back command
leaves no count behind. `createFirm` is the worked example: the `firm.created` fact
is written after the `INSERT INTO firms` succeeds, in the same transaction the
command receipt is written in.

**A reconciled provider record backfills with its own `occurred_at`.** A call whose
outcome arrives from the provider tomorrow happened today; passing `occurredAt`
puts it in the window it belongs to rather than in the window the reconciler ran in.

## The read

`funnelFacts(context, window, audience)` is the fourth source of `POST /dashboard`
(`packages/domain/funnel/read.ts`, wired through `DashboardSources`). Four figures:

* `byKind` — facts with `occurred_at` in `[from, to)`, by kind. Inclusive lower
  bound, exclusive upper.
* `firmsByKind` — distinct firms per kind, facts with a firm only. Three calls to one
  firm is one firm, and a conversion is about firms.
* `uniqueFirms` — distinct firms with any fact in the window.
* `firmsInScope` — active firms in scope **now**. The denominator a rate needs, and
  the same aggregate `readDashboard` already computes.

Keys are kinds, never names. The desktop does not render the funnel yet; slice F
does that.

## The audience rule

`docs/decisions/g9-dashboard-visibility.md`, with one thing that document does not
state in so many words:

* `onlyAssignedTo` null — an admin or the system — sees every fact in the workspace,
  firm-less ones included.
* A user id sees only facts whose firm is assigned to that user, and **no firm-less
  fact at all**. A demo visitor or a published post belongs to the workspace rather
  than to a person, and a workspace-wide figure on a salesperson's dashboard is a way
  to learn about a colleague's work.

## Deletion

The admin deletion workflow **redacts** a firm's facts: `detail` is cleared to `{}`
and the row stays with its count and its ids (`docs/greenfield/retention.md`,
"Deletion"). A contact deletion is narrower and redacts only that contact's facts.

`DELETE` and `TRUNCATE` are revoked from both application roles, so the row could not
go even if the workflow wanted it to — and it should not: the ids in it point at rows
the same deletion redacted rather than removed.

`UPDATE` is granted **on `detail` and no other column**
(`GRANT UPDATE (detail) ON funnel_facts`). A table-wide UPDATE would let the
application rewrite a fact's kind, its ids, its key and the instant it happened at,
which is the whole of the row; the column grant is what makes "append-only but for
the redaction" a privilege rather than a promise. The recorder never updates at all.

Nothing sweeps the table. It is business history under 10.3's first row, which
`RETENTION_TARGETS` states as the `business_records` target's `retained` no-op, and
`TABLE_RETENTION_COVERAGE` records as `['retained', 'deletion_redacts']`.
