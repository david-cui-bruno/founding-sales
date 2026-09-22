# The CRM: firms, contacts, routes, pipeline and merges

Specification revision 3, sections 7.2, 7.3, 8.1, 9.1 and 9.2, and Appendix F,
Appendix A and Appendix G 7, 8 and 37. This is the shape of the business data and the
rules that govern changing it.

## The short version

A firm has at most one assigned salesperson and at most one open opportunity. A
salesperson may change only their assigned firms, and the check happens under the
firm's row lock so a reassignment cannot be overtaken. A contact belongs to a firm and
may be its one active primary. A phone number or an email address is a *route*: it
belongs to a contact or to the firm, it carries where it came from and how confident
that association is, and it is only `usable` when a versioned policy says so. Stage
changes are append-only history. Merges preserve everything and refuse to choose
between two canonical values.

## Where everything is

```
packages/domain/db/migrations/0004_crm.sql   the tables, keys and constraints
packages/domain/crm/types.ts                 refusal codes, results, row shapes
packages/domain/crm/authorization.ts         who may change a firm, who may read what
packages/domain/crm/firms.ts                 create, update, reassign, resolve zone
packages/domain/crm/contacts.ts              create, update, the one active primary
packages/domain/crm/routes.ts                add, verify, retire; the version rule
packages/domain/crm/routePolicy.ts           the versioned eligibility thresholds
packages/domain/crm/zone.ts                  the postal source behind G0's zone seam
packages/domain/crm/evidence.ts              research evidence, idempotent per result
packages/domain/crm/pipeline.ts              stages, stage changes, close, reopen
packages/domain/crm/merges.ts                firm and contact merges
packages/domain/crm/events.ts                the outbox later lanes subscribe to
packages/domain/crm/dto.ts                   Appendix F's two firm DTOs
packages/contracts/src/crm.ts                the wire contract
apps/api/src/routes/{firms,contacts,opportunities,pipeline,merges}.ts
apps/api/src/routes/crmSupport.ts            what the five route modules share
```

## The three rules a reader should carry

### 1. Lock, then decide, then write

Every mutating command does this, in this order:

```ts
const firm = await loadFirmForUpdate(context, firmId);   // SELECT ... FOR UPDATE
if (firm === null) return refuse('firm_unknown');
const decision = decideFirmMutation(context, firm);
if (!decision.permitted) return refuse(decision.reason);
// ... write
```

There is no unlocked loader a mutation could reach for by accident. That ordering is
the whole of Appendix G 7's hardest clause — "every mutation and sensitive read by the
other is refused, **including concurrent reassignment**". A command that read the
assignee before taking the lock could be overtaken by a reassignment and slip one more
mutation in. With the lock, the former owner's command waits for the reassignment to
commit, reads the assignee it left, and is refused.

`decideFirmMutation` also refuses a merged firm first, before it considers assignment:
the record is history, and the caller should be told that rather than sent to find out
who owns something that no longer exists.

### 2. A refusal is a value, not an exception

Every command returns `CrmResult<T>`: `{ ok: true, value }` or `{ ok: false, reason }`
with a code from the closed set in `@fss/contracts`. Nothing throws for a refusal, for
a reason that is specific to how commands work here: `runCommand` writes the command
receipt **in the same transaction as the mutation**, so a command that threw would
roll its own receipt back, and the client's retry would find the id free and try
again. A refusal has to be a value so the receipt records it.

The same reasoning is why constraints are checked in the code as well as in the
database. `opportunities_lost_needs_reason` is the guarantee; `changeStage` refusing
`lost_reason_required` before writing anything is what lets the person see why.

### 3. Two DTOs, not one DTO and a filter

Appendix F gives firms two visibility classes, and there are two types:

| | Any active member | Assigned salesperson or admin |
|---|:---:|:---:|
| Firm identity, stage, control mode, zone | `FirmIdentityDto` | `FirmDetailDto` |
| Address, contacts, routes, aliases | | `FirmDetailDto` |

`FirmIdentityDto` has no field a note, a body or an address could occupy, and its Zod
schema is strict. So the slice that adds notes adds them to `FirmDetailDto` and
*cannot* leak them into the read a colleague gets, even by forgetting. A single type
with a filter would only have been one forgotten line away from doing so.

An admin reading a firm they are not the assignee of writes an access audit event
(5.2). That decision lives in `firmReadIsAudited`, beside the DTO, so a read that
arrives through an export or a job inherits it.

## The schema, table by table

### `firms`

Assignee is nullable with a `MATCH SIMPLE` composite foreign key, so a discovered firm
starts unassigned and an assigned one cannot point at a membership in another
workspace.

The four zone columns are the record of section 9.2's versioned source rule, and the
CHECKs admit exactly the two shapes `resolveFirmZone` produces:

* a zone, with `time_zone_confidence`, `time_zone_source` and `time_zone_rule_version`;
* no zone, with `time_zone_unresolved_reason` and the rule version.

Never both, and never a zone without the provenance that produced it. A firm with
neither has not been through the rule; `authorizeDial` (G4) refuses that firm for the
same reason it refuses an unresolved one.

### `contacts`, `opportunities`, and the semantic composite keys

Section 7.2 asks for `(workspace_id, contact_id, firm_id)` and `(workspace_id,
opportunity_id, firm_id)` so "an enrollment cannot mix firms". Both are real unique
constraints, and children reference them rather than `(workspace_id, id)` — so a route
at firm B naming a contact at firm A is refused by the database.

Those references are `ON UPDATE CASCADE`. A firm merge moves a contact and an
opportunity to another firm, and every child's copy of `firm_id` has to move with it —
including rows in the append-only tables, which no application role may `UPDATE` and
which therefore could not be moved any other way.

One active primary contact per firm and one open opportunity per firm are partial
unique indexes, so zero is legal and two is not.

### `phone_routes` and `email_addresses`

Same shape, same rules, two tables because an E.164 number and a lower-cased address
have different CHECKs.

`version` is the number section 9.1 says the card displays and `authorizeDial`
compares against, "preventing a stale client from dialing a replaced or retired
number". Every change of eligibility bumps it, and a `BEFORE UPDATE` trigger refuses a
version that goes down or an eligibility change that forgot to bump.

Eligibility is the policy's decision, never the caller's. `decideRouteEligibility`
(`routePolicy.ts`, version `route-policy.1`) requires passed technical validation and
either an association confidence at or above 0.8 or a source the salesperson vouched
for. The database refuses a `usable` route that cannot say why: no passed validation,
no recorded confidence, or no policy version.

The same address at two firms stays two rows. Uniqueness is per *association*
— `(workspace, firm, contact, value)` with `NULLS NOT DISTINCT` so a firm-level route
collides with another firm-level route at the same firm.

### `pipeline_stages`

Seven seeded rows per workspace: New, Contacting, Engaged, Qualified, Proposal, Won,
Lost. Seeding is a trigger on `workspaces`, plus a backfill in the migration for the
workspaces that already existed, because a workspace without a pipeline is a workspace
no opportunity can exist in. One Won and one Lost per workspace, and a terminal stage
can never be retired.

The position uniqueness is `DEFERRABLE INITIALLY IMMEDIATE`, so a reorder can
`SET CONSTRAINTS pipeline_stages_position_unique DEFERRED` and shuffle rows through
each other's positions inside one transaction, while an ordinary duplicate is still
refused by the statement that caused it.

### `crm_domain_events` — the outbox

The hook the later lanes subscribe to. A row is written in the same transaction as the
business change, deduplicated by `(workspace_id, event_kind, dedupe_key)`, and
append-only by privilege.

| Kind | Who reads it | What it means |
|---|---|---|
| `opportunity.terminal_stop` | `sequence.terminal_stop` (G15) | Won or Lost: stop every active enrollment for the opportunity |
| `opportunity.manual_mode` | `sequence.terminal_stop` (G15) | The opportunity is manual; every active enrollment **of the firm** ends terminally (7.3), with the end reason the event's `detail.origin` names (G22) |
| `opportunity.reopened` | G8 sequences | An explicit reopen; the old sequence never resumes |
| `firm.reassigned` | Today (8.2) | Transfer unfinished entries to the new assignee |
| `firm.merged`, `contact.merged` | search (G3b) | Reindex the target |
| `route.retired` | G4 dial | A card holding the old version must not dial |

Why not a `jobs` row: Appendix C's job kinds are a closed set the queue owns, no
handler was registered for any of these when the table was written, and a job nobody
handles becomes a dead job and then a critical alert. See
`docs/decisions/g3a-domain-event-outbox.md`, whose "what would change this" paragraph
predicted the job kind that now drains the first two rows —
`sequence.terminal_stop`, in `apps/worker/src/handlers/terminalStop.ts`. The table did
not change; it gained a reader (lane G15,
`docs/decisions/g15-the-worker-drains-what-the-lanes-left.md`).

## Reassignment (Appendix A)

`reassignFirm` is admin-only and commits four things together: the assignee change, an
`active_holds` row with reason `reassignment` blocking every automated action kind for
the firm, the `firm.reassigned` signal, and the audit event. Enrollments, fences and
Today entries do not exist yet; the hold is what stops automated work in the meantime,
and the signal is what the lanes that own them will act on. Dispatching mail staying
with the former owner's mailbox is G6's, as Appendix A says.

## Merges (Appendix G 37)

Nothing is deleted. The source keeps its row with `status = 'merged'` and a pointer at
the target; its children re-point; its canonical name and website become aliases of the
target; its external ids move with `record_aliases`.

Suppressions are re-asserted rather than moved. `suppression_events` is insert-only by
privilege (10.2), so a firm-scoped event on the source cannot be updated to name the
target. A *new* event is inserted for the target with a deterministic id derived from
the original, so replaying the merge inserts nothing twice. Handle suppressions need no
work: section 10.2 makes them global across the workspace, so they already cover the
target.

Conflicts refuse. If both records carry a different website, the merge stops and names
the field, and the API returns the list so a person can post again with `resolutions`.
Picking one silently is how a merge loses a canonical value nobody meant to lose.

A row whose twin already exists on the target — the same number at the same contact,
the same provider result — stays on the source rather than being deleted or
overwriting the target's. The source is a merged record, not a deleted one, so its
retrieval time and its verification survive there.

Two contacts merge only if they are already at the same firm; `merge_cross_firm` is a
refusal rather than a cascade, because moving a person between firms is what the
semantic key exists to prevent. Merge the firms first.

The merge takes the source firm's row lock before anything else, which is what makes
it correct "under concurrent research enrichment": an uncommitted `INSERT` into a child
table already holds `FOR KEY SHARE` on that row, so the merge either waits and carries
the enrichment over, or the enrichment lands after the merge on a firm the next command
refuses as `firm_merged`.

## What is deliberately not here

* **Search, filters, CSV import and export** — lane G3b, and they are here now:
  `docs/greenfield/crm-surface.md`.
* **Stage administration** (rename, reorder, add, retire) — *owned and built*, by lane
  G9, which this note predates. All four verbs of 8.1's "Admins may rename, reorder,
  add, or retire nonterminal stages" are functions in
  `packages/domain/crm/stageAdmin.ts` behind admin-only routes in
  `apps/api/src/routes/pipeline.ts`, and the adjective is enforced: no command touches
  a terminal stage, because `changeStage` finds Won and Lost by `terminal_kind` and a
  workspace that had renamed or retired one would have closed opportunities nobody can
  create (`docs/decisions/g9-terminal-stages-are-not-administrable.md`). Positions stay
  contiguous from 1 with the terminal stages last after every command. The note said
  "still unowned" until lane G15's documentation sweep found it stale.
* **Suppression and dial authorization** — lane G4. This lane records the route
  eligibility and the firm zone that `authorizeDial` reads.
* **Enrollments, executions and outbound fences** — lane G8. This lane raises the
  terminal-stop signal, G8 wrote the subscriber, and G15 is what calls it: the
  `sequence.terminal_stop` job drains `opportunity.terminal_stop` and
  `opportunity.manual_mode` every pass that finds either outstanding. Lane G22 moved
  the *confirmed reply's* stop into the confirmation's own transaction, which is where
  7.3 and Appendix A put it, and left the drain as the net for the other origins.

### The manual-mode origin (7.3, lane G22)

`setManualControlMode` takes a required `origin`, one of `MANUAL_MODE_ORIGINS` in
`packages/domain/crm/events.ts`, and writes it into `crm_domain_events.detail.origin`
beside the free-text reason. It is the fact the terminal-stop consumer turns into an
`end_reason`, and it is required rather than defaulted so a new caller has to say which
of 7.3's ways in it is.

| Origin | Written by | End reason |
|---|---|---|
| `human_reply` | `confirmReplyDisposition`, `resolveAmbiguity` when the reply is human | `human_reply` |
| `linkedin_reply` | `recordLinkedInResult` | `linkedin_reply` |
| `engaged_call` | `logCallOutcome` | `engaged_call` |
| `direct_send` | `applyDirectSendEffects` | `direct_send` |
| `salesperson_command` | `POST /opportunities/manual` | `admin_stop` |

`salesperson_command` is a fifth member 7.3 does not list, because an explicit switch
is a person inside the workspace deciding rather than a prospect signal, and the
enrollment vocabulary reserves its first five members for prospect signals.

An event written before G22 carries no origin, and `manualModeEndReason` reads that —
and any origin it does not recognise — as `human_reply`, which is exactly what lane G15
recorded for all of them. Nothing that reads the old rows changes its answer.
* **Notes, callbacks and message bodies** — they belong in `FirmDetailDto` when their
  lane arrives; the visibility decision that will govern them already exists.

## Running the tests

```
npm run gate:greenfield
npm run test --workspace packages/domain -- test/crm/commands.test.ts   # G 7 and G 37
npm run test --workspace packages/domain -- test/db/crm.test.ts         # the schema
npm run test --workspace apps/api -- test/crm.test.ts                   # the routes
```

`test/db/constraints.test.ts` has a failing insert for every one of migration 0004's
constraints, and its coverage test fails the build if a future migration adds one
without a case.
