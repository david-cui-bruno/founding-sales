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
export const CURRENT_SCHEMA_VERSION = 13;

/**
 * The range the release before this one declared. Widen this one release ahead of the
 * migration.
 *
 * Lanes G5 and G2 shipped migrations 0002 and 0003 from the same main and each widened
 * this constant for its own; lane G3a widened it again for migration 0004, G3b for
 * 0005, G4 for 0006, G10 for 0007, G6 for 0008, G7 for 0009, G7-2 for 0010 and G7b
 * for 0011. A merge that finds two different maxima takes the larger. That is honest
 * only because nothing has been deployed — G0's {1, 1} was never a promise made to a
 * running production binary. From the first real deployment onwards the widening must
 * precede the migration by a release, and the compatibility test will keep saying so.
 */
export const PREVIOUS_RELEASE_SCHEMA_RANGE: SchemaRange = { minimum: 1, maximum: 13 };

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
 * Migration 0013 (G9) is the first one that moves the two sides differently, and the
 * difference is the rule working rather than an oversight.
 *
 * The API's minimum moves to 13. `GET /settings`, `POST /settings/update` and
 * `POST /settings/history` read and write `workspace_settings`, and `GET /diagnostics`
 * reads it too. An API on a version-12 database could not answer what the postal
 * footer or the business time zone is, and — worse — `effectiveSendingEnabled` would
 * have no admin half of 16.2's two switches to read. Fail closed would make it
 * answer "sending is off" forever, which is safe and useless; refusing to start says
 * so out loud.
 *
 * The worker's minimum does **not** move past G7b's 11. Nothing in `apps/worker/src`
 * reads `workspace_settings` today: the settings a worker will want — the holiday
 * calendar for business-day delays, which G8 owns in its own table, and the
 * workspace sending attestation, whose send-path read is G12's — are read by code
 * that does not exist yet. The rule from
 * `docs/decisions/g10-worker-schema-minimum.md` is that a binary declares the lowest
 * version on which its *first statement* can succeed, not the lowest it would like,
 * and raising the worker's minimum for a table it never queries would refuse a
 * database for no reason. The lane that adds the read raises it.
 *
 * Both maxima move to 13, because a binary that refused the database it has just been
 * deployed against would be a self-inflicted outage.
 */
export const API_SCHEMA_RANGE: SchemaRange = { minimum: 13, maximum: 13 };
export const WORKER_SCHEMA_RANGE: SchemaRange = { minimum: 11, maximum: 13 };

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
