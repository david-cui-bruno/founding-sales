import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';

let fixture: AuthFixture;
let token: string;
const command = (fields: Record<string, unknown>) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...fields });
const post = (path: string, body: unknown, bearer = token) => dispatch({ method: 'POST', path, query: new URLSearchParams(), headers: { authorization: `Bearer ${bearer}` }, body }, { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false });
beforeAll(async () => { fixture = await createAuthFixture(); token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken; });
afterAll(async () => fixture.stop());

it('resolves selected evidence through authenticated commands and positive profile Route readback without granting send permission', async () => {
  const firmId = await seedFirm(fixture, { name: 'Harbor Management', locality: 'Providence', regionCode: 'RI', assignedUserId: fixture.alpha.salesperson.userId });
  const created = await post('/crm/people/create', command({ fullName: 'Taylor Park' }));
  const personId = (created.body as { result: { personId: string } }).result.personId;
  const profile = 'https://www.linkedin.com/in/taylor-park-626';
  await post('/crm/people/source/add', command({ personId, sourceKey: randomUUID(), excerpt: `Taylor Park is the owner of Harbor Management. Taylor Park's LinkedIn profile is ${profile}.\nHarbor Management is an independent residential property management firm serving Providence, Rhode Island.`, occurredAt: '2026-10-13T14:00:00.000Z' }));
  const page = await post('/crm/people/read', { personId });
  const source = (page.body as { sources: { sourceId: string; revision: number; contentHash: string }[] }).sources[0]!;
  const evidence = { sourceId: source.sourceId, sourceRevision: source.revision, contentHash: source.contentHash };
  const relationship = await post('/crm/relationships/save', command({ personId, firmId, status: 'current', startDate: null, endDate: null, evidence }));
  const relationshipId = (relationship.body as { result: { relationshipId: string } }).result.relationshipId;
  const claimed = await post('/crm/endpoints/claim', command({ personId, firmId: null, kind: 'linkedin', value: profile, shared: false, status: 'current', startDate: null, endDate: null, evidence }));
  expect(claimed.status).toBe(200);
  const { claimId, endpointId } = (claimed.body as { result: { claimId: string; endpointId: string } }).result;
  expect((await post('/crm/endpoints/list', { personId })).body).toMatchObject({ claims: [{ claimId, endpointId, kind: 'linkedin', value: profile, evidence }] });
  const assessed = await post('/crm/linkedin/routes/assess', { claimId });
  expect(assessed.status).toBe(200);
  expect(assessed.body).toMatchObject({ state: 'eligible', reason: 'supported_fit', route: { routeId: endpointId, claimId, profile, personId, firmId, relationshipId, relationshipRevision: 1, evidence }, sendingPermission: false, connectionState: 'unknown', maintenanceNeed: 'unknown', buyingIntent: 'unknown' });
});
