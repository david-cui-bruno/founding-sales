import { randomUUID } from 'node:crypto';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { CampaignRepository } from '../../src/main/domain/campaign/campaignRepository';
import { accountFingerprint } from '../../src/main/domain/accounts/accountEvidence';
import type { CampaignVersion } from '../../src/shared/contracts/campaignContract';
import { createTempDatabase, createTestWorkspaceKey } from './tempDatabase';

export async function createCampaignFixture() {
  const temp = createTempDatabase(); const key = createTestWorkspaceKey(); const db = openDatabase({ path: temp.path, key });
  const workspaceId = randomUUID(); const now = '2026-09-09T12:00:00.000Z'; const clock = { now: () => now };
  try {
    await migrateToLatest(db, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
    const accounts = new AccountRepository({ database: db, clock, ids: { next: randomUUID }, sourcePolicy: { attest: source => source.url === 'https://example.invalid/team' } });
    const account = accounts.create({ commandId: randomUUID(), name: 'Fictional Campaign PM', domain: 'example.invalid' });
    const sourceId = randomUUID(); const routes = [0, 1].map(index => ({ id: randomUUID(), accountId: account.id, personId: null as string | null,
      channel: 'phone' as const, value: index === 0 ? '+12025550101' : '+12025550102', purpose: 'business' as const, evidenceIds: [sourceId], verification: 'published' as const }));
    accounts.admitEvidence({ commandId: randomUUID(), accountId: account.id, expectedVersion: 1, sources: [{ id: sourceId, url: 'https://example.invalid/team', fetchedAt: now, sha256: 'a'.repeat(64), excerpt: 'Fictional business team contact.', permitted: true }], claims: [], routes });
    const repo = new CampaignRepository({ database: db, workspaceId, clock });
    const versions: CampaignVersion[] = [1, 2].map(version => ({ id: randomUUID(), campaignId: randomUUID(), version, audienceHash: 'a'.repeat(64), offer: 'Fictional maintenance offer', objective: 'meeting', cohortAccountIds: [account.id], approvedAt: null as string | null,
      steps: [{ id: randomUUID(), channel: 'call', condition: 'initial', delayHours: 0 }], capScope: 'campaign_version_lifetime', channelCaps: { call: 2, email: 1, linkedin: 1 }, contentPolicyHash: 'b'.repeat(64) }));
    for (const version of versions) { repo.createVersion({ commandId: randomUUID(), version }); repo.approve({ commandId: randomUUID(), campaignVersionId: version.id, snapshotHash: accountFingerprint(version), approvedAt: now }); }
    return { db, repo, account, routes, versions, workspaceId, now, path: temp.path, key, clock,
      close() { closeDatabase(db); key.bytes.fill(0); temp.cleanup(); } };
  } catch (error) { closeDatabase(db); key.bytes.fill(0); temp.cleanup(); throw error; }
}
