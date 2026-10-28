import { phoneHandoffResultSchema, type PhoneHandoffResult } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { withTransaction } from '../db/queryable.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { ownerRiskDisclosure, readOwnerRiskReceipt } from './phoneNationalPolicy.ts';
import { adviseDial } from './advise.ts';
import { readCallingProvider } from '../settings/integrations.ts';
import { readPhoneOfficeProof } from './phoneOfficeProof.ts';
import {lockPreparedCallingCapability} from '../calling/preparationLifecycle.ts';
import {readPreparationExecution} from '../calling/preparationExecution.ts';
import {readExecutionClearance} from './executionClearance.ts';

interface Attempt {
  [key: string]: unknown; id: string; firm_id: string; phone_route_id: string | null; e164: string | null;
  reserved_at: Date; expires_at: Date; erased_at: Date | null; national_dnc_basis: string;
  owner_risk_receipt_id: string | null; owner_risk_firm_id: string | null; device_id: string; route_version: number | null;
  office_proof_kind: 'admission' | 'office_assessment' | null; office_proof_id: string | null;
  calling_preparation_id:string|null;
}
const attemptSql = `SELECT id,firm_id,phone_route_id,e164,reserved_at,expires_at,erased_at,national_dnc_basis,
  owner_risk_receipt_id,owner_risk_firm_id,device_id,route_version,office_proof_kind,office_proof_id,calling_preparation_id FROM phone_handoff_attempts
  WHERE workspace_id=$1 AND id=$2 AND actor_user_id=$3`;
type Authority = (context: RepositoryContext, deviceId: string, userId: string, ownerRisk: boolean) => Promise<boolean>;

/** Risk-only final publication check. Never refresh or re-reserve the committed capability. */
export async function readPublishedPhoneHandoff(context: RepositoryContext, attemptId: string, replayed: boolean,
  authority: Authority): Promise<PhoneHandoffResult | null> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return null;
  const parameters = [context.scope.workspaceId, attemptId, actor.userId];
  let row = (await context.db.query<Attempt>(attemptSql, parameters)).rows[0];
  if (!row) return null;
  let publicationDeadline:number|null=null;
  let allowed = !replayed && row.erased_at === null && row.e164 !== null && row.phone_route_id !== null;
  if (allowed && (row.national_dnc_basis !== 'registry'||row.calling_preparation_id!==null)) {
    allowed = await withTransaction(context.db, async () => {
      await lockPreparedCallingCapability(context.db,context.scope.workspaceId,'handoff',attemptId);
      await lockSendGateForStopFact(context);
      row = (await context.db.query<Attempt>(`${attemptSql} FOR SHARE`, parameters)).rows[0];
      if (!row || row.erased_at || !row.e164 || !row.phone_route_id ||(row.national_dnc_basis!=='registry'&&row.firm_id !== row.owner_risk_firm_id)) return false;
      const preparation=await readPreparationExecution(context,row.firm_id);
      if(!preparation.ok)return false;
      const route = (await context.db.query<{ version: number; e164: string|null; firm_id: string; known_personal_cell_at: Date | null }>(
        'SELECT version,e164,firm_id,known_personal_cell_at FROM phone_routes WHERE workspace_id=$1 AND id=$2 FOR SHARE',
        [context.scope.workspaceId, row.phone_route_id])).rows[0];
      const firm = (await context.db.query<{ status: string; assigned_user_id: string | null }>(
        'SELECT status,assigned_user_id FROM firms WHERE workspace_id=$1 AND id=$2 FOR SHARE', [context.scope.workspaceId, row.firm_id])).rows[0];
      if (!route || route.firm_id !== row.firm_id || route.version !== row.route_version || route.e164 !== row.e164 ||
          (row.national_dnc_basis === 'office_owner_risk' && route.known_personal_cell_at !== null) ||
          firm?.status !== 'active' || firm.assigned_user_id !== actor.userId) return false;
      const now = (await context.db.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]?.at;
      if (!now || now.getTime() >= row.expires_at.getTime()) return false;
      if(row.national_dnc_basis==='registry'){
        const registry=await readExecutionClearance(context,row.e164);
        if(!registry.ok||!await authority(context,row.device_id,actor.userId,false))return false;
        if(await readCallingProvider(context)!=='tel'||!(await adviseDial(context,{firmId:row.firm_id,routeId:row.phone_route_id,at:now.toISOString(),omitNationalDnc:true}))?.callable
          ||!await authority(context,row.device_id,actor.userId,false))return false;
        const final=await readPreparationExecution(context,row.firm_id);if(!final.ok)return false;
        const clock=(await context.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]?.at;
        publicationDeadline=Math.min(row.expires_at.getTime(),Date.parse(registry.freshUntil),final.expiresAt?Date.parse(final.expiresAt):Infinity);
        return !!clock&&clock.getTime()<publicationDeadline;
      }
      const proof = row.national_dnc_basis === 'office_owner_risk' && row.office_proof_kind && row.office_proof_id
        ? await readPhoneOfficeProof(context, { firmId: row.firm_id, routeId: row.phone_route_id,
          routeVersion: row.route_version!, e164: row.e164, at: now.toISOString(),
          expected: { kind: row.office_proof_kind, id: row.office_proof_id } }) : null;
      if (row.national_dnc_basis === 'office_owner_risk' && !proof) return false;
      const receipt = await readOwnerRiskReceipt(context, now.toISOString());
      if (!receipt || receipt.id !== row.owner_risk_receipt_id ||
          (row.national_dnc_basis === 'owner_self_test' && (receipt.self_test_erased_at !== null ||
            receipt.self_test_firm_id !== row.owner_risk_firm_id || receipt.self_test_e164 !== row.e164))) return false;
      if (!await authority(context, row.device_id, actor.userId, true)) return false;
      if(!(await readPreparationExecution(context,row.firm_id)).ok)return false;
      const finalClock = (await context.db.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]?.at;
      // Current stop/policy predicates after all authority/proof waits. Cadence
      // admission would count this committed attempt; self-test is already used.
      if (!finalClock || await readCallingProvider(context) !== 'tel' || !(await adviseDial(context, {
        firmId: row.firm_id, routeId: row.phone_route_id, at: finalClock.toISOString(), omitNationalDnc: true }))?.callable) return false;
      if(!await authority(context,row.device_id,actor.userId,true))return false;
      const finalSource=await readPreparationExecution(context,row.firm_id);if(!finalSource.ok)return false;
      const publicationClock=(await context.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]?.at;
      publicationDeadline=Math.min(row.expires_at.getTime(),proof?Date.parse(proof.expiresAt):Infinity,receipt.valid_until?.getTime()??Infinity,finalSource.expiresAt?Date.parse(finalSource.expiresAt):Infinity);
      return !!publicationClock&&publicationClock.getTime()<publicationDeadline;
    });
  }
  if (!row) return null;
  if(publicationDeadline!==null&&Date.now()>=publicationDeadline)allowed=false;
  const identity = { attemptId: row.id, firmId: row.firm_id, routeId: row.phone_route_id,
    reservedAt: row.reserved_at.toISOString(), expiresAt: row.expires_at.toISOString() };
  return phoneHandoffResultSchema.parse(allowed
    ? { ...identity, actionable: true, e164: row.e164, telUri: `tel:${row.e164}`,
      validForMilliseconds: Math.floor(row.expires_at.getTime() - row.reserved_at.getTime()),
      ...(row.national_dnc_basis === 'registry' ? {} : {
        nationalDnc: ownerRiskDisclosure(row.owner_risk_receipt_id!, row.national_dnc_basis === 'owner_self_test') }) }
    : { ...identity, actionable: false, e164: null, telUri: null, validForMilliseconds: 0, reason: 'handoff_reconciliation_required' });
}
