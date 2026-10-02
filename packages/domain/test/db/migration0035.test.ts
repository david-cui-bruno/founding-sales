import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { readAppliedSchemaVersion } from '../../db/migrationRunner.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';

/**
 * Migration 0035 on a database at schema 34 (slice 3a): every stored reservation survives
 * the widened subject and priced-shape CHECKs unchanged, `call_analysis` is admitted (it was
 * refused at 34) with the model-and-tokens shape and never by the minute, and
 * `call_analyses` exists, empty, granted to the runtime role.
 */
describe('migration 0035 on a database at schema 34', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let reservationsBefore: unknown[] = [];

  const insertAnalysisReservation = async (shape: 'tokens' | 'minutes' = 'tokens'): Promise<void> => {
    await database.session.query(
      shape === 'tokens'
        ? `INSERT INTO provider_reservations
             (workspace_id, provider_key, subject_kind, subject_id, attempt, business_date, business_time_zone,
              cents, model_name, max_input_tokens, max_output_tokens)
           VALUES ($1, 'aws_bedrock.call_analysis', 'call_analysis', gen_random_uuid(), 1, '2026-10-01', 'America/New_York',
                   3, 'claude-haiku-4-5-20251001', 10000, 3000)`
        : `INSERT INTO provider_reservations
             (workspace_id, provider_key, subject_kind, subject_id, attempt, business_date, business_time_zone,
              cents, priced_unit, max_units, unit_price_micros)
           VALUES ($1, 'aws_bedrock.call_analysis', 'call_analysis', gen_random_uuid(), 1, '2026-10-01', 'America/New_York',
                   2, 'minute', 1, 1000)`,
      [seeded.alpha.workspaceId],
    );
  };

  beforeAll(async () => {
    database = await createTestDatabase({ throughVersion: 34 });
    expect(await readAppliedSchemaVersion(database.session)).toBe(34);
    seeded = await seedTwoWorkspaces(database.session);
    // One stored row of every subject 0034 admits, each in its own shape.
    await database.session.query(
      `INSERT INTO provider_reservations
         (workspace_id, provider_key, subject_kind, subject_id, attempt, business_date, business_time_zone,
          cents, model_name, max_input_tokens, max_output_tokens, state)
       VALUES ($1, 'anthropic_extraction', 'research_run', gen_random_uuid(), 1, '2026-09-30', 'America/New_York', 5, 'claude-opus-5', 9000, 2000, 'reserved'),
              ($1, 'anthropic_classifier', 'reply_classification', gen_random_uuid(), 1, '2026-09-30', 'America/New_York', 2, 'claude-opus-5', 3000, 512, 'calling'),
              ($1, 'aws_bedrock.call_summary', 'call_summary', gen_random_uuid(), 1, '2026-09-30', 'America/New_York', 1, 'claude-haiku-4-5-20251001', 4000, 1500, 'reserved')`,
      [seeded.alpha.workspaceId],
    );
    await database.session.query(
      `INSERT INTO provider_reservations
         (workspace_id, provider_key, subject_kind, subject_id, attempt, business_date, business_time_zone,
          cents, priced_unit, max_units, unit_price_micros, state, settled_cents, settled_at)
       VALUES ($1, 'twilio.voice', 'call_session', gen_random_uuid(), 1, '2026-09-30', 'America/New_York', 42, 'minute', 30, 14000, 'settled', 3, now()),
              ($1, 'deepgram.nova-3', 'call_transcription', gen_random_uuid(), 1, '2026-09-30', 'America/New_York', 2, 'minute', 3, 4300, 'estimated', 2, now())`,
      [seeded.alpha.workspaceId],
    );
    await expect(insertAnalysisReservation()).rejects.toMatchObject({ constraint: 'provider_reservations_subject_known' });
    reservationsBefore = (await database.session.query('SELECT * FROM provider_reservations ORDER BY id')).rows;
    const { applyMigrations } = await import('../../db/migrationRunner.ts');
    await applyMigrations(database.session, { throughVersion: 35 });
  });

  afterAll(async () => {
    await database.drop();
  });

  it('is at schema 35, with every stored reservation unchanged', async () => {
    expect(await readAppliedSchemaVersion(database.session)).toBe(35);
    expect((await database.session.query('SELECT * FROM provider_reservations ORDER BY id')).rows).toEqual(reservationsBefore);
  });

  it('admits a call_analysis reservation priced by model and tokens, and refuses one priced by the minute', async () => {
    await insertAnalysisReservation();
    await expect(insertAnalysisReservation('minutes')).rejects.toMatchObject({ constraint: 'provider_reservations_priced_shape' });
  });

  it('creates call_analyses, empty, readable and writable by the runtime role', async () => {
    expect((await database.session.query('SELECT count(*)::int AS n FROM call_analyses')).rows).toEqual([{ n: 0 }]);
    const { rows } = await database.session.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'call_analyses' AND grantee = 'app_runtime' ORDER BY privilege_type`,
    );
    expect(rows.map(row => row.privilege_type)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });
});
