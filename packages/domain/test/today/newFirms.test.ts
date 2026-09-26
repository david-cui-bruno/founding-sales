import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { databaseNow } from '../../policy/clock.ts';
import { newFirmSource } from '../../today/build.ts';
import { businessDateOf } from '../../today/snapshots.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { firstStageId, stageIdByKey } from '../db/support/crmFixtures.ts';

/**
 * Lane 4 is for firms nobody has worked yet (8.2; audit C19).
 *
 * The new-firm query joined only the open opportunity, so a firm whose opportunity was
 * Won or Lost read as a firm with no opportunity at all and came back the next morning
 * as a new firm to call — a client, or somebody who had already said no.
 *
 * **The vacuous-pass trap.** A list with no closed firms passes any rule about closed
 * firms. So the four firms here are one of each: never opened, open at the first stage,
 * Won, and Lost — and the first two are required to be on the list, so an empty lane
 * cannot pass either.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;

const worker = (): RepositoryContext =>
  repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), database.session);

async function firm(name: string): Promise<string> {
  const { rows } = await database.session.query<{ id: string }>(
    `INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, $2, $3) RETURNING id`,
    [seeded.alpha.workspaceId, name, seeded.alpha.salesperson.userId],
  );
  return rows[0]?.id ?? '';
}

async function opportunity(firmId: string, stageKey: string | null, status: 'open' | 'won' | 'lost'): Promise<void> {
  const stageId =
    stageKey === null
      ? await firstStageId(database.session, seeded.alpha.workspaceId)
      : await stageIdByKey(database.session, seeded.alpha.workspaceId, stageKey);
  await database.session.query(
    `INSERT INTO opportunities (workspace_id, firm_id, stage_id, status, closed_at, close_reason, control_mode_changed_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'open' THEN NULL ELSE now() END,
             CASE WHEN $4 = 'lost' THEN 'Chose another provider' ELSE NULL END, now())`,
    [seeded.alpha.workspaceId, firmId, stageId, status],
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
});

afterAll(async () => {
  await database.drop();
});

describe('the new-firm lane (audit C19)', () => {
  it('lists a never-opened firm and a firm at the first stage, and neither a Won nor a Lost one', async () => {
    const untouched = await firm('Untouched Test Advisors');
    const opened = await firm('Opened Test Advisors');
    const won = await firm('Won Test Advisors');
    const lost = await firm('Lost Test Advisors');
    await opportunity(opened, null, 'open');
    await opportunity(won, 'won', 'won');
    await opportunity(lost, 'lost', 'lost');

    const now = await databaseNow(worker());
    const found = await newFirmSource().find(worker(), {
      businessDate: await businessDateOf(worker(), now),
      businessTimeZone: 'America/New_York',
      now,
    });
    const ids = found.map(entry => entry.firmId);
    expect(ids).toContain(untouched);
    expect(ids).toContain(opened);
    expect(ids).not.toContain(won);
    expect(ids).not.toContain(lost);
  });

  it('does not bring a Lost firm back as new when it is reopened at the first stage', async () => {
    const reopened = await firm('Reopened Test Advisors');
    await opportunity(reopened, 'lost', 'lost');
    await opportunity(reopened, null, 'open');
    const now = await databaseNow(worker());
    const found = await newFirmSource().find(worker(), {
      businessDate: await businessDateOf(worker(), now),
      businessTimeZone: 'America/New_York',
      now,
    });
    expect(found.map(entry => entry.firmId)).not.toContain(reopened);
  });
});
