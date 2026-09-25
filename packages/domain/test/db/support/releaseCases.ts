import type { SessionQueryable } from '../../../db/queryable.ts';

/**
 * A failing insert for every constraint migration 0017 adds (lane g71:
 * `release_records`).
 *
 * Same rules as the other case files: its own file so two lanes never edit the middle
 * of one array, each case inside a transaction the caller rolls back, and each row
 * breaking exactly one thing — a row that breaks two is reported under whichever check
 * PostgreSQL reaches first, and the case would be testing the wrong promise.
 *
 * The data is fictional: digests of repeated letters, a rehearsal nobody ran.
 */

export interface ReleaseCaseFixture {
  readonly session: SessionQueryable;
}

export interface ReleaseCase {
  readonly constraint: string;
  readonly run: (fixture: ReleaseCaseFixture) => Promise<unknown>;
}

const API = `sha256:${'a'.repeat(64)}`;
const WORKER = `sha256:${'b'.repeat(64)}`;

interface Row {
  readonly reference: string;
  readonly suite: string;
  readonly api: string;
  readonly worker: string;
  readonly stamp: string;
  readonly enablesSending: boolean;
  /** The stored JSON. Defaults to the record the columns describe. */
  readonly record?: unknown;
}

const valid = (reference: string): Row => ({
  reference,
  suite: 'pass',
  api: API,
  worker: WORKER,
  stamp: 'c'.repeat(40),
  enablesSending: false,
});

function recordOf(row: Row): unknown {
  return {
    schema: 'fss.release-record.v1',
    releaseGateReference: row.reference,
    rehearsalPrefix: 'fss-rh-case',
    recordedAt: '2026-09-25T07:20:44Z',
    suite: row.suite,
    artifacts: { api: row.api, worker: row.worker, desktopCommitStamp: row.stamp },
    carryDrill: 'skipped_no_watermark',
    rehearsalScenarios: {},
    enablesSending: row.enablesSending,
  };
}

async function insert(f: ReleaseCaseFixture, row: Row): Promise<unknown> {
  return await f.session.query(
    `INSERT INTO release_records
       (reference, recorded_at, suite, api_digest, worker_digest, desktop_commit_stamp, enables_sending, record)
     VALUES ($1, TIMESTAMPTZ '2026-09-25 07:20:44+00', $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      row.reference,
      row.suite,
      row.api,
      row.worker,
      row.stamp,
      row.enablesSending,
      JSON.stringify(row.record === undefined ? recordOf(row) : row.record),
    ],
  );
}

/** A row whose columns are fine and whose record disagrees with them in one place. */
function drifted(reference: string, change: (record: Record<string, unknown>) => void): Row {
  const row = valid(reference);
  const record = recordOf(row) as Record<string, unknown>;
  change(record);
  return { ...row, record };
}

export const RELEASE_CONSTRAINT_CASES: readonly ReleaseCase[] = [
  {
    constraint: 'release_records_pkey',
    run: async f => {
      await insert(f, valid('fss-rh-case-pkey'));
      return await insert(f, valid('fss-rh-case-pkey'));
    },
  },
  {
    constraint: 'release_records_reference_shape',
    run: async f => {
      const row = valid('fss-rh-case-reference');
      // A space is outside the reference alphabet; the record agrees with the column.
      const reference = 'not a reference';
      return await insert(f, { ...row, reference, record: { ...(recordOf(row) as object), releaseGateReference: reference } });
    },
  },
  {
    constraint: 'release_records_suite_shape',
    run: async f => {
      const row = { ...valid('fss-rh-case-suite'), suite: 'PASS' };
      return await insert(f, row);
    },
  },
  {
    constraint: 'release_records_api_digest_shape',
    run: async f => await insert(f, { ...valid('fss-rh-case-api-shape'), api: 'latest' }),
  },
  {
    constraint: 'release_records_worker_digest_shape',
    run: async f => await insert(f, { ...valid('fss-rh-case-worker-shape'), worker: `sha256:${'B'.repeat(64)}` }),
  },
  {
    constraint: 'release_records_digests_differ',
    run: async f => await insert(f, { ...valid('fss-rh-case-same-image'), worker: API }),
  },
  {
    constraint: 'release_records_desktop_stamp_present',
    run: async f => await insert(f, { ...valid('fss-rh-case-stamp'), stamp: '   ' }),
  },
  {
    constraint: 'release_records_record_is_object',
    run: async f => await insert(f, { ...valid('fss-rh-case-object'), record: ['not', 'an', 'object'] }),
  },
  {
    constraint: 'release_records_record_matches_columns',
    run: async f =>
      await insert(
        f,
        drifted('fss-rh-case-drift', record => {
          // The columns say worker digest B; the stored record says C. Two answers to
          // "which images did this rehearsal certify" is the thing the CHECK refuses.
          record['artifacts'] = { api: API, worker: `sha256:${'c'.repeat(64)}`, desktopCommitStamp: 'c'.repeat(40) };
        }),
      ),
  },
];
