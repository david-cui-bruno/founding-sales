import {companyHost,discoveryFirmName} from './discoveryIdentity.ts';
import {discoveryListLeads,routeDiscoveryHits,type DiscoveryListLead} from './discoveryListLeads.ts';
import type {PageFetchProvider} from '../research/providers.ts';
import {withTransaction,type SessionQueryable} from '../db/queryable.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {decideAdminOnly} from '../crm/authorization.ts';
import {readResearchSettings} from '../research/settings.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {saveCandidate} from './candidates.ts';
import {DISCOVERY_RESULT_LIMIT,DISCOVERY_NEW_CANDIDATE_LIMIT,type DiscoverySearchProvider,type DiscoverySearchResult} from './discoveryProvider.ts';
import {sourcingUrlSchema} from '@fss/contracts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {discoveryQuotaRemaining} from './discoveryQuota.ts';

export {DISCOVERY_QUERIES} from './discoveryQueries.ts';
import {ensureTargetingPolicy} from './targetingProposals.ts';
async function allowed(ctx:RepositoryContext):Promise<boolean>{
 return decideAdminOnly(ctx).permitted&&(await readResearchSettings(ctx)).enabled&&(await listApplicableHolds(ctx,{actionKind:'research',channel:'research'})).length===0;
}
/** This owns transactions: call only outside an enclosing job transaction.
 * A committed dispatch is never retried, even when the process dies before network.
 * List-page fetches use the research fetcher outside every transaction (ADR0034).
 */
export async function runDiscovery(ctx:RepositoryContext,provider:DiscoverySearchProvider,pageFetch:PageFetchProvider):Promise<void>{
 const db=ctx.db as SessionQueryable;
 const attempt=await withTransaction(db,async()=>{
  if(!await allowed(ctx))return null;
  const settings=(await db.query<{query_cursor:number;searches_per_day:number}>(`SELECT query_cursor,searches_per_day FROM sourcing_discovery_settings WHERE workspace_id=$1 AND enabled AND next_run_at<=now() FOR UPDATE`,[ctx.scope.workspaceId])).rows[0];
  if(!settings)return null;
  const account=(await db.query<{halted:boolean;daily_used:number;monthly_used:number}>(`SELECT halted,daily_used,monthly_used FROM sourcing_search_account WHERE id=true FOR UPDATE`)).rows[0];
  if(!account){await db.query("UPDATE sourcing_discovery_settings SET last_result='account_not_configured' WHERE workspace_id=$1",[ctx.scope.workspaceId]);return null;}
  await db.query(`UPDATE sourcing_search_account SET daily_used=CASE WHEN day=(now() AT TIME ZONE 'UTC')::date THEN daily_used ELSE 0 END,monthly_used=CASE WHEN month=date_trunc('month',now() AT TIME ZONE 'UTC')::date THEN monthly_used ELSE 0 END,day=(now() AT TIME ZONE 'UTC')::date,month=date_trunc('month',now() AT TIME ZONE 'UTC')::date WHERE id=true`);
  const pending=(await db.query<{expired:boolean}>("SELECT created_at<now()-interval '2 minutes' AS expired FROM sourcing_discovery_attempts WHERE state='dispatched' ORDER BY created_at LIMIT 1")).rows[0];
  if(pending){if(pending.expired)await db.query('UPDATE sourcing_search_account SET halted=true WHERE id=true');return null;}
  const budget=(await db.query<{halted:boolean;daily_used:number;monthly_used:number}>('SELECT halted,daily_used,monthly_used FROM sourcing_search_account WHERE id=true')).rows[0]!;
  if(budget.halted)return null; // Keep the original provider failure visible until reconciliation.
  const remaining=discoveryQuotaRemaining(budget.daily_used,budget.monthly_used);
  if(remaining.daily===0||remaining.monthly===0){await db.query("UPDATE sourcing_discovery_settings SET last_result='quota_exhausted' WHERE workspace_id=$1",[ctx.scope.workspaceId]);return null;}
  const policy=await ensureTargetingPolicy(ctx);
  const query=policy.queries[settings.query_cursor%policy.queries.length]!;
  // Existing attempts retain slot zero. Never reuse an occupied slot, even after a failure.
  const slot=(await db.query<{slot:number}>(`SELECT slot FROM generate_series(0,$2::integer-1) AS slots(slot) WHERE NOT EXISTS (SELECT 1 FROM sourcing_discovery_attempts a WHERE a.workspace_id=$1 AND a.day=(now() AT TIME ZONE 'UTC')::date AND a.slot=slots.slot) ORDER BY slot LIMIT 1`,[ctx.scope.workspaceId,settings.searches_per_day])).rows[0]?.slot;
  if(slot===undefined)return null;
  const row=(await db.query<{id:string;day:Date}>(`INSERT INTO sourcing_discovery_attempts(workspace_id,query_id,query,policy_version,slot) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,day,slot) DO NOTHING RETURNING id,day`,[ctx.scope.workspaceId,query.id,query.query,policy.version,slot])).rows[0];
  if(!row)return null;
  await db.query('UPDATE sourcing_search_account SET daily_used=daily_used+1,monthly_used=monthly_used+1 WHERE id=true');
  await db.query("UPDATE sourcing_discovery_settings SET next_run_at=now()+interval '1 day'/$2::integer,query_cursor=query_cursor+1,last_result='dispatched' WHERE workspace_id=$1",[ctx.scope.workspaceId,settings.searches_per_day]);
  return {id:row.id,query};
 });
 if(!attempt)return;
 let result:DiscoverySearchResult;
 try{result=await provider.discover({query:attempt.query.query});}catch{result={ok:false,code:'unavailable'};}
 if(result.ok&&result.credits!==1)result={ok:false,code:'usage_unexpected'};
 const answer=result;
 // A hit is a pointer (ADR0034): noise is retained only, and a list page is read once,
 // free and unreserved, for links to other companies. A refused or failed read yields none.
 const {routed,lists}=routeDiscoveryHits(answer.ok?answer.hits.slice(0,DISCOVERY_RESULT_LIMIT).filter(hit=>sourcingUrlSchema.safeParse(hit.url).success):[]);
 const leads=new Map<string,readonly DiscoveryListLead[]>();
 if(lists.length){
  const settings=await readResearchSettings(ctx);
  for(const list of lists){
   let found:readonly DiscoveryListLead[]=[];
   try{
    const fetched=await pageFetch.fetchPages({urls:[list.url],firmWebsite:list.url,links:[list.url],maxPagesPerFirm:1,maxBytes:settings.maxPageBytes,shouldContinue:()=>allowed(ctx)});
    const page=fetched.ok?fetched.value.pages[0]:undefined;
    if(page)found=discoveryListLeads(list.url,page);
   }catch{found=[];}
   leads.set(list.url,found);
  }
 }
 await withTransaction(db,async()=>{
  if(!answer.ok){
   await db.query('UPDATE sourcing_search_account SET halted=true WHERE id=true');
   await recordCrmAuditEvent(ctx,{action:'sourcing.discovery_failed',subjectKind:'sourcing_discovery_attempt',subjectId:attempt.id,detail:{code:answer.code,provider:provider.providerKey}});
  }else{
   const observed=(await db.query<{day:string}>("SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day")).rows[0]!.day;
   // One company per host: no new candidate for a host already stored as a candidate website or
   // source (including discovery-v1 rows, observations and origins) or as a Firm website.
   // Stored references may be bare or schemed; the host is read the way companyHost does.
   const hosts=[...new Set([...routed.filter(r=>r.kind==='company').map(r=>companyHost(r.hit.url)),...[...leads.values()].flat().map(lead=>lead.host)])];
   const known=new Set((await db.query<{host:string}>(`WITH stored(url) AS (
     SELECT v.url FROM sourcing_candidates c CROSS JOIN LATERAL (SELECT c.payload->>'website' UNION ALL SELECT c.payload->>'sourceUrl' UNION ALL SELECT c.payload#>>'{row,website}'
      UNION ALL SELECT c.payload#>>'{row,source,sourceUrl}' UNION ALL SELECT jsonb_path_query(c.payload,'$.row.observations[*].sourceUrl')#>>'{}') AS v(url) WHERE c.workspace_id=$1
     UNION ALL SELECT o.source->>'sourceUrl' FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=$1
     UNION ALL SELECT f.website FROM firms f WHERE f.workspace_id=$1)
    SELECT DISTINCT hosts.host FROM stored JOIN unnest($2::text[]) AS hosts(host)
     ON regexp_replace(rtrim(lower(split_part(substring(regexp_replace(regexp_replace(stored.url,'^[a-zA-Z][a-zA-Z0-9+.-]*://',''),'^[^/?#@]*@','') FROM '^[^/?#]*'),':',1)),'.'),'^www\\.','')=hosts.host`,[ctx.scope.workspaceId,hosts])).rows.map(row=>row.host));
   const seen=new Set<string>();
   let created=0;
   // Discovery never changes review status. The qualification scheduler or an
   // explicit owner request may qualify this saved draft.
   const save=async(input:{firmName:string;website:string;evidence:string})=>{
    const saved=await saveCandidate(ctx,{...input,locality:attempt.query.locality,region:attempt.query.region,signal:'fit_only',sourceUrl:input.website,observedOn:observed,preparedBy:'Tavily Basic search · not verified',discoveryQuery:attempt.query.query});
    if(!saved.ok)throw new Error('discovery_candidate_invalid');
    created++;return saved.value.id;
   };
   for(const {hit,kind} of routed){
    const inserted=await db.query('INSERT INTO sourcing_discovery_hits(workspace_id,source_url,attempt_id,native_result) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING source_url',[ctx.scope.workspaceId,hit.url,attempt.id,JSON.stringify(hit)]);
    if(kind==='noise')continue;
    if(kind==='list'){
     // The list page itself is never a candidate nor a source of the listed companies' facts.
     const listed=leads.get(hit.url);if(!listed)continue;
     leads.delete(hit.url);
     let made=0;
     for(const lead of listed){
      if(seen.has(lead.host)||known.has(lead.host))continue;
      seen.add(lead.host);
      if(created>=DISCOVERY_NEW_CANDIDATE_LIMIT)break;
      await save({firmName:lead.label?discoveryFirmName(lead.label,lead.url):lead.host,website:lead.url,evidence:`Listed on ${hit.url}: ${lead.label||lead.host}`.slice(0,2000)});
      made++;
     }
     await recordCrmAuditEvent(ctx,{action:'sourcing.discovery_list_expanded',subjectKind:'sourcing_discovery_attempt',subjectId:attempt.id,detail:{listUrl:hit.url,leads:listed.length,created:made}});
     continue;
    }
    if(inserted.rows.length===0){
     const prior=(await db.query<{candidate_id:string|null}>('SELECT candidate_id FROM sourcing_discovery_hits WHERE workspace_id=$1 AND source_url=$2',[ctx.scope.workspaceId,hit.url])).rows[0];
     if(prior?.candidate_id)continue;
    }
    const host=companyHost(hit.url);
    const existing=(await db.query<{id:string}>("SELECT id FROM sourcing_candidates WHERE workspace_id=$1 AND (payload->>'sourceUrl'=$2 OR payload->>'website'=$2) LIMIT 1",[ctx.scope.workspaceId,hit.url])).rows[0];
    if(existing){seen.add(host);await db.query('UPDATE sourcing_discovery_hits SET candidate_id=$3 WHERE workspace_id=$1 AND source_url=$2',[ctx.scope.workspaceId,hit.url,existing.id]);continue;}
    if(seen.has(host)||known.has(host))continue;
    seen.add(host);
    // Retain excess raw hits; a later result can revisit one not yet made into a candidate.
    if(created>=DISCOVERY_NEW_CANDIDATE_LIMIT)continue;
    const id=await save({firmName:discoveryFirmName(hit.title,hit.url),website:hit.url,evidence:hit.snippet.trim().slice(0,2000)||'Search returned no excerpt; source verification required.'});
    await db.query('UPDATE sourcing_discovery_hits SET candidate_id=$3 WHERE workspace_id=$1 AND source_url=$2',[ctx.scope.workspaceId,hit.url,id]);
   }
  }
  await db.query('UPDATE sourcing_discovery_attempts SET state=$2,request_id=$4 WHERE id=$1 AND workspace_id=$3',[attempt.id,answer.ok?'complete':'failed',ctx.scope.workspaceId,answer.ok?answer.requestId:null]);
  await db.query('UPDATE sourcing_discovery_settings SET last_result=$2 WHERE workspace_id=$1',[ctx.scope.workspaceId,answer.ok?'complete':answer.code]);
 });
}
