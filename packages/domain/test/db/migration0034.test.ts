import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { readAppliedSchemaVersion } from '../../db/migrationRunner.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';
import { seedCrm, type SeededCrm } from './support/crmFixtures.ts';

/**
 * Migration 0034 on a database at schema 33 (slice S2): a call log says which way the call
 * went. Every stored log reads `outbound` with no duration and is otherwise unchanged; an
 * `inbound` log with a duration is admitted, and an unknown direction or a negative length
 * is refused.
 */
describe('migration 0034 on a database at schema 33', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let before: Record<string, unknown>[] = [];

  const insertLog = async (columns: Readonly<Record<string, unknown>> = {}): Promise<void> => {
    const all: Record<string, unknown> = {
      firm_id: crm.alpha.firmId,
      outcome: 'no_answer',
      step_effect: 'none',
      occurred_at: '2026-10-01T14:00:00Z',
      actor_user_id: seeded.alpha.salesperson.userId,
      ...columns,
    };
    const names = Object.keys(all);
    await database.session.query(
      `INSERT INTO call_logs (workspace_id, ${names.join(', ')})
       VALUES ($1, ${names.map((_name, index) => `$${String(index + 2)}`).join(', ')})`,
      [seeded.alpha.workspaceId, ...names.map(name => all[name])],
    );
  };

  beforeAll(async () => {
    database = await createTestDatabase({ throughVersion: 33 });
    expect(await readAppliedSchemaVersion(database.session)).toBe(33);
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);
    await insertLog();
    await insertLog({ outcome: 'interested', step_effect: 'none', note: 'Spoke with the owner' });
    before = (await database.session.query<Record<string, unknown>>('SELECT * FROM call_logs ORDER BY id')).rows;
    const { applyMigrations } = await import('../../db/migrationRunner.ts');
    await applyMigrations(database.session, { throughVersion: 34 });
  });

  afterAll(async () => {
    await database.drop();
  });

  it('is at schema 34, every stored log outbound with no duration and otherwise unchanged', async () => {
    expect(await readAppliedSchemaVersion(database.session)).toBe(34);
    const after = (await database.session.query<Record<string, unknown>>('SELECT * FROM call_logs ORDER BY id')).rows;
    expect(after.map(row => [row['direction'], row['duration_seconds']])).toEqual([
      ['outbound', null],
      ['outbound', null],
    ]);
    expect(after.map(({ direction: _direction, duration_seconds: _duration, ...rest }) => rest)).toEqual(before);
  });

  it('admits an inbound log with a length, and refuses an unknown direction or a negative length', async () => {
    await insertLog({ direction: 'inbound', duration_seconds: 240, outcome: 'interested' });
    await expect(insertLog({ direction: 'sideways' })).rejects.toMatchObject({ constraint: 'call_logs_direction_known' });
    await expect(insertLog({ direction: 'inbound', duration_seconds: -5 })).rejects.toMatchObject({
      constraint: 'call_logs_duration_bounded',
    });
  });
});
