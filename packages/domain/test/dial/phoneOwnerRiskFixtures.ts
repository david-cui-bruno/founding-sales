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
  try {
    const current = (await database.session.query<{ name: string }>('SELECT current_database() AS name')).rows[0]?.name;
    if (current !== database.name || !/^fss_test_[a-f0-9]{32}$/u.test(current)) throw new Error('Expected exact owned test database');
    // Shift JS and database-local clocks to Monday noon, retaining real elapsed
    // time, row ordering, lock waits and expiry. Trigger/default clocks must agree.
    const NativeDate = Date;
    const at = new NativeDate();
    at.setUTCDate(at.getUTCDate() + ((8 - at.getUTCDay()) % 7 || 7));
    at.setUTCHours(12, 0, 0, 0);
    const offset = at.getTime() - NativeDate.now();
    await database.session.query(`CREATE FUNCTION public.owner_risk_wall_clock() RETURNS timestamptz
      LANGUAGE internal VOLATILE PARALLEL SAFE AS 'clock_timestamp'`);
    for (const [name, clock, volatility] of [['clock_timestamp', 'public.owner_risk_wall_clock()', 'VOLATILE'],
      ['now', 'pg_catalog.transaction_timestamp()', 'STABLE']] as const) {
      await database.session.query(`CREATE OR REPLACE FUNCTION pg_catalog.${name}() RETURNS timestamptz
        LANGUAGE sql ${volatility} PARALLEL SAFE AS $$ SELECT ${clock} + interval '${offset} milliseconds' $$`);
    }
    // A Date-only proxy changes no timers. Explicit date arguments remain literal.
    globalThis.Date = new Proxy(NativeDate, {
      construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [NativeDate.now() + offset], newTarget),
      apply: () => new NativeDate(NativeDate.now() + offset).toString(),
      get: (target, key, receiver) => key === 'now' ? () => NativeDate.now() + offset : Reflect.get(target, key, receiver),
    });
    const drop = database.drop;
    database.drop = async () => { try { await drop(); } finally { globalThis.Date = NativeDate; } };
    const f = await phoneFixture(database);
    const owner = f.seeded.alpha.admin;
    await database.session.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [f.w, f.seeded.alpha.salesperson.userId]);
    await database.session.query("UPDATE firms SET time_zone='Etc/UTC' WHERE workspace_id=$1 AND id=$2", [f.w, f.crm.alpha.firmId]);
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
  } catch (error) { await database.drop(); throw error; }
}
export type OwnerRiskFixture = Awaited<ReturnType<typeof ownerRiskFixture>>;
