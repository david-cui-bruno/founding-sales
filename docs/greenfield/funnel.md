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
convention: a later change cannot leak a name by forgetting to strip one. The `detail`
column is bounded at 4 000 characters and checked to be an object, so it cannot
quietly become somewhere a message body is kept.

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

## The dedupe rule

`UNIQUE (workspace_id, kind, dedupe_key)`, named `funnel_facts_dedupe`.

**The key is the ids that identify the thing, never a timestamp.** A replayed command
or a re-run handler produces one fact. A key with a clock in it would produce two,
and the second would be indistinguishable from a real second event.

`recordFunnelFact` inserts `ON CONFLICT ON CONSTRAINT funnel_facts_dedupe DO NOTHING`
and answers `{ recorded: false, reason: 'duplicate' }`. It never throws for a
duplicate: a unique violation would abort the transaction the caller is replaying
inside, which is the bug this shape exists to prevent. A kind or a source of the
wrong shape is refused *before* the insert, for the same reason — `invalid_kind` and
`invalid_source` leave the caller's transaction alive.

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
"Deletion"). `DELETE` and `TRUNCATE` are revoked from both application roles, so the
row could not go even if the workflow wanted it to — and it should not: the ids in it
point at rows the same deletion redacted rather than removed. `UPDATE` is granted for
exactly that one writer; the recorder never updates.

Nothing sweeps the table. It is business history under 10.3's first row, which
`RETENTION_TARGETS` states as the `business_records` target's `retained` no-op, and
`TABLE_RETENTION_COVERAGE` records as `['retained', 'deletion_redacts']`.
