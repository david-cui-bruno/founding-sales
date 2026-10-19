import { randomUUID } from 'node:crypto';
import type { TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm } from '../db/support/crmFixtures.ts';
import { seedPolicy } from '../db/support/policyFixtures.ts';
import { reservePhoneHandoff } from '../../dial/phoneHandoff.ts';

export async function phoneFixture(database: TestDatabase) {
  const seeded = await seedTwoWorkspaces(database.session);
  const crm = await seedCrm(database.session, seeded);
  const policy = await seedPolicy(database.session, seeded, crm);
  const w = seeded.alpha.workspaceId;
  const context = repositoryContext(workspaceScope(w, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }), database.session);
  const request = () => ({ commandId: randomUUID(), clientVersion: '1.0.0', firmId: crm.alpha.firmId,
    routeId: policy.alpha.phoneRouteId, routeVersion: policy.alpha.phoneRouteVersion, deviceId: seeded.alpha.salesperson.deviceId, at: policy.insideWindow });
  async function publish(overrides: { downloadedAt?: string; publishedAt?: string; complete?: boolean; covered?: string[]; revokedAt?: string | null; result?: 'clear' | 'match' | null } = {}) {
    const snapshot = (await database.session.query<{ id: string }>(`INSERT INTO national_registry_snapshots
      (workspace_id,receipt_reference,downloaded_at,published_at,complete,covered_area_codes,revoked_at)
      VALUES($1,'fixture-only-SAN-not-real',$2,$3,$4,$5,$6) RETURNING id`, [w, overrides.downloadedAt ?? '2026-09-01T00:00:00Z',
      overrides.publishedAt ?? '2026-09-15T00:00:00Z', overrides.complete ?? true, overrides.covered ?? ['401'], overrides.revokedAt ?? null])).rows[0];
    if (!snapshot) throw new Error('missing fixture snapshot');
    if (overrides.result !== null) await database.session.query(`INSERT INTO national_registry_endpoint_scrubs(workspace_id,snapshot_id,e164,scrubbed_at,result)
      VALUES($1,$2,$3,$4,$5)`, [w, snapshot.id, policy.alpha.e164, overrides.publishedAt ?? '2026-09-15T00:00:00Z', overrides.result ?? 'clear']);
    return snapshot.id;
  }
  async function reserve(overrides: Partial<ReturnType<typeof request>> = {}) {
    return await reservePhoneHandoff(context, { ...request(), ...overrides });
  }
  return { database, seeded, crm, policy, w, context, request, publish, reserve };
}
export type PhoneFixture = Awaited<ReturnType<typeof phoneFixture>>;
