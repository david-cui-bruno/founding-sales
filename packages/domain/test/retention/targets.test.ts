import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import {
  COVERAGE_EXEMPT_TABLES,
  PENDING_RETENTION_TABLES,
  RETENTION_LEDGER_KINDS,
  RETENTION_POLICY_KINDS,
  RETENTION_TARGETS,
  TABLE_RETENTION_COVERAGE,
  retentionPeriodOf,
  retentionTargetFor,
} from '../../retention/index.ts';
import { RETENTION_DATA_KINDS } from '@fss/contracts';

/**
 * The retention target registry, and the thing that stops it being forgotten.
 *
 * Four lanes were in flight beside this one and each owned a table that section 10.3
 * has an obligation for: G7-2's outbound drafts (`canceled_drafts`, 30 days), G7b's
 * classifier output, G8's enrollments and executions, G9's settings. None of their
 * tables was on main, so none could have a sweep written against it, and a retention
 * lane that shipped without saying so would have left fifteen silent gaps.
 *
 * So they were registered as declared-pending with the tables they would bring, and
 * `PENDING_RETENTION_TABLES` was checked against the live catalog on every run. The
 * moment one of those tables existed, this test failed and named what had to be
 * written. That is the whole mechanism, and it was paid twice: G7-2's
 * `outbound_messages`, and then the other thirteen together at this lane's final
 * merge. The list is empty now, and the cases below test the mechanism in that state
 * rather than being deleted with it — an empty guard that still runs is the thing the
 * next lane needs. See docs/decisions/g14-retention-target-registry.md.
 */

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe('the registry covers the retention table', () => {
  it('has a target for every kind in the ledger vocabulary, and no extras', () => {
    expect([...RETENTION_TARGETS.map(target => target.dataKind)].sort()).toEqual([...RETENTION_LEDGER_KINDS].sort());
  });

  it('keeps the policy vocabulary equal to the one the database and the contracts enforce', async () => {
    expect([...RETENTION_POLICY_KINDS].sort()).toEqual([...RETENTION_DATA_KINDS].sort());

    const { rows } = await database.session.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'retention_policies' AND c.conname = 'retention_policies_data_kind_known'
    `);
    const definition = rows[0]?.definition ?? '';
    for (const kind of RETENTION_POLICY_KINDS) expect(definition, kind).toContain(`'${kind}'`);
    // The ledger vocabulary is the policy vocabulary plus the queue's own payload
    // archival, which is 13.2 rather than one of 10.3's ten rows.
    const policyKinds: readonly string[] = RETENTION_POLICY_KINDS;
    expect([...RETENTION_LEDGER_KINDS].filter(kind => !policyKinds.includes(kind))).toEqual(['job_payloads']);
  });

  it('gives every target a state and only lets an implemented one sweep', () => {
    for (const target of RETENTION_TARGETS) {
      expect(['implemented', 'declared_pending', 'retained', 'external'], target.dataKind).toContain(target.state);
      if (target.state === 'implemented') expect(target.sweep, target.dataKind).not.toBeNull();
      else expect(target.sweep, target.dataKind).toBeNull();
      expect(target.note.length, target.dataKind).toBeGreaterThan(20);
    }
  });

  it('never lets a target reach an append-only table', () => {
    const forbidden = ['audit_events', 'suppression_events', 'opportunity_stage_events', 'record_merge_events', 'crm_domain_events'];
    for (const target of RETENTION_TARGETS) {
      for (const table of target.tables) expect(forbidden, `${target.dataKind} names ${table}`).not.toContain(table);
    }
  });

  it('resolves a kind to its target and refuses an unknown one', () => {
    expect(retentionTargetFor('raw_mime')?.state).toBe('implemented');
    expect(retentionTargetFor('not-a-kind')).toBeUndefined();
  });
});

describe('the declared-pending guard', () => {
  it('names a lane, a table and the target that has to be written for each', () => {
    // Empty today, and the shape is still asserted: an entry added later with a
    // blank `owes` would be a deadline nobody could act on, which is the one way
    // this mechanism fails quietly.
    for (const pending of PENDING_RETENTION_TABLES) {
      expect(pending.table).toMatch(/^[a-z][a-z0-9_]+$/u);
      expect(pending.lane).toMatch(/^G/u);
      expect(pending.owes.length).toBeGreaterThan(20);
    }
  });

  it('is empty, because every table it was waiting for has landed and been answered', () => {
    // The assertion that used to read `length > 0`. Inverting it is not weakening
    // it: while the list had entries, `length > 0` said the lane had not forgotten
    // to declare them; now that the work is done, a non-empty list would mean
    // somebody re-declared a table that is already in the catalog, and the case
    // below would not catch that if the table had not arrived yet.
    expect(PENDING_RETENTION_TABLES).toEqual([]);
  });

  it('fails the build the moment one of those tables appears without a target', async () => {
    const { rows } = await database.session.query<{ table_name: string }>(
      `SELECT c.relname AS table_name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[])`,
      [PENDING_RETENTION_TABLES.map(pending => pending.table)],
    );
    const arrived = rows.map(row => row.table_name);
    const owed = PENDING_RETENTION_TABLES.filter(pending => arrived.includes(pending.table)).map(
      pending => `${pending.table} (${pending.lane}): ${pending.owes}`,
    );
    expect(
      owed,
      'a table a declared-pending retention target was waiting for is now on main; write the target',
    ).toEqual([]);
  });

  it('has already been paid: canceled_drafts was declared pending and is now implemented', () => {
    // This is the guard working the first time. `outbound_messages` landed with lane
    // G7-2's merge, the case above failed, and the target was written. It is kept as
    // a test rather than deleted because it pins the direction of travel: a target
    // may move from declared-pending to implemented and never back.
    const target = retentionTargetFor('canceled_drafts');
    expect(target?.state).toBe('implemented');
    expect(target?.tables).toEqual(expect.arrayContaining(['outbound_messages']));
    expect(PENDING_RETENTION_TABLES.map(pending => pending.table)).not.toContain('outbound_messages');
  });

  it('has already been paid the second time: every table the other lanes brought is classified', async () => {
    // The guard working at this lane's final merge. These thirteen were declared
    // pending against G7b, G8 and G9; all thirteen are on main now, the case above
    // printed all thirteen sentences, and each one is answered in
    // `TABLE_RETENTION_COVERAGE`. Naming them here rather than trusting the
    // catalog sweep means a later lane that drops one from the coverage map is told
    // which lane's table it just orphaned.
    const paid = [
      'mail_classification_calls',
      'mail_reply_confirmations',
      'workspace_settings',
      'workspace_holiday_calendars',
      'sequence_versions',
      'sequence_steps',
      'sequence_enrollments',
      'step_executions',
      'step_execution_shifts',
      'enrollment_migrations',
      'enrollment_migration_items',
      'sequence_event_cursors',
    ];
    const { rows } = await database.session.query<{ table_name: string }>(
      `SELECT c.relname AS table_name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[])`,
      [paid],
    );
    // They really are on main; a rename would otherwise make this case vacuous.
    expect(rows.map(row => row.table_name).sort()).toEqual([...paid].sort());
    for (const table of paid) {
      expect(TABLE_RETENTION_COVERAGE[table], `${table} has no retention disposition`).toBeDefined();
    }
    expect(PENDING_RETENTION_TABLES.map(pending => pending.table)).not.toEqual(expect.arrayContaining(paid));
  });
});

describe('the period a batch is keyed by', () => {
  it('is the UTC calendar day, so a pass at 00:01 and one at 23:59 are the same work', () => {
    expect(retentionPeriodOf('2026-09-20T00:01:00.000Z')).toBe('2026-09-20');
    expect(retentionPeriodOf('2026-09-20T23:59:59.000Z')).toBe('2026-09-20');
    expect(retentionPeriodOf('2026-09-21T00:00:00.000Z')).toBe('2026-09-21');
    expect(() => retentionPeriodOf('not an instant')).toThrow(RangeError);
  });
});

describe('the ninety-day operational log horizon is somebody else’s, and it is written down', () => {
  it('matches the CloudWatch retention G1 configured', () => {
    const variables = readFileSync(
      join(new URL('../../../../', import.meta.url).pathname, 'infra/modules/observability/variables.tf'),
      'utf8',
    );
    // 10.3: "Operational application logs | 90 days". The application stores no log
    // rows, so the horizon is enforced by the log group's retention and nothing in
    // this repository sweeps it. A test reads the number rather than trusting the
    // decision document, because the two drift in opposite directions.
    expect(/variable "retention_days"[\s\S]*?default\s*=\s*90/u.test(variables)).toBe(true);
    expect(retentionTargetFor('operational_logs')?.state).toBe('external');
  });
});

describe('every table says what happens to its rows', () => {
  it('classifies each table the database has, and classifies nothing it does not', async () => {
    const { rows } = await database.session.query<{ table_name: string }>(`
      SELECT c.relname AS table_name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
    `);
    const live = rows
      .map(row => row.table_name)
      .filter(name => !COVERAGE_EXEMPT_TABLES.includes(name))
      .sort();
    const classified = Object.keys(TABLE_RETENTION_COVERAGE).sort();

    // This is the guard `PENDING_RETENTION_TABLES` cannot be: it catches a table
    // whose name this lane could not have guessed. A lane that adds one and does not
    // say what section 10.3 does with its rows fails here.
    expect(
      live.filter(name => !classified.includes(name)),
      'a table exists with no retention disposition; add it to TABLE_RETENTION_COVERAGE',
    ).toEqual([]);
    expect(
      classified.filter(name => !live.includes(name)),
      'the coverage registry names a table the database does not have',
    ).toEqual([]);
  });

  it('gives every classified table at least one disposition and a reason', () => {
    for (const [table, entry] of Object.entries(TABLE_RETENTION_COVERAGE)) {
      expect(entry.dispositions.length, table).toBeGreaterThan(0);
      expect(entry.note.length, table).toBeGreaterThan(10);
    }
  });
});
