import { randomUUID } from 'node:crypto';
import type { TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm } from '../db/support/crmFixtures.ts';
import { seedPolicy } from '../db/support/policyFixtures.ts';
import { publishTestRegistrySnapshot } from '../support/nationalRegistry.ts';
import { reservePhoneHandoff } from '../../dial/phoneHandoff.ts';

export async function phoneFixture(database: TestDatabase) {
  const seeded = await seedTwoWorkspaces(database.session);
  const crm = await seedCrm(database.session, seeded);
  const policy = await seedPolicy(database.session, seeded, crm, { registry: false });
  const w = seeded.alpha.workspaceId;
  const context = repositoryContext(workspaceScope(w, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }), database.session);
  const request = () => ({ commandId: randomUUID(), clientVersion: '1.0.0', firmId: crm.alpha.firmId,
    routeId: policy.alpha.phoneRouteId, routeVersion: policy.alpha.phoneRouteVersion, deviceId: seeded.alpha.salesperson.deviceId, at: policy.insideWindow });
  async function publish(overrides: { downloadedAt?: string; publishedAt?: string; complete?: boolean; covered?: string[]; revokedAt?: string | null; result?: 'clear' | 'match' | null } = {}) {
    if (overrides.complete === false || (overrides.covered && overrides.covered.join(',') !== '401,508,617,774,857')) {
      throw new Error('Invalid legacy publication requires the pre0124 migration fixture');
    }
    return await publishTestRegistrySnapshot(database.session, w, {
      ...(overrides.downloadedAt === undefined ? {} : { downloadedAt: overrides.downloadedAt }),
      ...(overrides.publishedAt === undefined ? {} : { publishedAt: overrides.publishedAt }),
      ...(overrides.revokedAt === undefined ? {} : { revokedAt: overrides.revokedAt }),
      e164s: overrides.result === null ? [] : [{ e164: policy.alpha.e164, result: overrides.result ?? 'clear' }],
    });
  }
  async function reserve(overrides: Partial<ReturnType<typeof request>> = {}) {
    return await reservePhoneHandoff(context, { ...request(), ...overrides });
  }
  return { database, seeded, crm, policy, w, context, request, publish, reserve };
}
export type PhoneFixture = Awaited<ReturnType<typeof phoneFixture>>;
