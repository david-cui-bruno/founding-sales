# Retention, deletion and departure

Specification revision 3, section 10.3, Appendix C, Appendix F and Appendix G
scenario 41. This is what FSS keeps, for how long, what removes it, and what is
still there afterwards.

## The shape

```
packages/domain/retention/
  kinds.ts         the 10.3 vocabulary, the ledger's superset, the period rule
  policies.ts      reading retention_policies; the boundary PostgreSQL computes
  targets.ts       one RetentionTarget per kind, and the declared-pending guard
  coverage.ts      what happens to every table in the schema
  runs.ts          claim the period, sweep, complete the ledger row
  handler.ts       the retention.batch job
  deletion.ts      preview and commit of the admin deletion workflow
  departure.ts     the departure command
  attachments.ts   metadata and the authorized open-in-Gmail link
  result.ts        the two-field outcome every command answers with

apps/worker/src/handlers/retention.ts   registration and the due-work source
apps/api/src/routes/retention.ts        /retention/*
apps/api/src/routes/departure.ts        /admin/departure/*
apps/api/src/routes/retentionAttachments.ts  /attachments/open
```

## The table, as rows

Migration 0014 seeds `retention_policies` for every workspace — through a trigger
for new ones and a backfill for those that already existed — with the ten rows of
section 10.3:

| Kind | Disposition | Interval | Who enforces it |
|---|---|---:|---|
| `business_records` | `retain_indefinitely` | — | the deletion workflow, on request |
| `suppression_history` | `retain_indefinitely` | — | revoked `DELETE` on `suppression_events` |
| `audit_events` | `delete` | 7 years | nothing in this repository; see the decision |
| `research_evidence` | `retain_with_business_record` | — | per item, from the provider's terms |
| `unmatched_gmail_metadata` | `delete` | 30 days | `retention.batch` |
| `raw_mime` | `delete` | 7 days | `retention.batch` |
| `matched_message_body` | `retain_with_business_record` | — | the firm record's horizon |
| `canceled_drafts` | `delete` | 30 days | `retention.batch`, by redaction |
| `operational_logs` | `delete` | 90 days | the CloudWatch log group |
| `database_backups` | `delete` | 35 days | the RDS instance |

A workspace with no policy row for a kind sweeps nothing and the ledger says
`no_policy`. A retention job never invents a horizon.

Two of the sweeps redact rather than delete, and both because another lane revoked
`DELETE` on purpose. A completed job's payload is emptied and its row and dedupe key
stay (13.2). A held, never-dispatched draft fence has its rendered subject and body
cleared and the fence stays, because the fence *is* the at-most-once guarantee of
12.5 and a row that could be deleted is an origin that could be given a second one.

## The job

Appendix C: `retention.batch`, keyed `retention:{kind}:{period}`, protected by
"deletion tombstone and bounded range".

`retention_runs` is both halves of that protection. The row is the tombstone —
`UNIQUE(workspace_id, data_kind, period)`, claimed *before* the sweep — and
`boundary_at` is the range it swept to. A second worker, a replayed job or a worker
whose lease was stolen all find the period claimed, sweep nothing, and report the
ledger. `apps/worker/test/retention.test.ts` proves it under a real stolen lease
rather than by calling the handler twice.

The period is the **UTC calendar day**, not a workspace business date. A Today
snapshot is about a person's working day; a horizon is about how long data has
existed, and a workspace that changed its business zone must not re-run or skip a
day's retention.

The scheduler materializes one job per workspace per kind per day — all eleven
kinds, including the ones that sweep nothing. Eleven rows a workspace a day is the
cheapest available proof of a negative: a kind with no ledger rows is
indistinguishable from a kind whose job has been failing quietly for a month.

## The target registry

`RETENTION_TARGETS` has one entry per kind, in one of four states:

| State | Meaning |
|---|---|
| `implemented` | this lane sweeps it |
| `retained` | 10.3 keeps it; the job proves a no-op |
| `external` | CloudWatch or RDS enforces it |
| `declared_pending` | the table belongs to a lane still in flight |

Two guards keep the registry honest, and both are tests rather than notes.

`PENDING_RETENTION_TABLES` names the tables in-flight lanes will bring — G7b's two
classifier tables, G8's ten sequence tables, G9's workspace settings — and what each
will owe. The test asks the live catalog for each one and fails the build the moment
it exists. The follow-up cannot be forgotten because the build stops when it becomes
possible.

One entry owes something that is not about its own rows. G9's `workspace_settings`
arriving means 0013 is on main, which means every lane touching the closed
suppression vocabulary has landed — and that is the moment the deletion tombstone's
borrowed `prospect_opt_out` source is replaced by its own `deletion_tombstone`. The
guard is what remembers it; see `docs/decisions/g14-deletion-tombstone-source.md`.

It has already been paid once. `canceled_drafts` shipped as `declared_pending`
against G7-2's `outbound_messages`; when that lane merged, the guard failed, and the
target was written in the same session. That is the mechanism working rather than a
story about it.

`TABLE_RETENTION_COVERAGE` catches what that list could not: it classifies *every*
table PostgreSQL reports, and the test fails when one is missing. A lane adding a
table has to say what section 10.3 does with its rows before the gate goes green.

## Deletion

`POST /retention/deletions/preview` then `POST /retention/deletions/commit`, both
admin-only, both `runCommand`s with receipts.

The preview counts what a commit would remove, what it would redact and what it
would retain, and returns the normalized handles it would suppress. It stores the
counts and **not** the handles: a deletion record that quoted them would keep a copy
of what it deleted. The commit presents the hash the preview returned; a world that
has changed since makes the recomputed hash disagree and the commit is refused.

What a commit does:

* **removes** `email_addresses`, `phone_routes`, the firm's `mail_messages` and
  everything cascading from them, `evidence_items`, `call_logs`, `callbacks`,
  `dial_tickets`, `today_items`, `today_snoozes`, `record_aliases`,
  `research_suggestions` and `firm_locations`;
* **redacts** `contacts` and, for a firm deletion, `firms` — the name becomes
  `[deleted]` and the identifying fields become null;
* **retains** `opportunities`, `opportunity_stage_events`, `record_merge_events`,
  `crm_domain_events`, `audit_events` and `suppression_events`;
* **inserts** one handle-scoped suppression tombstone per removed handle, and a
  firm-scoped one for a firm deletion, each journalled before its row — carrying
  `prospect_opt_out` as an interim source until 0014 adds `deletion_tombstone`;
* **audits** itself as `deletion.committed`.

Redaction rather than deletion for the two tables is not a compromise; it is what
the append-only privileges require. See
`docs/decisions/g14-deletion-is-remove-and-redact.md`.

## Departure

`POST /admin/departure/preview` then `POST /admin/departure/commit`, admin-only,
never self, never the last active admin.

The commit revokes the membership, the devices, the sessions and the device refresh
credentials; cancels the Gmail watch and disconnects the mailbox; **deletes**
`mailbox_tokens`, which is the envelope-encrypted refresh token and the one
irreversible removal in the list; and opens a `reassignment` hold on every firm the
departed member still owns.

It deletes nothing else. The mailbox row stays because the firm's correspondence
hangs off it, the firms stay assigned so an admin can see whose work needs a new
owner, and the business history is untouched. `departures_one_per_user` makes a
second command report the first rather than revoke twice.

`POST /admin/memberships/deactivate` still exists and still does its four
revocations. This is the complete version; the two are not merged because
deactivating a membership and a person leaving Callie are different events, and only
one of them is irreversible.

## Attachments

`POST /attachments/open` returns filename, media type, size, content hash when Gmail
supplied one, and a URL that opens the original message in the mailbox it arrived
in. No byte of the file enters this system, and 10.3 says none ever will.

The authorization — assigned salesperson, mailbox owner, or admin — is the only
control on who learns that a file exists and what it is called. Gmail decides
separately whether they can open it. An admin read writes an `attachment.viewed`
audit event naming the message and never the filename.

Four assertions keep "no code path stores attachment bytes" true rather than
believed: the schema has one `bytea` column in the whole database and it is the
refresh-token envelope; `mail_messages.attachment_references` is `jsonb`; no source
file names the Gmail method that returns bytes; and the `GmailClient` port has no
method a caller could use to ask for them.

## Adding a retention target

1. Add the kind to `retention_policies`' CHECK and to `RETENTION_LEDGER_KINDS` if it
   is new; most of the time it already exists and is `declared_pending`.
2. Write the sweep, bounded by `RETENTION_BATCH_LIMIT` and by the policy's boundary.
3. Move the target to `implemented` and remove its row from
   `PENDING_RETENTION_TABLES`.
4. Add the table to `TABLE_RETENTION_COVERAGE` if it is new.
5. Add a case to `packages/domain/test/retention/scenario41.test.ts` that seeds a row
   on each side of the boundary. A sweep that takes the fresh row is as wrong as one
   that leaves the expired row.
6. `npm run gate:greenfield`.
