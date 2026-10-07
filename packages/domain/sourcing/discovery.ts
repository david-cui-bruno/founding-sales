import {requestQualification} from './qualificationStore.ts';
import {withTransaction,type SessionQueryable} from '../db/queryable.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {decideAdminOnly} from '../crm/authorization.ts';
import {readResearchSettings} from '../research/settings.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {saveCandidate} from './candidates.ts';
import type {DiscoverySearchProvider,DiscoverySearchResult} from './discoveryProvider.ts';
import {sourcingUrlSchema} from '@fss/contracts';
import {recordCrmAuditEvent} from '../crm/audit.ts';

export {DISCOVERY_QUERIES} from './discoveryQueries.ts';
import {ensureTargetingPolicy} from './targetingProposals.ts';
async function allowed(ctx:RepositoryContext):Promise<boolean>{
 return decideAdminOnly(ctx).permitted&&(await readResearchSettings(ctx)).enabled&&(await listApplicableHolds(ctx,{actionKind:'research'})).length===0;
}
/** This owns transactions: call only outside an enclosing job transaction.
 * A committed dispatch is never retried, even when the process dies before network.
 */
export async function runDiscovery(ctx:RepositoryContext,provider:DiscoverySearchProvider):Promise<void>{
 const db=ctx.db as SessionQueryable;
 const attempt=await withTransaction(db,async()=>{
  if(!await allowed(ctx))return null;
  const settings=(await db.query<{query_cursor:number}>(`SELECT query_cursor FROM sourcing_discovery_settings WHERE workspace_id=$1 AND enabled AND next_run_at<=now() FOR UPDATE`,[ctx.scope.workspaceId])).rows[0];
  if(!settings)return null;
  const account=(await db.query<{halted:boolean;daily_used:number;monthly_used:number}>(`SELECT halted,daily_used,monthly_used FROM sourcing_search_account WHERE id=true FOR UPDATE`)).rows[0];
  if(!account){await db.query("UPDATE sourcing_discovery_settings SET last_result='account_not_configured' WHERE workspace_id=$1",[ctx.scope.workspaceId]);return null;}
  await db.query(`UPDATE sourcing_search_account SET daily_used=CASE WHEN day=(now() AT TIME ZONE 'UTC')::date THEN daily_used ELSE 0 END,monthly_used=CASE WHEN month=date_trunc('month',now() AT TIME ZONE 'UTC')::date THEN monthly_used ELSE 0 END,day=(now() AT TIME ZONE 'UTC')::date,month=date_trunc('month',now() AT TIME ZONE 'UTC')::date WHERE id=true`);
  const pending=(await db.query<{expired:boolean}>("SELECT created_at<now()-interval '2 minutes' AS expired FROM sourcing_discovery_attempts WHERE state='dispatched' ORDER BY created_at LIMIT 1")).rows[0];
  if(pending){if(pending.expired)await db.query('UPDATE sourcing_search_account SET halted=true WHERE id=true');return null;}
  const budget=(await db.query<{halted:boolean;daily_used:number;monthly_used:number}>('SELECT halted,daily_used,monthly_used FROM sourcing_search_account WHERE id=true')).rows[0]!;
  if(budget.halted)return null; // Keep the original provider failure visible until reconciliation.
  if(budget.daily_used>=20||budget.monthly_used>=600){await db.query("UPDATE sourcing_discovery_settings SET last_result='quota_exhausted' WHERE workspace_id=$1",[ctx.scope.workspaceId]);return null;}
  const policy=await ensureTargetingPolicy(ctx);
  const query=policy.queries[settings.query_cursor%policy.queries.length]!;
  const row=(await db.query<{id:string;day:Date}>(`INSERT INTO sourcing_discovery_attempts(workspace_id,query_id,query,policy_version) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,day) DO NOTHING RETURNING id,day`,[ctx.scope.workspaceId,query.id,query.query,policy.version])).rows[0];
  if(!row)return null;
  await db.query('UPDATE sourcing_search_account SET daily_used=daily_used+1,monthly_used=monthly_used+1 WHERE id=true');
  await db.query("UPDATE sourcing_discovery_settings SET next_run_at=now()+interval '1 day',query_cursor=query_cursor+1,last_result='dispatched' WHERE workspace_id=$1",[ctx.scope.workspaceId]);
  return {id:row.id,query};
 });
 if(!attempt)return;
 let result:DiscoverySearchResult;
 try{result=await provider.discover({query:attempt.query.query});}catch{result={ok:false,code:'unavailable'};}
 if(result.ok&&result.credits!==1)result={ok:false,code:'usage_unexpected'};
 const answer=result;
 await withTransaction(db,async()=>{
  if(!answer.ok){
   await db.query('UPDATE sourcing_search_account SET halted=true WHERE id=true');
   await recordCrmAuditEvent(ctx,{action:'sourcing.discovery_failed',subjectKind:'sourcing_discovery_attempt',subjectId:attempt.id,detail:{code:answer.code,provider:provider.providerKey}});
  }else{
   const observed=(await db.query<{day:string}>("SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day")).rows[0]!.day;
   for(const hit of answer.hits.slice(0,5)){
    if(!sourcingUrlSchema.safeParse(hit.url).success)continue;
    const inserted=await db.query('INSERT INTO sourcing_discovery_hits(workspace_id,source_url,attempt_id,native_result) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING source_url',[ctx.scope.workspaceId,hit.url,attempt.id,JSON.stringify(hit)]);
    if(inserted.rows.length===0)continue;
    const existing=(await db.query<{id:string}>("SELECT id FROM sourcing_candidates WHERE workspace_id=$1 AND (payload->>'sourceUrl'=$2 OR payload->>'website'=$2) LIMIT 1",[ctx.scope.workspaceId,hit.url])).rows[0];
    if(existing){await db.query('UPDATE sourcing_discovery_hits SET candidate_id=$3 WHERE workspace_id=$1 AND source_url=$2',[ctx.scope.workspaceId,hit.url,existing.id]);continue;}
    const host=new URL(hit.url).hostname.replace(/^www\./,'');
    const known=(await db.query("SELECT id FROM firms WHERE workspace_id=$1 AND regexp_replace(lower(split_part(website,'/',3)),'^www\\.','')=$2 LIMIT 1",[ctx.scope.workspaceId,host])).rows.length>0;
    const saved=await saveCandidate(ctx,{firmName:hit.title.trim().slice(0,300)||new URL(hit.url).hostname,website:hit.url,locality:attempt.query.locality,region:attempt.query.region,signal:'fit_only',evidence:hit.snippet.trim().slice(0,2000)||'Search returned no excerpt; source verification required.',sourceUrl:hit.url,observedOn:observed,preparedBy:'Tavily Basic search · not verified',discoveryKnownDomain:known,discoveryQuery:attempt.query.query});
    if(!saved.ok)throw new Error('discovery_candidate_invalid');
    await requestQualification(ctx,{candidateId:saved.value.id,expectedRevision:1});
    await db.query('UPDATE sourcing_discovery_hits SET candidate_id=$3 WHERE workspace_id=$1 AND source_url=$2',[ctx.scope.workspaceId,hit.url,saved.value.id]);
   }
  }
  await db.query('UPDATE sourcing_discovery_attempts SET state=$2,request_id=$4 WHERE id=$1 AND workspace_id=$3',[attempt.id,answer.ok?'complete':'failed',ctx.scope.workspaceId,answer.ok?answer.requestId:null]);
  await db.query('UPDATE sourcing_discovery_settings SET last_result=$2 WHERE workspace_id=$1',[ctx.scope.workspaceId,answer.ok?'complete':answer.code]);
 });
}
