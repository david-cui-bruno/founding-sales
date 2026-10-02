import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { readAppliedSchemaVersion } from '../../db/migrationRunner.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';
import { seedCrm } from './support/crmFixtures.ts';
import { seedMail, type SeededMail } from './support/mailFixtures.ts';

/**
 * Migration 0033 on a database at schema 32 (slice REL1): the reply classifier's call log
 * admits `provider_refused` (refused at 32), every stored row survives unchanged, and an
 * unknown outcome is still refused.
 */
describe('migration 0033 on a database at schema 32', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let mail: SeededMail;
  let callsBefore: unknown[] = [];

  const insertCall = async (outcome: string, sent = true): Promise<void> => {
    await database.session.query(
      `INSERT INTO mail_classification_calls
         (workspace_id, mail_message_id, model_name, prompt_version, request_sent, outcome, business_date)
       VALUES ($1, $2, 'claude-opus-5', 'g7b.replies.1', $3, $4, DATE '2026-10-01')`,
      [seeded.alpha.workspaceId, mail.alpha.messageId, sent, outcome],
    );
  };

  beforeAll(async () => {
    database = await createTestDatabase({ throughVersion: 32 });
    expect(await readAppliedSchemaVersion(database.session)).toBe(32);
    seeded = await seedTwoWorkspaces(database.session);
    mail = await seedMail(database.session, seeded, await seedCrm(database.session, seeded));
    for (const outcome of ['accepted', 'refusal', 'provider_error']) await insertCall(outcome);
    await insertCall('capped', false);
    await expect(insertCall('provider_refused')).rejects.toMatchObject({ constraint: 'mail_classification_calls_outcome_known' });
    callsBefore = (await database.session.query('SELECT * FROM mail_classification_calls ORDER BY id')).rows;
    const { applyMigrations } = await import('../../db/migrationRunner.ts');
    await applyMigrations(database.session, { throughVersion: 33 });
  });

  afterAll(async () => {
    await database.drop();
  });

  it('is at schema 33, with every stored call unchanged', async () => {
    expect(await readAppliedSchemaVersion(database.session)).toBe(33);
    expect((await database.session.query('SELECT * FROM mail_classification_calls ORDER BY id')).rows).toEqual(callsBefore);
  });

  it('admits provider_refused as a sent call, and still refuses an unknown outcome and an unsent refusal', async () => {
    await insertCall('provider_refused');
    await expect(insertCall('shrugged')).rejects.toMatchObject({ constraint: 'mail_classification_calls_outcome_known' });
    await expect(insertCall('provider_refused', false)).rejects.toMatchObject({ constraint: 'mail_classification_calls_unsent_outcome' });
  });
});
