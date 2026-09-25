import type { SessionQueryable } from './queryable.ts';
import { readAppliedSchemaVersion } from './migrationRunner.ts';

/**
 * Declared schema ranges (specification 4.2: "API and worker declare accepted schema
 * ranges"; Appendix G 22: "old API with new worker and reverse across every
 * expand/contract phase obey schema ranges").
 *
 * Deployment order under expand, migrate, contract is: widen the range, ship that
 * release, then ship the migration. So PREVIOUS_RELEASE_SCHEMA_RANGE must already
 * cover the version the next migration produces, and the migration compatibility
 * test in test/db/migrations.test.ts fails the build when it does not.
 */

export interface SchemaRange {
  readonly minimum: number;
  readonly maximum: number;
}

/** The highest migration version this source tree contains. */
export const CURRENT_SCHEMA_VERSION = 17;

/**
 * The range the release before this one declared. Widen this one release ahead of the
 * migration.
 *
 * Lanes G5 and G2 shipped migrations 0002 and 0003 from the same main and each widened
 * this constant for its own; lane G3a widened it again for migration 0004, G3b for
 * 0005, G4 for 0006, G10 for 0007, G6 for 0008, G7 for 0009, G7-2 for 0010, G7b for
 * 0011, G8 for 0012, G9 for 0013, G14 for 0014 and G20 for 0015. A merge that finds
 * two different maxima takes the larger, which is what every one of those merges did.
 * That is honest only because nothing has been deployed — G0's {1, 1} was never a
 * promise made to a running production binary. From the first real deployment onwards
 * the widening must precede the migration by a release, and the compatibility test
 * will keep saying so.
 *
 * Lane g60 widened it again, for 0016, and it is the first migration after production
 * went live (23 September 2026), so the sentence above now bites and has to be answered
 * rather than repeated. The release running in production declares `{15, 15}` for both
 * services, not this constant's `{1, 16}`; no deployed binary accepts 16. What makes that
 * safe is not this constant but the release procedure: every range since 0006 is a
 * strict `{N, N}`, so a schema release is deployed with
 * `infra/scripts/release-deploy.sh … --schema-change`, which scales both services to zero
 * *before* the migration and back up on the new images after it (release.md 4.1). No
 * binary of the previous release ever meets schema 16. The compatibility test's
 * assertion below is therefore met the way G20's was, by widening, and Appendix G 22's
 * scenario keeps asserting the refusal that is the real relationship between the
 * previous images and the new schema (`test/release/scenario22.check.ts`).
 *
 * Lane g71 widened it for 0017 by the same reasoning. Production declares `{16, 16}`
 * for both services once 0016's release is deployed, no deployed binary accepts 17, and
 * the release that carries 0017 is again a `--schema-change` deploy (release.md 8.0ag).
 */
export const PREVIOUS_RELEASE_SCHEMA_RANGE: SchemaRange = { minimum: 1, maximum: 17 };

/**
 * Both services need migration 0002's shape: the API's dead-job list reads `dead_at`
 * and `requeued_count`, and the worker's claim writes `fencing_token`. A binary that
 * needs a column states so rather than starting and failing on the first statement, so
 * neither accepts a version-1 database; see docs/decisions/g5-schema-range.md.
 *
 * The API additionally needs migration 0003 — no session, device credential or
 * authorization request exists before it, so an API on a version-2 database could not
 * authenticate anybody — and migration 0004, because its CRM routes read `firms`,
 * `contacts`, `opportunities` and the default pipeline. Migration 0006 raises it
 * again: the dial, suppression, pause and call routes read `state_postures`,
 * `dial_tickets`, `effective_suppressions`, `call_logs` and `callbacks`, and an API
 * without them could answer a dial authorization only by inventing one.
 *
 * Migration 0005 (G3b) adds no column and no table — only the trigram indexes CRM
 * search is fast with and correct without — so it moved neither minimum. Migration
 * 0006 does: the worker needs it because `suppression.finalize` writes
 * `suppression_finalizations`, so the worker's minimum moved from 2 to 6 for the first
 * time in this tree. The deploy order is migrate, then worker, then API, so the worker
 * never meets an older schema; a rolling step that runs two worker versions has both
 * understanding 0006, which is what the widened previous-release range above is for
 * (Appendix G 22).
 *
 * Migration 0007 (G10) moves both again. The API's research routes read
 * `research_settings`, `research_providers`, `research_route_policies` and
 * `research_suggestions`, and the worker's two research handlers write
 * `research_pages` and `research_firm_runs` — the tables whose unique constraints
 * *are* their declared idempotency protection. A worker on a version-6 database would
 * run those handlers with no uniqueness behind them, which is the one thing a schema
 * range exists to prevent, so it refuses to start instead rather than accepting {6, 7}.
 * `docs/decisions/g10-worker-schema-minimum.md` says what that gives up.
 *
 * Migration 0008 (G6) moves both a third time, by the same rule that document states:
 * a binary declares the lowest version on which its *first statement* can succeed, not
 * the lowest it would like. The API's `/today`, `/today/firm` and `/today/snooze` read
 * and write `today_snapshots`, `today_items` and `today_snoozes`; the worker's
 * `today.build` handler calls `today_upsert_item`, and `UNIQUE(workspace_id,
 * snapshot_date, firm_id, item_key)` inside it *is* that handler's declared
 * `business_uniqueness` protection — so a worker on a version-7 database would be a
 * worker running an at-least-once handler with nothing behind it, which is exactly the
 * case G10 refused.
 *
 * Migration 0009 (G7) moves both a fourth time, and for a reason on each side rather
 * than by habit.
 *
 * The API needs it: `/gmail/connect`, `/oauth/gmail/callback`, `/gmail/disconnect`,
 * the Pub/Sub webhook and the message view read and write `mailboxes`,
 * `mailbox_tokens` and `gmail_push_notifications`. An API on a version-8 database
 * could accept a Google authorization code and then have nowhere to put the grant,
 * which is the one outcome worse than refusing the connection: the code is single-use,
 * so the salesperson would have to start again and the API would have leaked a grant
 * nobody can revoke through FSS.
 *
 * The worker needs it: `mail.sync`, `mail.recover` and `mail.watch_renew` read the
 * compare-and-set cursor and the coverage watermark on `mailboxes` and write
 * `mail_messages` and `mail_message_effects`. A worker without them could not prove
 * coverage, and a mailbox whose coverage cannot be proved must hold every automated
 * step rather than proceed (4.2) — so the honest failure is the process refusing to
 * start, which is what a minimum of 9 produces. It is also the same refusal G10 and G6
 * each made for their own tables: a `business_uniqueness` handler on a database
 * without its unique index is an at-least-once handler with nothing behind it.
 *
 * The deploy order stays migrate, then worker, then API, so neither binary meets an
 * older schema; a rolling step that runs two workers has both understanding 0009,
 * which is what the widened previous-release range above is for (Appendix G 22). Both
 * maxima move to 9: a binary that refused the database it has just been deployed
 * against would be a self-inflicted outage.
 *
 * Migration 0010 (G7-2) moves both a fifth time, and this is the one where the rule
 * bites hardest, because the table it adds is the one that makes double sending
 * impossible.
 *
 * The worker needs it beyond argument. Appendix C gives `sequence.action` and
 * `mail.reconcile` the protection `outbound_fence`, and the fence *is*
 * `outbound_messages` with its state-machine trigger. A worker on a version-9
 * database would be a worker whose declared at-most-once protection does not exist —
 * not degraded, absent — and the failure it would permit is sending the same email
 * to a prospect twice, which no later correction undoes. Refusing to start is the
 * only honest behaviour.
 *
 * The API needs it for a narrower but equally structural reason: the admin
 * resolutions of 12.5 (`unknown_terminal` marked delivered or skipped), the ramp and
 * cap commands of 12.7, and the sending-domain authentication checklist all read and
 * write tables that arrive here. An API on a version-9 database could accept an
 * admin's "mark this delivered" and have nowhere to record it, which is worse than
 * refusing: the admin would believe the sequence had been unblocked.
 *
 * Both maxima move to 10, on the same reasoning as every widening before it.
 *
 * Migration 0011 (G7b) moves both a sixth time, and again with a reason on each side.
 *
 * The API needs it: `/replies`, `/replies/card` and `/replies/confirm` read
 * `mail_message_classifications`' three new columns and write
 * `mail_reply_confirmations`, and `/replies/settings` reads `classifier_settings`.
 * An API on a version-10 database could render a reply card with no proposed
 * disposition and then accept a confirmation it had nowhere to put, which would lose
 * the one record 12.4 requires of a corrected classification.
 *
 * The worker needs it: `classify.reply` declares `business_uniqueness`, and the
 * uniqueness it means is `mail_message_classifications_one_per_layer` together with
 * the new columns the row carries. A worker on a version-10 database would be
 * running an at-least-once handler that spends money at a provider with nothing
 * behind it — the same case G10, G6 and G7 each refused for their own tables — and
 * it could not record what the call cost, which 13.4 asks for.
 *
 * The deploy order stays migrate, then worker, then API. Both maxima move to 11.
 *
 * Migration 0012 (G8) moves both a seventh time, and this lane's reasons are the
 * same two every widening before it gave.
 *
 * The API needs it: `/sequences`, `/sequences/steps`, `/sequences/publish`,
 * `/templates`, `/enrollments` and `/linkedin/*` read and write `sequences`,
 * `sequence_versions`, `sequence_steps`, `sequence_enrollments` and
 * `step_executions`, and the template routes read the five columns 0012 adds to
 * `template_versions`. An API on a version-11 database could accept an enrollment and
 * have nowhere to put it.
 *
 * The worker needs it: `sequence.action` claims a `step_executions` row, and
 * `UNIQUE (workspace_id, enrollment_id, step_id)` together with the outbound fence
 * *is* Appendix C's protection for `step-execution:{id}`. A worker on a version-11
 * database would be running an at-least-once handler with nothing behind it — the
 * case G10, G6, G7 and G7b each refused for their own tables, and the one invariant 1
 * ("no duplicate automated email for the same sequence step") rests on. 0012 also
 * adds the two foreign keys 0010 left for it, so on a version-11 database a fence
 * could name an enrollment that does not exist.
 *
 * The deploy order stays migrate, then worker, then API. Both maxima move to 12.
 *
 * Migration 0013 (G9) is the first one that moves the two sides differently, and the
 * difference is the rule working rather than an oversight.
 *
 * The API's minimum moves to 13. `GET /settings`, `POST /settings/update` and
 * `POST /settings/history` read and write `workspace_settings`, and `GET /diagnostics`
 * reads it too. An API on a version-12 database could not answer what the business
 * time zone is, and — worse — `effectiveSendingEnabled` would
 * have no admin half of 16.2's two switches to read. Fail closed would make it
 * answer "sending is off" forever, which is safe and useless; refusing to start says
 * so out loud.
 *
 * The worker's minimum does **not** move past G8's 12. Nothing in `apps/worker/src`
 * reads `workspace_settings` today. The two a worker would plausibly want are read
 * elsewhere: the holiday calendar is G8's `workspace_holiday_calendars`, which its
 * own migration raised the worker's minimum for, and the workspace sending
 * attestation's send-path read is G12's and does not exist yet. The rule from
 * `docs/decisions/g10-worker-schema-minimum.md` is that a binary declares the lowest
 * version on which its *first statement* can succeed, not the lowest it would like,
 * and raising the worker's minimum for a table it never queries would refuse a
 * database for no reason. The lane that adds the read raises it.
 *
 * Both maxima move to 13, because a binary that refused the database it has just been
 * deployed against would be a self-inflicted outage.
 *
 * G12 (release gates) raises the **worker's** minimum to 13 without adding a
 * migration, and it is the lane 0013's note above said would have to.
 *
 * 16.2's sending switch is two facts, and `decideSend` — which runs in the worker,
 * inside the dispatching transaction — now reads the second of them from
 * `workspace_settings`. So `packages/domain/outbound/gate.ts` issues a statement
 * against a table that does not exist before 0013, and a worker on a version-12
 * database would meet an `undefined_table` error at the one moment it must not: after
 * the eligibility reads and before the fence is claimed. Under the same rule G10, G6,
 * G7, G7b and G8 each applied, the binary declares the lowest version on which its
 * statements can succeed, so the minimum moves rather than the code guessing.
 *
 * Failing closed instead — treating a missing table as "not attested" — was the other
 * option and is worse: it makes a stale deployment look like an admin who has not
 * enabled sending, which is a supported state an operator would then go and "fix".
 *
 * That raise is now subsumed by 0014 below, which moves the worker past 13 anyway for
 * its own reason. The argument stands and is kept because it is why the worker may not
 * go back to {12, N}: the send gate's read of `workspace_settings` is permanent.
 *
 * Both ranges being strict is what makes Appendix G 22's "previous image against the
 * new schema" have no overlapping pair, so the scenario asserts the refusal instead.
 * See `test/release/scenario22.check.ts`.
 */
/**
 * Migration 0014 (G14) moves both again, by the same rule every paragraph above
 * applied: a binary declares the lowest version on which its *first statement* can
 * succeed, not the lowest it would like.
 *
 * **The worker's minimum moves from 12 to 14**, and the jump over 13 is the
 * interesting part. G9 left the worker at `{12, 13}` rather than `{13, 13}` because
 * migration 0013 is the dashboard and the settings history, which the worker never
 * reads — a worker that refused a version-12 database would have been refusing a
 * database it understood perfectly. That reasoning does not survive this migration.
 * `retention.batch` runs on the worker, it declares `business_uniqueness`, and the
 * uniqueness it declares is `retention_runs_one_per_period` — Appendix C's "deletion
 * tombstone and bounded range" as one constraint. A worker on a version-13 database
 * would claim no period, sweep, *delete rows*, and record nothing saying how far it
 * got; the retry would sweep again from a boundary nobody wrote down. That is an
 * at-least-once handler with nothing behind it, which is what G10, G6 and G7 each
 * refused for their own tables, and deleting rows is a worse thing to do twice than
 * inserting them.
 *
 * So the worker's range is `{14, 14}`: it skips 13 not because it needs 0013's
 * tables but because 14 is the first version on which its first retention statement
 * can succeed, and a range is a statement about that instant rather than a union of
 * the migrations a binary happens to touch.
 *
 * **The API needs it too.** `/retention/*` and `/admin/departure/*` read and write
 * `retention_policies` rows, `retention_runs`, `deletion_requests` and `departures`.
 * An API on a version-13 database could accept a deletion commit and then have
 * nowhere to record what it deleted, and an unrecorded deletion is the one outcome
 * 10.3's "every deletion and export is audited" forbids outright. Refusing the
 * connection is the honest failure.
 *
 * The deploy order stays migrate, then worker, then API, so neither binary meets an
 * older schema; a rolling step that runs two workers has both understanding 0014,
 * which is what the widened previous-release range above is for (Appendix G 22).
 */
/**
 * Migration 0015 (G20) is the first **contract** migration in this tree, and it moves
 * both minima to 15 for a reason the fourteen paragraphs above never had to give.
 *
 * Every widening so far was expansion: a lane added a table or a column, and the
 * binary that read it declared the lowest version on which its first statement could
 * succeed. 0015 removes one — `template_versions.footer_postal_address`, under
 * `docs/decisions/g20-automated-email-carries-no-postal-address.md` — so the question
 * has two halves instead of one.
 *
 * **The API's minimum moves to 15 by the usual rule.** `/templates/create` issues an
 * INSERT that no longer names `footer_postal_address`. On a version-14 database that
 * column is `NOT NULL` with no default, so the statement fails with
 * `not_null_violation`: an API that accepted a template body and then had nowhere to
 * put it. That is the same failure every paragraph above refused.
 *
 * **The worker's minimum moves to 15 too, and this one is a choice rather than an
 * arithmetic.** The worker never writes `template_versions`; it reads it through
 * `readTemplateVersion` and `templateApprovalSource`, and after this release those
 * SELECTs name only surviving columns, so a worker's first statement would in fact
 * succeed on a version-14 database. `{14, 15}` is therefore arguable and is what the
 * letter of "the lowest version on which its first statement can succeed" gives.
 *
 * It is refused because of what a span means here rather than what it permits. The
 * ranges are what `infra/scripts/rehearsal-schema-ranges.sh` runs the pairs of and
 * what `verify-schema` gates a production deploy on, and a worker declaring 14 would
 * be declaring the pre-contract database a supported deployment target for this
 * image. It is not one: on a version-14 database the API of this same release refuses
 * to start, so the only environment the declaration admits is half a deployment — a
 * worker sending mail beside an API that will not answer. `release-deploy.sh` scales
 * both services to zero, migrates, verifies and scales back up precisely so that
 * state cannot occur, and a range that admits a state the release procedure forbids
 * is a promise nobody tests. G9 left the worker behind at `{12, 13}` for a table it
 * never queried; this table it does query, and the version it queries is 15.
 *
 * **Both maxima move to 15** on the same reasoning as every widening before: a binary
 * that refused the database it has just been deployed against would be a
 * self-inflicted outage. The previous release's binaries declared 14, so no pair
 * overlaps and Appendix G 22 asserts the refusal rather than a compatibility that
 * does not exist — `database_ahead_of_binary` for the old images against the new
 * schema, which is correct: their SELECTs name a column that is gone.
 */
/**
 * Migration 0016 (g60) moves both to 16, and it is expansion again: six nullable columns
 * on `calling_identities` and the constraints that make a `verified` row say who
 * verified it, how and when.
 *
 * **The API's minimum moves by the usual rule.** `POST /calling-identities/register`,
 * `/attest` and `/disable` write `label`, `verified_at`, `verified_by_user_id`,
 * `verification_method`, `disabled_at` and `disabled_by_user_id`, and
 * `GET /calling-identities` selects them. On a version-15 database each of those
 * statements fails with `undefined_column`: a salesperson who typed their number and
 * pressed Attest would be told nothing was recorded, and would have no Call button
 * afterwards either.
 *
 * **The worker's minimum moves by G20's rule rather than by arithmetic.** The worker
 * service never reads the new columns; its statements would succeed on 15. `{15, 16}`
 * is what "the lowest version on which its first statement can succeed" gives, and it
 * is refused for the reason 0015's paragraph above states: a range is what
 * `rehearsal-schema-ranges.sh` runs the pairs of and what `verify-schema` gates a
 * production deploy on, and on a version-15 database this release's API refuses to
 * start, so a worker declaring 15 would admit only half a deployment — the state
 * `release-deploy.sh --schema-change` exists to prevent. The `fss` tool in the worker
 * image does write the new columns (the drill seed attests the rehearsal admin's number
 * through the domain functions), and it runs only after `fss migrate` has.
 *
 * **Both maxima move to 16** on the same reasoning as every widening before. The
 * previous release's binaries declared `{15, 15}`, so no pair overlaps and Appendix
 * G 22 asserts `database_ahead_of_binary` for the old images against the new schema.
 * The production deploy is therefore the stop-migrate-start path: apply with both
 * ranges at `{16, 16}` and the new digests, then `release-deploy.sh infra/roots/production
 * fss-prod --schema-change` (release.md 8.0ab).
 */
/**
 * Migration 0017 (g71) moves both to 17, and this time **both by the usual rule**: each
 * service's own first statement against the new table fails on 16.
 *
 * **The API** reads `release_records` when an admin saves `sending_enabled` with
 * `enabled: true`: the enable is refused unless the attested reference is a stored,
 * passing record whose API digest is the running API's own. `GET /settings` and
 * `GET /diagnostics` read it too, to say whether the attestation binds to this
 * deployment. On a version-16 database each of those statements fails with
 * `undefined_table`, which would turn an admin's enable into a 500 rather than a
 * refusal that names why.
 *
 * **The worker** reads it in `decideSend`, inside the dispatching transaction, before
 * every automated send: the attested record must pass and name this worker's own
 * image digest. That is the same position G12 was in with `workspace_settings` — a
 * statement against a table that does not exist, at the one moment it must not fail —
 * and it is answered the same way: the minimum moves rather than the gate guessing.
 * Treating a missing table as "not attested" would make a stale deployment look like
 * an admin who has not enabled sending.
 *
 * **Both maxima move to 17** on the same reasoning as every widening before. The
 * previous release's binaries declared `{16, 16}`, so no pair overlaps and Appendix
 * G 22 asserts `database_ahead_of_binary` for the old images against the new schema.
 * The production deploy is therefore the stop-migrate-start path again: apply with
 * both ranges at `{17, 17}` and the new digests, then `release-deploy.sh
 * infra/roots/production fss-prod --schema-change` (release.md 8.0ag).
 */
export const API_SCHEMA_RANGE: SchemaRange = { minimum: 17, maximum: 17 };
export const WORKER_SCHEMA_RANGE: SchemaRange = { minimum: 17, maximum: 17 };

export function acceptsSchemaVersion(range: SchemaRange, version: number): boolean {
  return Number.isInteger(version) && version >= range.minimum && version <= range.maximum;
}

export type SchemaRangeCheck =
  | { readonly accepted: true; readonly version: number; readonly range: SchemaRange }
  | {
      readonly accepted: false;
      readonly version: number;
      readonly range: SchemaRange;
      readonly reason: 'database_behind_binary' | 'database_ahead_of_binary';
    };

/**
 * Compare the database's applied schema version with a declared range. Fails closed:
 * an unmigrated database (version 0) is `database_behind_binary`, never "probably fine".
 */
export async function checkSchemaRange(session: SessionQueryable, range: SchemaRange): Promise<SchemaRangeCheck> {
  const version = await readAppliedSchemaVersion(session);
  if (acceptsSchemaVersion(range, version)) return { accepted: true, version, range };
  return {
    accepted: false,
    version,
    range,
    reason: version < range.minimum ? 'database_behind_binary' : 'database_ahead_of_binary',
  };
}

/**
 * The current system generation (Appendix E).
 *
 * Null, not zero, when the table does not exist yet or has no row: a database the
 * foundation migration has not reached has no generation, and saying "0" would let a
 * caller compare it with an operator's expected generation as though it were one.
 */
export async function readSystemGeneration(session: SessionQueryable): Promise<number | null> {
  const present = await session.query<{ present: boolean }>(
    "SELECT to_regclass('public.system_generations') IS NOT NULL AS present",
  );
  if (present.rows[0]?.present !== true) return null;
  const { rows } = await session.query<{ generation: string | null }>(
    'SELECT max(generation)::text AS generation FROM system_generations',
  );
  const value = rows[0]?.generation;
  return value === null || value === undefined ? null : Number(value);
}
