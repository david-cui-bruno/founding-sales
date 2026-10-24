import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NATIONAL_DNC_OWNER_APPROVED_AT, NATIONAL_DNC_OWNER_DECISION, NATIONAL_DNC_UNCHECKED_WARNING } from '@fss/contracts';
import { installWeekdayClock } from '@fss/domain/test/support/weekdayClock.ts';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';
let f: AuthFixture, token: string, firmId: string, routeId: string, receiptId: string;
const endpoint = '+12125550187';
const command = () => ({ commandId: randomUUID(), clientVersion: '1.0.56', firmId, routeId, routeVersion: 1 });
async function request(method: 'GET' | 'POST', path: string, body?: unknown) {
  return await dispatch({ method, path, query: new URLSearchParams({ firmId, routeId }), headers: { authorization: `Bearer ${token}` }, body },
    { session: f.db, supportedClientVersions: f.deps.config.supportedClientVersions, sendingEnabled: false, auth: f.deps });
}
beforeAll(async () => {
  const base = await createAuthFixture();
  f = { ...base, deps: { ...base.deps, config: { ...base.deps.config,
    supportedClientVersions: { minimum: '1.0.0', ceiling: '1.x', incompatible: [] } } } };
  await installWeekdayClock(f.database);
  f.setNow(new Date());
  token = (await issueSessionFor(f, f.alpha, f.alpha.admin)).accessToken;
  firmId = await seedFirm(f, { name: 'Synthetic internal phone test', regionCode: 'RI', postalCode: '02903', assignedUserId: f.alpha.admin.userId });
  expect((await request('POST', '/firms/resolve-zone', { commandId: randomUUID(), clientVersion: '1.0.56', firmId })).status).toBe(200);
  await f.db.query("UPDATE firms SET time_zone='Etc/UTC' WHERE id=$1", [firmId]);
  routeId = (await f.db.query<{ id: string }>(`INSERT INTO phone_routes(workspace_id,firm_id,e164,source,retrieved_at,technical_validation,association_confidence)
    VALUES($1,$2,$3,'salesperson',now(),'passed',0.95) RETURNING id`, [f.alpha.workspaceId, firmId, endpoint])).rows[0]!.id;
  await f.db.query(`INSERT INTO state_postures(workspace_id,state,revision,effective_from,review_at,rules_revision,confirmed_statements,sources,confirmed_by_user_id)
    VALUES($1,'RI',1,'2026-01-01','2027-01-01',2,ARRAY['businessToBusiness','registrationStatusChecked','stateDncSubscriptionChecked','consentRuleConfirmed'],'[]',$2)`, [f.alpha.workspaceId, f.alpha.admin.userId]);
  receiptId = (await f.db.query<{ id: string }>(`INSERT INTO phone_owner_risk_receipts(workspace_id,owner_user_id,decision_at,approval_reference,self_test_firm_id,self_test_e164)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [f.alpha.workspaceId, f.alpha.admin.userId, NATIONAL_DNC_OWNER_APPROVED_AT, NATIONAL_DNC_OWNER_DECISION, firmId, endpoint])).rows[0]!.id;
});
afterAll(async () => { await f?.stop(); });
describe('owner-risk disclosure across genuine authenticated command boundary', () => {
  it('supplies pre-click advice from the server, not a client bypass flag', async () => {
    expect((await request('POST', '/dial/check', { firmId, routeId })).body).toMatchObject({ advice: { nationalDnc: {
      status: 'not_checked_owner_risk', receiptId, warning: NATIONAL_DNC_UNCHECKED_WARNING } } });
  });
  it('refuses old, missing, null and different displayed receipts before any durable attempt', async () => {
    for (const input of [ { ...command(), clientVersion: '1.0.55', expectedNationalDncReceiptId: receiptId }, command(),
      { ...command(), expectedNationalDncReceiptId: null }, { ...command(), expectedNationalDncReceiptId: randomUUID() } ]) {
      expect((await request('POST', '/dial/handoff', input)).body).toMatchObject({ status: 'refused', reason: 'dnc_coverage_unknown' });
    }
    expect((await f.db.query('SELECT id FROM phone_handoff_attempts')).rows).toEqual([]);
  });
  it('commits an identity-only receipt, returns disclosure only fresh, and permanently consumes self-test', async () => {
    const input = { ...command(), expectedNationalDncReceiptId: receiptId };
    const answer = await request('POST', '/dial/handoff', input);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const result = (answer.body as { result: { attemptId: string } }).result;
    expect(answer.body).toMatchObject({ result: { actionable: true, nationalDnc: { receiptId, warning: NATIONAL_DNC_UNCHECKED_WARNING } } });
    expect((await f.db.query('SELECT result FROM command_receipts WHERE command_id=$1', [input.commandId])).rows[0]?.['result']).toEqual({ attemptId: result.attemptId });
    expect((await request('POST', '/dial/handoff', input)).body).toMatchObject({ replayed: true, result: { actionable: false, telUri: null } });
    expect((await request('POST', '/dial/handoff', { ...command(), expectedNationalDncReceiptId: receiptId })).body).toMatchObject({ reason: 'dnc_coverage_unknown' });
    expect((await f.db.query('SELECT id FROM phone_handoff_attempts')).rows).toHaveLength(1);
  });
});
