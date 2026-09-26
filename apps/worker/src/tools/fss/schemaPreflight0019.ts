import { readAppliedSchemaVersion } from '@fss/domain/db/migrationRunner.ts';
import { type SessionQueryable } from '@fss/domain/db/queryable.ts';
import type { AdminInvocation, AdminOutcome } from './admin.ts';

/**
 * `fss admin schema-preflight 0019`: migration 0019's counts, read before the release
 * stops anything (lane W2-M).
 *
 * `packages/domain/db/migrations/0019_wave2_cleanup.sql` destroys research's eight
 * tables, archives `record_merge_events` into `audit_events` and drops it, drops
 * `direct_sent`, the guard columns, the retired settings rows and the two dead reason
 * codes, and relaxes the edit-in-place triggers and four CHECKs. It **refuses** (FS019)
 * when a LinkedIn marker or an audited enrollment migration it would drop is still
 * stored, or when research's data tables hold a row — its seeded configuration is
 * dropped without asking. `infra/scripts/schema-preflight-0019.sh` runs this on the
 * operations task as the runtime identity, so the coordinator sees every count — and
 * whether the migration would refuse — while both services are still running; it exits
 * 3 when `refuses` is true.
 *
 * Read-only: a READ ONLY transaction, rolled back. On any schema but 18 it refuses,
 * because there is nothing to decide: before 18 the release is not this one, after it
 * 0019 has run.
 */

export const SCHEMA_PREFLIGHT_0019_MIGRATION = 19;

/**
 * The three tables `seed_research_configuration` fills for every workspace (migration
 * 0007). Their rows are configuration nobody wrote, and 0019 drops them without asking.
 */
export const RESEARCH_SEED_TABLES = ['research_settings', 'research_providers', 'research_route_policies'] as const;

/**
 * The five tables that hold what research did: spend, fetched pages, firm coordinates,
 * runs and suggestions. A row in any of them is real data, and 0019 refuses (FS019)
 * rather than drop it.
 */
export const RESEARCH_DATA_TABLES = [
  'research_provider_ledger',
  'research_pages',
  'firm_locations',
  'research_firm_runs',
  'research_suggestions',
] as const;

/** The eight tables migration 0007 created and 0019 drops. */
export const RESEARCH_TABLES = [...RESEARCH_SEED_TABLES, ...RESEARCH_DATA_TABLES] as const;

/** The placeholder W2-S stores for a snooze with no reason (`packages/domain/today/snooze.ts`). */
const SNOOZE_PLACEHOLDER = 'snoozed';

const referencesTo = (code: string): string => `(
    (SELECT count(*) FROM active_holds WHERE reason_code = '${code}')
  + (SELECT count(*) FROM administrative_pauses WHERE reason_code = '${code}')
  + (SELECT count(*) FROM crm_domain_events WHERE reason_code = '${code}')
  + (SELECT count(*) FROM step_executions WHERE hold_reason_code = '${code}'))::integer`;

/**
 * One row, one column per count. Runs on schema 18 only: on 19 half of what it reads is
 * gone, which is the point of the migration. The blocking counts are the same
 * predicates as 0019's refusal block, so the two cannot disagree about a row.
 */
export const SCHEMA_PREFLIGHT_0019_SQL = `
SELECT
  ${RESEARCH_TABLES.map(table => `(SELECT count(*) FROM ${table})::integer AS ${table}`).join(',\n  ')},
  (SELECT count(*) FROM record_merge_events)::integer AS record_merge_events,
  (SELECT count(*) FROM mailbox_send_days WHERE direct_sent <> 0)::integer AS direct_sent_days,
  (SELECT coalesce(sum(direct_sent), 0) FROM mailbox_send_days)::integer AS direct_sent_total,
  (SELECT count(*) FROM sending_domains
    WHERE personal_gmail_guard_per_24h <> 4000 OR reply_only_opt_out IS DISTINCT FROM true)::integer AS guard_columns_changed,
  (SELECT count(*) FROM workspace_settings WHERE setting_key = 'alert_thresholds')::integer AS alert_thresholds_rows,
  (SELECT count(*) FROM workspace_settings WHERE setting_key = 'client_version_range')::integer AS client_version_range_rows,
  ${referencesTo('domain_cap')} AS domain_cap_references,
  ${referencesTo('dead_job')} AS dead_job_references,
  (SELECT count(*) FROM sequence_steps WHERE channel = 'linkedin_task')::integer AS linkedin_steps,
  (SELECT count(*) FROM step_executions WHERE channel = 'linkedin_task')::integer AS linkedin_executions,
  (SELECT count(*) FROM step_executions WHERE completion_source = 'removed' OR result = 'removed')::integer AS removed_executions,
  (SELECT count(*) FROM step_execution_shifts WHERE reason = 'removed')::integer AS removed_shifts,
  (SELECT count(*) FROM active_holds WHERE 'removed' = ANY (blocked_action_kinds))::integer AS removed_holds,
  (SELECT count(*) FROM administrative_pauses WHERE channel = 'removed')::integer AS removed_pauses,
  (SELECT count(*) FROM enrollment_migrations)::integer AS enrollment_migrations,
  (SELECT count(*) FROM enrollment_migration_items)::integer AS enrollment_migration_items,
  (SELECT count(*) FROM step_execution_shifts WHERE reason = 'migration')::integer AS migration_shifts,
  (SELECT count(*) FROM sequence_enrollments WHERE end_reason = 'migration_superseded')::integer AS migration_superseded,
  (SELECT count(*) FROM sequence_enrollments WHERE migration_paused_at IS NOT NULL)::integer AS migration_paused,
  (SELECT count(*) FROM today_snoozes)::integer AS snoozes,
  (SELECT count(*) FROM today_snoozes WHERE reason = '${SNOOZE_PLACEHOLDER}')::integer AS snoozes_with_placeholder_reason,
  (SELECT count(*) FROM phone_routes WHERE eligibility = 'usable')::integer AS usable_phone_routes,
  (SELECT count(*) FROM calling_identities WHERE verification_status = 'verified' OR enabled)::integer AS attested_calling_identities,
  (SELECT count(*) FROM state_postures)::integer AS state_postures,
  (SELECT count(*) FROM template_versions WHERE approved_at IS NOT NULL)::integer AS approved_templates,
  (SELECT count(*) FROM sequence_versions WHERE state = 'published')::integer AS published_versions,
  (SELECT count(*) FROM sequence_enrollments WHERE state = 'review_required')::integer AS review_required_enrollments
`;

/** What 0019 refuses on. Any non-zero count raises FS019 and leaves schema 18 as it was. */
export interface Preflight0019Blocking {
  readonly linkedInSteps: number;
  readonly linkedInExecutions: number;
  readonly removedExecutions: number;
  readonly removedShifts: number;
  readonly removedHolds: number;
  readonly removedPauses: number;
  readonly enrollmentMigrations: number;
  readonly enrollmentMigrationItems: number;
  readonly migrationShifts: number;
  readonly migrationSuperseded: number;
  readonly migrationPaused: number;
  /** Research's data, one count per table (`RESEARCH_DATA_TABLES`). Its seeded configuration is not here. */
  readonly researchProviderLedger: number;
  readonly researchPages: number;
  readonly firmLocations: number;
  readonly researchFirmRuns: number;
  readonly researchSuggestions: number;
}

/** What 0019 destroys without asking. */
export interface Preflight0019Destroyed {
  /**
   * Rows in each seeded configuration table (`RESEARCH_SEED_TABLES`), dropped without
   * asking. Research's data tables are counted under `blocking`, because a row in any of
   * them makes 0019 refuse.
   */
  readonly researchSeed: Readonly<Record<(typeof RESEARCH_SEED_TABLES)[number], number>>;
  /** Mailbox days whose `direct_sent` is not zero, and the sum the column held. */
  readonly directSentDays: number;
  readonly directSentTotal: number;
  /** Sending domains whose guard columns differ from their defaults. */
  readonly guardColumnsChanged: number;
  readonly alertThresholdsRows: number;
  readonly clientVersionRangeRows: number;
}

export interface Preflight0019Counts {
  readonly blocking: Preflight0019Blocking;
  readonly destroyed: Preflight0019Destroyed;
  /** Copied into `audit_events` as `record_merge.archived`, then the table is dropped. */
  readonly archivedMergeEvents: number;
  /**
   * Rows that reference each reason code. A code with none is deleted; a referenced one
   * is kept (the migration says so in a notice).
   */
  readonly reasonCodeReferences: { readonly domainCap: number; readonly deadJob: number };
  /** Rows the relaxed triggers and CHECKs cover. Nothing in them changes. */
  readonly relaxed: {
    readonly snoozes: number;
    readonly snoozesWithPlaceholderReason: number;
    readonly usablePhoneRoutes: number;
    readonly attestedCallingIdentities: number;
    readonly statePostures: number;
    readonly approvedTemplates: number;
    readonly publishedVersions: number;
  };
  /** Kept on purpose: the scheduler reactivates these through the resume path. */
  readonly reviewRequiredEnrollments: number;
}

export type Preflight0019 =
  | {
      readonly applicable: true;
      readonly schemaVersion: number;
      readonly migration: number;
      readonly counts: Preflight0019Counts;
      /** True when 0019 would raise FS019: the coordinator decides with the owner first. */
      readonly refuses: boolean;
    }
  | { readonly applicable: false; readonly schemaVersion: number; readonly migration: number };

type CountsRow = Readonly<Record<string, number>>;

const count = (row: CountsRow, column: string): number => Number(row[column] ?? 0);

export async function readSchemaPreflight0019(session: SessionQueryable): Promise<Preflight0019> {
  const schemaVersion = await readAppliedSchemaVersion(session);
  if (schemaVersion !== SCHEMA_PREFLIGHT_0019_MIGRATION - 1) {
    return { applicable: false, schemaVersion, migration: SCHEMA_PREFLIGHT_0019_MIGRATION };
  }
  await session.query('BEGIN TRANSACTION READ ONLY');
  try {
    const { rows } = await session.query<CountsRow>(SCHEMA_PREFLIGHT_0019_SQL);
    const row = rows[0];
    if (row === undefined) throw new Error('the preflight count query returned no row');
    const blocking: Preflight0019Blocking = {
      linkedInSteps: count(row, 'linkedin_steps'),
      linkedInExecutions: count(row, 'linkedin_executions'),
      removedExecutions: count(row, 'removed_executions'),
      removedShifts: count(row, 'removed_shifts'),
      removedHolds: count(row, 'removed_holds'),
      removedPauses: count(row, 'removed_pauses'),
      enrollmentMigrations: count(row, 'enrollment_migrations'),
      enrollmentMigrationItems: count(row, 'enrollment_migration_items'),
      migrationShifts: count(row, 'migration_shifts'),
      migrationSuperseded: count(row, 'migration_superseded'),
      migrationPaused: count(row, 'migration_paused'),
      researchProviderLedger: count(row, 'research_provider_ledger'),
      researchPages: count(row, 'research_pages'),
      firmLocations: count(row, 'firm_locations'),
      researchFirmRuns: count(row, 'research_firm_runs'),
      researchSuggestions: count(row, 'research_suggestions'),
    };
    const researchSeed = Object.fromEntries(RESEARCH_SEED_TABLES.map(table => [table, count(row, table)])) as Record<
      (typeof RESEARCH_SEED_TABLES)[number],
      number
    >;
    return {
      applicable: true,
      schemaVersion,
      migration: SCHEMA_PREFLIGHT_0019_MIGRATION,
      refuses: Object.values(blocking).some(value => value > 0),
      counts: {
        blocking,
        destroyed: {
          researchSeed,
          directSentDays: count(row, 'direct_sent_days'),
          directSentTotal: count(row, 'direct_sent_total'),
          guardColumnsChanged: count(row, 'guard_columns_changed'),
          alertThresholdsRows: count(row, 'alert_thresholds_rows'),
          clientVersionRangeRows: count(row, 'client_version_range_rows'),
        },
        archivedMergeEvents: count(row, 'record_merge_events'),
        reasonCodeReferences: {
          domainCap: count(row, 'domain_cap_references'),
          deadJob: count(row, 'dead_job_references'),
        },
        relaxed: {
          snoozes: count(row, 'snoozes'),
          snoozesWithPlaceholderReason: count(row, 'snoozes_with_placeholder_reason'),
          usablePhoneRoutes: count(row, 'usable_phone_routes'),
          attestedCallingIdentities: count(row, 'attested_calling_identities'),
          statePostures: count(row, 'state_postures'),
          approvedTemplates: count(row, 'approved_templates'),
          publishedVersions: count(row, 'published_versions'),
        },
        reviewRequiredEnrollments: count(row, 'review_required_enrollments'),
      },
    };
  } finally {
    await session.query('ROLLBACK');
  }
}

/**
 * The admin command. Read-only, as the runtime identity on the operations task, against
 * the database the services are still using. It exits 0 whatever the counts say, so the
 * whole answer reaches the log; the release script reads `refuses` from it and exits 3
 * when it is true, which is what the release chain gates on.
 */
export async function schemaPreflight0019Command(invocation: AdminInvocation): Promise<AdminOutcome> {
  const preflight = await readSchemaPreflight0019(invocation.session);
  if (!preflight.applicable) {
    return {
      ok: false,
      reason: 'schema_not_18',
      detail: `the database is at schema ${String(preflight.schemaVersion)}; migration 0019's preflight counts a schema-18 database`,
    };
  }
  return { ok: true, value: { ...preflight } };
}
