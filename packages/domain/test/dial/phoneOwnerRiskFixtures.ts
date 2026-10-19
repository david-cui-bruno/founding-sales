import { randomUUID } from 'node:crypto';
import { NATIONAL_DNC_OWNER_APPROVED_AT, NATIONAL_DNC_OWNER_DECISION } from '@fss/contracts';
import { createTestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { withTransaction } from '../../db/queryable.ts';
import { reservePhoneHandoff } from '../../dial/phoneHandoff.ts';
import { phoneFixture } from './phoneHandoffFixtures.ts';
import { runFirmResearch } from '../../research/enrichment.ts';
import { officeHtml, officeProviders } from '../support/officeProviders.ts';

export const riskEndpoint = '+12125550187';
export async function ownerRiskFixture(selfTest = true) {
  const database = await createTestDatabase();
  const f = await phoneFixture(database);
  const owner = f.seeded.alpha.admin;
  await database.session.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [f.w, f.seeded.alpha.salesperson.userId]);
  const offset = new Date().getUTCHours() - 12;
  const zone = `Etc/GMT${offset >= 0 ? '+' : ''}${offset}`;
  await database.session.query('UPDATE firms SET time_zone=$2 WHERE workspace_id=$1 AND id=$3', [f.w, zone, f.crm.alpha.firmId]);
  await database.session.query('UPDATE firms SET assigned_user_id=$2 WHERE workspace_id=$1 AND id=$3', [f.w, owner.userId, f.crm.alpha.firmId]);
  await database.session.query('UPDATE phone_routes SET e164=$2 WHERE workspace_id=$1 AND id=$3', [f.w, riskEndpoint, f.policy.alpha.phoneRouteId]);
  const privateFirm = selfTest ? f.crm.alpha.firmId : (await database.session.query<{ id: string }>(
    "INSERT INTO firms(workspace_id,name) VALUES($1,'Synthetic internal self test') RETURNING id", [f.w])).rows[0]!.id;
  const receipt = (await database.session.query<{ id: string }>(`INSERT INTO phone_owner_risk_receipts
    (workspace_id,owner_user_id,decision_at,approval_reference,self_test_firm_id,self_test_e164)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [f.w, owner.userId, NATIONAL_DNC_OWNER_APPROVED_AT,
    NATIONAL_DNC_OWNER_DECISION, privateFirm, selfTest ? riskEndpoint : '+14695550199'])).rows[0]!;
  const runtime = await database.appRuntimeSession();
  const context = repositoryContext(workspaceScope(f.w, { kind: 'user', role: 'admin', userId: owner.userId }), runtime);
  const request = () => ({ commandId: randomUUID(), clientVersion: '1.0.56', firmId: f.crm.alpha.firmId,
    routeId: f.policy.alpha.phoneRouteId, routeVersion: f.policy.alpha.phoneRouteVersion, deviceId: owner.deviceId,
    expectedNationalDncReceiptId: receipt.id });
  const reserve = (overrides: Partial<ReturnType<typeof request>> = {}) => withTransaction(runtime,
    () => reservePhoneHandoff(context, { ...request(), ...overrides }));
  async function assess(html = officeHtml.replace('(401)', '(212)')) {
    await database.session.query('INSERT INTO research_settings(workspace_id,enabled) VALUES($1,true)', [f.w]);
    const providers = officeProviders({ retrievedAt: new Date(Date.now() - 1000).toISOString(), html });
    const answer = await runFirmResearch(context, { firmId: f.crm.alpha.firmId, revision: 1, trigger: 'user_request',
      requestedByUserId: owner.userId, purpose: 'office_evidence', at: new Date().toISOString(), ...providers });
    if (!answer.ok) throw new Error(answer.reason);
    return providers;
  }
  return { ...f, context, runtime, owner, receiptId: receipt.id, request, reserve, assess };
}
export type OwnerRiskFixture = Awaited<ReturnType<typeof ownerRiskFixture>>;
