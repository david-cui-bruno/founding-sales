import {isDeepStrictEqual} from 'node:util';
import {preparedProspectListInputSchema,preparedProspectListSchema,preparedProspectReadInputSchema,preparedProspectBriefSchema,preparedProspectSummarySchema,type PreparedProspectCurrentBrief,type PreparedProspectTarget} from '@fss/contracts';
import type {z} from 'zod';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';
import {lockLivePreparationCleanup} from '../calling/preparationLifecycle.ts';
import {MANUAL_PROSPECT_ROWS_SQL,readManualProspectSubject} from './manualProspectRows.ts';
import type {ManualProspectRow} from './manualProspectProjection.ts';
import {manualPhoneSnapshots,recheckManualPhoneSnapshots} from './manualProspectPhone.ts';
import {preparedPriorityOrder} from './prospectPriorityStore.ts';
import {projectPreparedProspect,type PreparedRunIdentity} from './preparedProspectProjection.ts';
import {withPreparedCaptureSnapshots} from './preparedCaptureStore.ts';
import type {PreparedCaptureCustody} from './preparedCaptureBatch.ts';
import {lockPreparedCaptureDependencies} from './preparedCaptureDependencies.ts';
import {preparedSourceExpirations,permittedPageDeadlines} from './preparedSourceDeadlines.ts';

type Result<T>={ok:true;value:T}|{ok:false;reason:string};
type Run=PreparedRunIdentity&Record<string,unknown>&{candidate_id:string};
const refuse=(reason:string):{ok:false;reason:string}=>({ok:false,reason});
async function admin(ctx:RepositoryContext):Promise<boolean>{return ctx.scope.actor.kind==='user'&&ctx.scope.actor.role==='admin'&&await activeIdentityActor(ctx);}
async function latestRuns(ctx:RepositoryContext,rows:readonly ManualProspectRow[]):Promise<Run[]>{
 if(!rows.length)return [];
 return (await ctx.db.query<Run>(`SELECT q.id,q.candidate_id,q.candidate_revision FROM sourcing_candidates c
 JOIN LATERAL(SELECT id,candidate_id,candidate_revision FROM sourcing_qualification_runs r WHERE r.workspace_id=c.workspace_id AND r.candidate_id=c.id ORDER BY requested_at DESC,id DESC LIMIT 1) q ON q.candidate_revision=c.revision
 WHERE c.workspace_id=$1 AND c.id=ANY($2::uuid[]) ORDER BY c.id`,[ctx.scope.workspaceId,rows.map(r=>r.id)])).rows;
}
/** Caller owns the transaction. Reuse the retained-original lifecycle and exact
 * evidence locks, then recheck current rights and wall time after principal waits. */
/** Who may read briefs and whose authority their captured dependencies need. The default is the admin principal; the callable-rank
 * worker reads under its own system actor (`custody.principal`), with the lifecycle lock and every source limit still required. */
export interface BriefReader {access:(ctx:RepositoryContext)=>Promise<boolean>;custody?:PreparedCaptureCustody}
const adminReader:BriefReader={access:admin};
export async function currentBriefs(ctx:RepositoryContext,readRows:()=>Promise<ManualProspectRow[]>,authority:()=>Promise<boolean>,{access,custody}:BriefReader=adminReader):Promise<Result<{briefs:PreparedProspectCurrentBrief[];now:number}>>{
 if(!await access(ctx))return refuse('authority_changed');
 await lockLivePreparationCleanup(ctx);
 const rows=await readRows();
 if(rows.length>50)return refuse('candidate_unavailable');
 if(rows.length)await ctx.db.query('SELECT id FROM sourcing_candidates WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',[ctx.scope.workspaceId,rows.map(r=>r.id)]);
 await lockPreparedCaptureDependencies(ctx,rows);
 const runs=await latestRuns(ctx,rows),snapshots=await withPreparedCaptureSnapshots(ctx,await manualPhoneSnapshots(ctx,rows),custody),expiry=await preparedSourceExpirations(ctx,rows,snapshots);
 const started=(await ctx.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.getTime();
 if(ctx.scope.actor.kind==='user')await ctx.db.query('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[ctx.scope.workspaceId,ctx.scope.actor.userId]);
 if(!await authority()||!await access(ctx))return refuse('authority_changed');
 const checked=await withPreparedCaptureSnapshots(ctx,await recheckManualPhoneSnapshots(ctx,rows,snapshots),custody);
 if(!await authority()||!await access(ctx))return refuse('authority_changed');
 const currentRows=await readRows(),currentRuns=await latestRuns(ctx,rows),current=await withPreparedCaptureSnapshots(ctx,await recheckManualPhoneSnapshots(ctx,rows,snapshots),custody),currentExpiry=await preparedSourceExpirations(ctx,rows,snapshots);
 const now=(await ctx.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.getTime();
 if(expiry.some(e=>e.expires_at.getTime()>started&&e.expires_at.getTime()<=now))return refuse('source_expired');
 if(!isDeepStrictEqual(rows,currentRows)||!isDeepStrictEqual(runs,currentRuns))return refuse('candidate_changed');
 if(!isDeepStrictEqual(expiry,currentExpiry)||!isDeepStrictEqual(checked,current)||!isDeepStrictEqual(snapshots,current))return refuse('source_changed');
 const deadlines=new Map(currentExpiry.map(e=>[e.url,e.expires_at.getTime()]));
 const byUrl=permittedPageDeadlines(currentExpiry,current);
 const briefs=rows.flatMap(row=>{
  const brief=projectPreparedProspect(row,current.find(s=>s.candidate_id===row.id),currentRuns.find(r=>r.candidate_id===row.id),now,byUrl);if(!brief)return [];
  const rowDeadlines=(Array.isArray(row['source_urls'])?row['source_urls']:[]).flatMap(url=>typeof url==='string'&&deadlines.has(url.replace(/\/+$/u,''))?[deadlines.get(url.replace(/\/+$/u,''))!]:[]);
  if(brief.validUntil!==null)rowDeadlines.push(Date.parse(brief.validUntil));
  const parsed=preparedProspectBriefSchema.parse({...brief,validUntil:rowDeadlines.length?new Date(Math.min(...rowDeadlines)).toISOString():null});
  return parsed.policyVersion==='prepared-prospect-v2'?[parsed]:[];
 });
 return {ok:true,value:{briefs,now}};
}

const CALLABLE_FALLBACK_ROUNDS=3;
/** The rank row only orders (ADR0034): a company's winner is its strongest rank row, but if projecting it now says it is no longer
 * callable (an authority or source change the row has not caught up with), the host falls back to its next-ranked records. Round k
 * re-projects the k-th next record of every host still unresolved (at most one per host, so at most the page's 50 rows, never
 * starving a later host), and the first callable one stands in. A host with none keeps the winner, which the list marks not callable.
 * Each round costs one more projection and runs only while a winner failed. */
async function withCallableFallback(ctx:RepositoryContext,briefs:PreparedProspectCurrentBrief[],authority:()=>Promise<boolean>):Promise<Result<PreparedProspectCurrentBrief[]>>{
 const stood=new Map<string,PreparedProspectCurrentBrief>();
 const hosts=briefs.filter(b=>b.callable.state!=='callable'&&b.companyHost!==null).map(b=>b.companyHost!);
 const tried=briefs.map(b=>b.target.candidateId);
 for(let round=1;round<=CALLABLE_FALLBACK_ROUNDS;round++){
  const open=[...new Set(hosts)].filter(host=>!stood.has(host));
  if(!open.length)break;
  const next=(await ctx.db.query<{id:string;revision:number}>(`SELECT s.id,s.revision FROM (
   SELECT h.candidate_id AS id,h.candidate_revision AS revision,h.company_host AS host,row_number() OVER(PARTITION BY h.company_host ORDER BY h.rank DESC,c.created_at DESC,h.candidate_id) AS n
   FROM sourcing_callable_ranks h JOIN sourcing_candidates c ON c.workspace_id=h.workspace_id AND c.id=h.candidate_id AND c.revision=h.candidate_revision
   WHERE h.workspace_id=$1 AND h.company_host=ANY($2::text[]) AND h.rank IS NOT NULL AND h.expires_at>clock_timestamp() AND h.candidate_id<>ALL($3::uuid[])) s
   WHERE s.n=1 LIMIT 50`,[ctx.scope.workspaceId,open,tried])).rows;
  if(!next.length)break;
  tried.push(...next.map(n=>n.id));
  const readRows=async()=>{
   const rows=(await ctx.db.query<ManualProspectRow>(`SELECT * FROM (${MANUAL_PROSPECT_ROWS_SQL}) visible WHERE id=ANY($3::uuid[])`,[ctx.scope.workspaceId,'all',next.map(n=>n.id)])).rows;
   return next.flatMap(n=>{const row=rows.find(r=>r.id===n.id&&r.revision===n.revision);return row?[row]:[];});
  };
  const projected=await currentBriefs(ctx,readRows,authority);if(!projected.ok)return projected;
  for(const brief of projected.value.briefs)if(brief.callable.state==='callable'&&brief.companyHost!==null&&!stood.has(brief.companyHost))stood.set(brief.companyHost,brief);
 }
 return {ok:true,value:briefs.map(b=>b.callable.state==='callable'||b.companyHost===null?b:stood.get(b.companyHost)??b)};
}

export async function listPreparedProspects(ctx:RepositoryContext,input:z.input<typeof preparedProspectListInputSchema>,authority:()=>Promise<boolean>=async()=>true):Promise<Result<z.infer<typeof preparedProspectListSchema>>>{
 const parsed=preparedProspectListInputSchema.safeParse(input);if(!parsed.success)return refuse('candidate_unavailable');
 if(!await admin(ctx))return refuse('authority_changed');
 await lockLivePreparationCleanup(ctx);
 const order=await preparedPriorityOrder(ctx,parsed.data.offset,parsed.data.order);
 if(parsed.data.viewRevision&&parsed.data.viewRevision!==order.viewRevision)return refuse('view_changed');
 const selected=order.rows.slice(0,50);
 const readRows=async()=>{
  if(!selected.length)return [];
  const rows=(await ctx.db.query<ManualProspectRow>(`SELECT * FROM (${MANUAL_PROSPECT_ROWS_SQL}) visible WHERE id=ANY($3::uuid[])`,[ctx.scope.workspaceId,'all',selected.map(r=>r.id)])).rows;
  return selected.flatMap(s=>{const row=rows.find(r=>r.id===s.id&&r.revision===s.revision);return row?[row]:[];});
 };
 const result=await currentBriefs(ctx,readRows,authority);if(!result.ok)return result;
 const briefs=parsed.data.order==='callable'?await withCallableFallback(ctx,result.value.briefs,authority):{ok:true as const,value:result.value.briefs};if(!briefs.ok)return briefs;
 const finalOrder=await preparedPriorityOrder(ctx,parsed.data.offset,parsed.data.order);if(finalOrder.viewRevision!==order.viewRevision)return refuse('view_changed');
 if(!await authority()||!await admin(ctx))return refuse('authority_changed');
 const wall=(await ctx.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.getTime();
 if(briefs.value.some(b=>b.validUntil!==null&&Date.parse(b.validUntil)<=wall))return refuse('source_expired');
 return {ok:true,value:preparedProspectListSchema.parse({prospects:briefs.value.map(brief=>preparedProspectSummarySchema.parse({target:brief.target,displayName:brief.displayName,discoveryLabel:brief.discoveryLabel,website:brief.website,targetingLocality:brief.targetingLocality,targetingRegion:brief.targetingRegion,sourceNotices:brief.sourceNotices,state:brief.state,summary:brief.summary,unknowns:brief.unknowns,validUntil:brief.validUntil,callable:brief.callable,companyHost:brief.companyHost})),hasMore:order.rows.length>50,viewRevision:order.viewRevision,checkedAt:new Date(wall).toISOString()})};
}

export async function readPreparedProspect(ctx:RepositoryContext,target:PreparedProspectTarget,authority:()=>Promise<boolean>=async()=>true):Promise<Result<PreparedProspectCurrentBrief>>{
 const parsed=preparedProspectReadInputSchema.safeParse(target);if(!parsed.success)return refuse('candidate_unavailable');
 const readRows=async()=>{const row=await readManualProspectSubject(ctx,{candidateId:target.candidateId,expectedRevision:target.candidateRevision});return row?[{...row,duplicate_count:0}]:[];};
 const result=await currentBriefs(ctx,readRows,authority);if(!result.ok)return result;
 const brief=result.value.briefs[0];if(!brief)return refuse('candidate_unavailable');
 if(brief.target.runId!==target.runId)return refuse('candidate_changed');
 return {ok:true,value:brief};
}
