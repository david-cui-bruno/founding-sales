import { readAppliedSchemaVersion } from '@fss/domain/db/migrationRunner.ts';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import type { AdminInvocation, AdminOutcome } from './admin.ts';

/**
 * `fss admin schema-preflight 0021`: what the compatibility-cleanup release will meet,
 * counted before it stops anything (lane W3-C2).
 *
 * `packages/domain/db/migrations/0021_compat_cleanup.sql` refuses on exactly one thing —
 * an enrollment still in `review_required` — and destroys three sets of rows without
 * asking: the refresh credentials, the `devices.credential_generation` values, and the
 * seeded `system_generations` row. So this answers two different questions.
 *
 *   * **Blocking.** `reviewRequiredEnrollments`, with the ids. A live enrollment waiting
 *     for a person is not something a migration may decide about, so 0021 raises FS021
 *     and `infra/scripts/preflight.sh` exits 3 before the release stops anything. There
 *     is nothing else 0021 refuses on.
 *   * **Reported.** The rows the migration will destroy: `active` refresh credentials
 *     (the ones a Mac could still have presented to the old server), the total number of
 *     refresh-credential rows of every state, and the `system_generations` rows. None of
 *     these blocks: the release removes the paths that gave them meaning, and a count is
 *     what a person needs in order not to be surprised by the number.
 *
 * **The one check this cannot make.** 0021 is only safe because no build older than
 * 1.0.14 is in use, and the database cannot be asked which build is installed on David's
 * Mac. `installedClientCheck` says so in the report rather than leaving it unsaid, and
 * `clientVersionsSeen` lists the `client_version` values the `devices` rows carry with
 * the newest session each — evidence, not proof: a row records what a Mac last told the
 * server, so a Mac that has not opened a session since it was updated still says the
 * old number. The operator confirms 1.0.14 by hand.
 *
 * Read-only: a READ ONLY transaction, rolled back. On any schema but 20 it refuses —
 * before 20 the release is not this one, after it 0021 has run.
 */

export const SCHEMA_PREFLIGHT_0021_MIGRATION = 21;

/** Ids are uuids, and a report is a log line: no secret, no digest, no prospect text. */
export interface Preflight0021Blocking {
  /** Enrollments still in the state 0021 removes. Nothing else blocks. */
  readonly reviewRequiredEnrollments: number;
}

export interface Preflight0021Counts {
  readonly blocking: Preflight0021Blocking;
  /** Named, so the coordinator can look at exactly these rows before deciding. */
  readonly reviewRequired: { readonly enrollmentIds: readonly string[] };
  /** What the migration destroys. Reported, never blocking. */
  readonly destroyed: {
    /** Credentials a Mac could still have presented to the previous release. */
    readonly activeRefreshCredentials: number;
    /** Every refresh-credential row, whatever its state. */
    readonly refreshCredentialRows: number;
    /** Devices whose `credential_generation` has moved past the claim's 1. */
    readonly devicesPastFirstGeneration: number;
    /** `system_generations`, whose pin went with lane W3-S8. */
    readonly systemGenerationRows: number;
  };
  /** The check the database cannot make, said rather than left unsaid. */
  readonly installedClientCheck: {
    readonly automated: false;
    readonly confirm: string;
    /** What each registered Mac last told the server, newest first. Evidence, not proof. */
    readonly clientVersionsSeen: readonly { readonly clientVersion: string | null; readonly devices: number }[];
  };
}

export type Preflight0021 =
  | {
      readonly applicable: true;
      readonly schemaVersion: number;
      readonly migration: number;
      readonly counts: Preflight0021Counts;
      /** True when an enrollment is still `review_required`. Nothing else refuses. */
      readonly refuses: boolean;
    }
  | { readonly applicable: false; readonly schemaVersion: number; readonly migration: number };

interface IdRow {
  readonly id: string;
  readonly [column: string]: unknown;
}

interface CountRow {
  readonly count: string | number;
  readonly [column: string]: unknown;
}

interface VersionRow {
  readonly client_version: string | null;
  readonly devices: string | number;
  readonly [column: string]: unknown;
}

/** Bounded: a report is a log line, and the count beside it is the whole number. */
const NAMED_ENROLLMENT_LIMIT = 50;

export const SCHEMA_PREFLIGHT_0021_REVIEW_REQUIRED_SQL = `
SELECT id
  FROM sequence_enrollments
 WHERE state = 'review_required'
 ORDER BY id
 LIMIT ${String(NAMED_ENROLLMENT_LIMIT)}`;

export const SCHEMA_PREFLIGHT_0021_COUNTS_SQL = `
SELECT (SELECT count(*) FROM sequence_enrollments WHERE state = 'review_required')::text
         AS review_required_enrollments,
       (SELECT count(*) FROM device_refresh_credentials WHERE state = 'active')::text
         AS active_refresh_credentials,
       (SELECT count(*) FROM device_refresh_credentials)::text AS refresh_credential_rows,
       (SELECT count(*) FROM devices WHERE credential_generation > 1)::text
         AS devices_past_first_generation,
       (SELECT count(*) FROM system_generations)::text AS system_generation_rows`;

export const SCHEMA_PREFLIGHT_0021_CLIENT_VERSIONS_SQL = `
SELECT client_version, count(*)::text AS devices
  FROM devices
 WHERE status = 'active'
 GROUP BY client_version
 ORDER BY client_version NULLS LAST`;

const CONFIRM_BY_HAND =
  'the database cannot say which desktop build is installed: confirm 1.0.14 on David’s Mac by hand before the release';

function count(row: Record<string, unknown> | undefined, column: string): number {
  return Number((row?.[column] as string | number | undefined) ?? 0);
}

export async function readSchemaPreflight0021(session: SessionQueryable): Promise<Preflight0021> {
  const schemaVersion = await readAppliedSchemaVersion(session);
  if (schemaVersion !== SCHEMA_PREFLIGHT_0021_MIGRATION - 1) {
    return { applicable: false, schemaVersion, migration: SCHEMA_PREFLIGHT_0021_MIGRATION };
  }
  await session.query('BEGIN TRANSACTION READ ONLY');
  try {
    const counts = await session.query<CountRow>(SCHEMA_PREFLIGHT_0021_COUNTS_SQL);
    const named = await session.query<IdRow>(SCHEMA_PREFLIGHT_0021_REVIEW_REQUIRED_SQL);
    const versions = await session.query<VersionRow>(SCHEMA_PREFLIGHT_0021_CLIENT_VERSIONS_SQL);
    const row = counts.rows[0];

    const blocking: Preflight0021Blocking = {
      reviewRequiredEnrollments: count(row, 'review_required_enrollments'),
    };
    return {
      applicable: true,
      schemaVersion,
      migration: SCHEMA_PREFLIGHT_0021_MIGRATION,
      refuses: Object.values(blocking).some(value => value > 0),
      counts: {
        blocking,
        reviewRequired: { enrollmentIds: named.rows.map(entry => entry.id) },
        destroyed: {
          activeRefreshCredentials: count(row, 'active_refresh_credentials'),
          refreshCredentialRows: count(row, 'refresh_credential_rows'),
          devicesPastFirstGeneration: count(row, 'devices_past_first_generation'),
          systemGenerationRows: count(row, 'system_generation_rows'),
        },
        installedClientCheck: {
          automated: false,
          confirm: CONFIRM_BY_HAND,
          clientVersionsSeen: versions.rows.map(entry => ({
            clientVersion: entry.client_version,
            devices: Number(entry.devices),
          })),
        },
      },
    };
  } finally {
    await session.query('ROLLBACK');
  }
}

/**
 * The admin command. Read-only, as the runtime identity on the operations task, against
 * the database both services are still using. It exits 0 whatever the counts say, so the
 * whole answer reaches the log; `infra/scripts/preflight.sh` reads `refuses` and exits 3.
 */
export async function schemaPreflight0021Command(invocation: AdminInvocation): Promise<AdminOutcome> {
  const preflight = await readSchemaPreflight0021(invocation.session);
  if (!preflight.applicable) {
    return {
      ok: false,
      reason: 'schema_not_20',
      detail: `the database is at schema ${String(preflight.schemaVersion)}; migration 0021's preflight counts a schema-20 database`,
    };
  }
  return { ok: true, value: { ...preflight } };
}
