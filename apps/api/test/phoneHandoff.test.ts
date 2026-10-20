import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { phoneHandoffResultSchema } from '@fss/contracts';
import * as registry from '@fss/domain/dial/registryCoverage.ts';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm, seedContact } from './support/crmSeed.ts';
import { publishTestRegistrySnapshot } from '../../../packages/domain/test/support/nationalRegistry.ts';
let f: AuthFixture;
let token: string;
let firmId: string;
let routeId: string;
let authorityAt = '2026-09-16T14:00:01.000Z';
const e164 = '+14015550187';
const at = '2026-09-16T14:00:00.000Z';
const command = () => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, firmId, routeId, routeVersion: 1 });
async function post(body: unknown, path = '/dial/handoff', access = token) {
  return await dispatch({ method: 'POST', path, query: new URLSearchParams(), headers: { authorization: `Bearer ${access}` }, body },
    { session: f.db, supportedClientVersions: f.deps.config.supportedClientVersions, sendingEnabled: false, auth: f.deps });
}
beforeAll(async () => {
  f = await createAuthFixture();
  const query = f.db.query.bind(f.db);
  // Policy evidence and the final post-lock clock must share the fixture timeline.
  // Only substitute this clock read. Authority locks and every write remain real PG.
  vi.spyOn(f.db, 'query').mockImplementation(async (text, values) =>
    await query(text === 'SELECT clock_timestamp() AS at' ? 'SELECT $1::timestamptz AS at' : text,
      text === 'SELECT clock_timestamp() AS at' ? [authorityAt] : values));
  token = (await issueSessionFor(f, f.alpha, f.alpha.salesperson)).accessToken;
  firmId = await seedFirm(f, { name: 'Fixture phone only', regionCode: 'RI', postalCode: '02903', assignedUserId: f.alpha.salesperson.userId });
  const adminToken = (await issueSessionFor(f, f.alpha, f.alpha.admin)).accessToken;
  expect((await post({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, firmId }, '/firms/resolve-zone', adminToken)).status).toBe(200);
  const contactId = await seedContact(f, { firmId, fullName: 'Fixture Person' });
  routeId = (await f.db.query<{ id: string }>(`INSERT INTO phone_routes(workspace_id,firm_id,contact_id,e164,source,retrieved_at,technical_validation,association_confidence)
    VALUES($1,$2,$3,$4,'salesperson',now(),'passed',0.95) RETURNING id`, [f.alpha.workspaceId, firmId, contactId, e164])).rows[0]?.id ?? '';
  await f.db.query(`INSERT INTO state_postures(workspace_id,state,revision,effective_from,review_at,rules_revision,confirmed_statements,sources,confirmed_by_user_id)
    VALUES($1,'RI',1,'2026-01-01','2027-01-01',2,ARRAY['businessToBusiness','registrationStatusChecked','stateDncSubscriptionChecked','consentRuleConfirmed'],'[]',$2)`, [f.alpha.workspaceId, f.alpha.admin.userId]);
  const original = registry.readPhoneRegistryDecision;
  vi.spyOn(registry, 'readPhoneRegistryDecision').mockImplementation(async (context, endpoint) => await original(context, endpoint, at));
});
afterAll(async () => { vi.restoreAllMocks(); await f.stop(); });
describe('phone handoff dispatcher and durable command receipts', () => {
  it('has no hidden time/bypass wire field and no unauthenticated admission', async () => {
    expect((await post(command(), '/dial/handoff', 'invalid')).status).toBe(401);
    expect((await post({ ...command(), at })).status).toBe(400);
  });
  it('absent SAN/download evidence refuses and creates no reservation', async () => {
    const answer = await post(command());
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ reason: 'dnc_coverage_unknown' });
    expect((await f.db.query('SELECT id FROM phone_handoff_attempts')).rows).toHaveLength(0);
  });
  it('commits one opaque receipt and returns only the original fresh URI, never on replay or a new command', async () => {
    await publishTestRegistrySnapshot(f.db, f.alpha.workspaceId, { downloadedAt: '2026-09-01T00:00:00Z',
      publishedAt: '2026-09-15T00:00:00Z', e164s: [{ e164, result: 'clear' }] });
    authorityAt = '2026-09-16T14:00:16.000Z';
    const expired = await post(command());
    expect(expired.status).toBe(409);
    expect(expired.body).toMatchObject({ reason: 'phone_handoff_unavailable' });
    expect((await f.db.query('SELECT id FROM phone_handoff_attempts')).rows).toHaveLength(0);
    authorityAt = '2026-09-16T14:00:01.000Z';
    const input = command();
    const answer = await post(input);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const envelope = answer.body as { result: unknown };
    const fresh = phoneHandoffResultSchema.parse(envelope.result);
    expect(fresh).not.toHaveProperty('nationalDnc'); // Older strict fresh-result parsers still work.
    expect(fresh).toMatchObject({ actionable: true, e164, telUri: `tel:${e164}`,
      reservedAt: at, expiresAt: '2026-09-16T14:00:15.000Z', validForMilliseconds: 15000 });
    const receipt = (await f.db.query<{ result: unknown }>('SELECT result FROM command_receipts WHERE command_id=$1', [input.commandId])).rows[0];
    expect(receipt?.result).toEqual({ attemptId: fresh.attemptId });
    expect((await post(input)).body).toMatchObject({ replayed: true, result: { attemptId: fresh.attemptId, actionable: false, e164: null, telUri: null } });
    expect((await post(command())).body).toMatchObject({ reason: 'call_attempt_today' });
    expect((await f.db.query('SELECT id FROM phone_handoff_attempts')).rows).toHaveLength(1);
  });
});
