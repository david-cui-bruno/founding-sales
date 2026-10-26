import {firmNameKey,websiteDomain} from '../crm/import.ts';
import type {CandidateInput} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';

export async function retainedCandidateOnly(ctx:RepositoryContext,candidateId:string):Promise<boolean>{
 return (await ctx.db.query('SELECT id FROM sourcing_retained_identity_decisions WHERE workspace_id=$1 AND candidate_id=$2 LIMIT 1',[ctx.scope.workspaceId,candidateId])).rows.length>0;
}
export async function retainedFirmOnly(ctx:RepositoryContext,firmId:string):Promise<boolean>{
 return (await ctx.db.query('SELECT firm_id FROM sourcing_retained_firm_acquisition_fences WHERE workspace_id=$1 AND firm_id=$2',[ctx.scope.workspaceId,firmId])).rows.length>0;
}
/** Snapshot only after the calling owner has obtained every authority/evidence lock. */
export async function retainedWallNow(ctx:RepositoryContext):Promise<string>{
 const row=(await ctx.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0];
 if(!row)throw Error('Database clock unavailable');
 return row.at.toISOString();
}
export async function lockRetainedAdmin(ctx:RepositoryContext):Promise<boolean>{
 const actor=ctx.scope.actor;
 if(actor.kind!=='user'||actor.role!=='admin')return false;
 return (await ctx.db.query("SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' AND role='admin' FOR SHARE",[ctx.scope.workspaceId,actor.userId])).rows.length===1;
}
/** A missing/dead job is not proof that its run/provider call did not happen. */
export async function candidateAcquisitionOutstanding(ctx:RepositoryContext,candidateId:string):Promise<boolean>{
 return (await ctx.db.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM sourcing_qualification_runs WHERE workspace_id=$1 AND candidate_id=$2 AND state IN ('pending','running'))
 OR EXISTS(SELECT 1 FROM sourcing_prospect_phone_discoveries WHERE workspace_id=$1 AND candidate_id=$2 AND (state IN ('pending','running') OR (dispatched_at IS NOT NULL AND dispatch_finished_at IS NULL)))
 OR EXISTS(SELECT 1 FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 AND source_check->>'state'='pending')
 OR EXISTS(SELECT 1 FROM jobs WHERE workspace_id=$1 AND state IN ('queued','retryable','running') AND kind IN ('sourcing.qualify','sourcing.check') AND payload->>'candidateId'=$2::text)
 OR EXISTS(SELECT 1 FROM provider_reservations p JOIN sourcing_qualification_runs r ON r.workspace_id=p.workspace_id AND r.id=p.subject_id WHERE r.workspace_id=$1 AND r.candidate_id=$2 AND p.subject_kind='sourcing_qualification' AND p.state IN ('reserved','calling','estimated'))`,[ctx.scope.workspaceId,candidateId])).rows.length>0;
}
export async function firmAcquisitionOutstanding(ctx:RepositoryContext,firmId:string):Promise<boolean>{
 return (await ctx.db.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM research_runs WHERE workspace_id=$1 AND firm_id=$2 AND outcome='running')
 OR EXISTS(SELECT 1 FROM jobs WHERE workspace_id=$1 AND kind='research.firm' AND payload->>'firmId'=$2::text AND state IN ('queued','running','retryable'))
 OR EXISTS(SELECT 1 FROM provider_reservations p JOIN research_runs r ON r.workspace_id=p.workspace_id AND r.id=p.subject_id WHERE r.workspace_id=$1 AND r.firm_id=$2 AND p.subject_kind='research_run' AND p.state IN ('reserved','calling','estimated'))`,[ctx.scope.workspaceId,firmId])).rows.length>0;
}
/** Internal CRM seam. The caller owns the Firm lock and surrounding admission savepoint. */
export async function fenceRetainedFirm(ctx:RepositoryContext,firmId:string,decisionId:string):Promise<boolean>{
 if(!await lockRetainedAdmin(ctx))return false;
 const decision=(await ctx.db.query<{candidate_id:string;payload:CandidateInput}>(`SELECT d.candidate_id,c.payload FROM sourcing_retained_identity_decisions d JOIN sourcing_candidates c ON c.workspace_id=d.workspace_id AND c.id=d.candidate_id
 JOIN sourcing_qualification_runs r ON r.workspace_id=d.workspace_id AND r.retained_identity_decision_id=d.id
 WHERE d.workspace_id=$1 AND d.id=$2 AND c.revision=d.result_revision AND r.candidate_revision=c.revision AND r.reason IS NULL AND r.state IN ('review','eligible')
 AND NOT EXISTS(SELECT 1 FROM sourcing_qualification_runs n WHERE n.workspace_id=r.workspace_id AND n.candidate_id=r.candidate_id AND (n.requested_at,n.id)>(r.requested_at,r.id)) FOR UPDATE OF c,r`,[ctx.scope.workspaceId,decisionId])).rows[0];
 if(!decision||await firmAcquisitionOutstanding(ctx,firmId))return false;
 const firm=(await ctx.db.query<{name:string;website:string|null;locality:string|null;region_code:string|null;assigned_user_id:string|null}>('SELECT name,website,locality,region_code,assigned_user_id FROM firms WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,firmId])).rows[0];
 const actor=ctx.scope.actor,payload=decision.payload;
 if(!firm||actor.kind!=='user'||firm.assigned_user_id!==actor.userId||firmNameKey(firm.name)!==firmNameKey(payload.firmName)||websiteDomain(firm.website)!==websiteDomain(payload.website)||firmNameKey(firm.locality??'')!==firmNameKey(payload.locality)||firm.region_code!==payload.region)return false;
 await ctx.db.query('INSERT INTO sourcing_retained_firm_acquisition_fences(workspace_id,firm_id,decision_id,candidate_id) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,firm_id) DO NOTHING',[ctx.scope.workspaceId,firmId,decisionId,decision.candidate_id]);
 return true;
}
