import { randomUUID } from 'node:crypto';
import { createCampaignFixture } from './campaignWorkspace';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { accountFingerprint } from '../../src/main/domain/accounts/accountEvidence';
import { LinkedInRepository } from '../../src/main/linkedin/linkedInRepository';

export async function createLinkedInFixture(target = 'https://www.linkedin.com/in/fictional-person') {
  const f = await createCampaignFixture();
  try {
    const personId = randomUUID();
    f.db.raw.prepare('INSERT INTO persons(id,display_name,created_at,updated_at) VALUES(?,?,?,?)').run(personId, 'Fictional Person', f.now, f.now);
    const accounts = new AccountRepository({ database: f.db, clock: f.clock, ids: { next: randomUUID }, sourcePolicy: { attest: () => true } });
    const sourceId = randomUUID(); const routeId = randomUUID();
    accounts.admitEvidence({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: 2,
      sources: [{ id: sourceId, url: 'https://example.invalid/team', fetchedAt: f.now, sha256: 'c'.repeat(64), excerpt: 'Fictional Person, business contact.', permitted: true }], claims: [],
      routes: [{ id: routeId, accountId: f.account.id, personId, channel: 'linkedin', value: target, purpose: 'business', verification: 'published', evidenceIds: [sourceId] }] });
    const version = { ...f.versions[0]!, id: randomUUID(), campaignId: randomUUID(), steps: [{ id: randomUUID(), channel: 'linkedin' as const, condition: 'initial' as const, delayHours: 0 }] };
    f.repo.createVersion({ commandId: randomUUID(), version });
    f.repo.approve({ commandId: randomUUID(), campaignVersionId: version.id, snapshotHash: accountFingerprint(version), approvedAt: f.now });
    const enrollment = f.repo.enroll({ commandId: randomUUID(), accountId: f.account.id, selectedRouteId: routeId, campaignVersionId: version.id, executionContextId: randomUUID(), contextRevision: 0 });
    const deps = { database: f.db, workspaceId: f.workspaceId, enrollmentId: enrollment.id, clock: f.clock };
    return { ...f, personId, routeId, version, enrollment, deps, drafts: new LinkedInRepository(deps) };
  } catch (error) { f.close(); throw error; }
}
