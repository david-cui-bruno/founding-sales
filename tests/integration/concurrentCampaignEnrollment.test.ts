import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { CampaignRepository } from '../../src/main/domain/campaign/campaignRepository';
import { createCampaignFixture } from '../fixtures/campaignWorkspace';

it('two encrypted SQL connections cannot claim one account across campaigns or paused enrollment', async () => {
  const f = await createCampaignFixture(); const second = openDatabase({ path: f.path, key: f.key });
  try {
    second.raw.pragma('busy_timeout = 0');
    const repo = new CampaignRepository({ database: second, workspaceId: f.workspaceId, clock: f.clock });
    f.db.raw.exec('BEGIN IMMEDIATE');
    f.db.raw.prepare(`INSERT INTO campaign_enrollments(workspace_id,id,account_id,campaign_version_id,selected_route_id,selected_route_version,person_id,current_step_id,version,state,context_revision,execution_context_id,started_at,updated_at)
      VALUES(?,?,?,?,?,1,NULL,?,1,'paused',1,'context',?,?)`).run(f.workspaceId, randomUUID(), f.account.id, f.versions[0].id, f.routes[0].id, f.versions[0].steps[0].id, f.now, f.now);
    const command = { commandId: randomUUID(), accountId: f.account.id, selectedRouteId: f.routes[1].id, campaignVersionId: f.versions[1].id, contextRevision: 1, executionContextId: 'second-context' };
    expect(() => repo.enroll(command)).toThrow(/locked/);
    f.db.raw.exec('COMMIT');
    expect(() => repo.enroll(command)).toThrow('account_already_enrolled');
    expect(second.raw.prepare('SELECT COUNT(*) AS n FROM campaign_enrollments').get()).toEqual({ n: 1 });
  } finally { if (f.db.raw.inTransaction) f.db.raw.exec('ROLLBACK'); closeDatabase(second); f.close(); }
});
