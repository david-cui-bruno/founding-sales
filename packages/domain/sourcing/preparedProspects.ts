import {isDeepStrictEqual} from 'node:util';
import {preparedProspectListInputSchema,preparedProspectListSchema,preparedProspectReadInputSchema,preparedProspectBriefSchema,preparedProspectSummarySchema,type PreparedProspectCurrentBrief,type PreparedProspectTarget} from '@fss/contracts';
import type {z} from 'zod';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';
import {lockLivePreparationCleanup} from '../calling/preparationLifecycle.ts';
import {MANUAL_PROSPECT_ROWS_SQL,readManualProspectSubject} from './manualProspectRows.ts';
import type {ManualProspectRow} from './manualProspectProjection.ts';
import {manualPhoneSnapshots,recheckManualPhoneSnapshots,type ManualPhoneSnapshot} from './manualProspectPhone.ts';
import {preparedPriorityOrder} from './prospectPriorityStore.ts';
import {projectPreparedProspect,type PreparedRunIdentity} from './preparedProspectProjection.ts';
import {withPreparedCaptureSnapshots} from './preparedCaptureStore.ts';
import {lockPreparedCaptureDependencies} from './preparedCaptureDependencies.ts';
import {preparedCaptureAuthority} from './preparedCapture.ts';

type Result<T>={ok:true;value:T}|{ok:false;reason:string};
type Run=PreparedRunIdentity&Record<string,unknown>&{candidate_id:string};
type Expiry={url:string;expires_at:Date};
const refuse=(reason:string):{ok:false;reason:string}=>({ok:false,reason});
async function admin(ctx:RepositoryContext):Promise<boolean>{return ctx.scope.actor.kind==='user'&&ctx.scope.actor.role==='admin'&&await activeIdentityActor(ctx);}
async function latestRuns(ctx:RepositoryContext,rows:readonly ManualProspectRow[]):Promise<Run[]>{
 if(!rows.length)return [];
 return (await ctx.db.query<Run>(`SELECT q.id,q.candidate_id,q.candidate_revision FROM sourcing_candidates c
 JOIN LATERAL(SELECT id,candidate_id,candidate_revision FROM sourcing_qualification_runs r WHERE r.workspace_id=c.workspace_id AND r.candidate_id=c.id ORDER BY requested_at DESC,id DESC LIMIT 1) q ON q.candidate_revision=c.revision
 WHERE c.workspace_id=$1 AND c.id=ANY($2::uuid[]) ORDER BY c.id`,[ctx.scope.workspaceId,rows.map(r=>r.id)])).rows;
}
async function expirations(ctx:RepositoryContext,rows:readonly ManualProspectRow[],snapshots:readonly ManualPhoneSnapshot[]):Promise<Expiry[]>{
 const candidateUrls=rows.flatMap(r=>Array.isArray(r['source_urls'])?r['source_urls'].filter((url):url is string=>typeof url==='string'):[]);
 const urls=[...new Set([...candidateUrls,...snapshots.flatMap(s=>[...s.permitted_urls,...preparedCaptureAuthority(s).dependencyUrls])])].map(url=>url.replace(/\/+$/u,''));
 if(!urls.length)return [];
 return (await ctx.db.query<Expiry>(`SELECT rtrim(source_reference,'/') AS url,min(retention_expires_at) AS expires_at FROM evidence_items
 WHERE workspace_id=$1 AND rtrim(source_reference,'/')=ANY($2::text[]) AND retention_expires_at IS NOT NULL GROUP BY rtrim(source_reference,'/') ORDER BY 1`,[ctx.scope.workspaceId,urls])).rows;
}
/** Caller owns the transaction. Reuse the retained-original lifecycle and exact
 * evidence locks, then recheck current rights and wall time after principal waits. */
async function currentBriefs(ctx:RepositoryContext,readRows:()=>Promise<ManualProspectRow[]>,authority:()=>Promise<boolean>):Promise<Result<{briefs:PreparedProspectCurrentBrief[];now:number}>>{
 if(!await admin(ctx))return refuse('authority_changed');
 await lockLivePreparationCleanup(ctx);
 const rows=await readRows();
 if(rows.length>50)return refuse('candidate_unavailable');
 if(rows.length)await ctx.db.query('SELECT id FROM sourcing_candidates WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',[ctx.scope.workspaceId,rows.map(r=>r.id)]);
 await lockPreparedCaptureDependencies(ctx,rows);
 const runs=await latestRuns(ctx,rows),snapshots=await withPreparedCaptureSnapshots(ctx,await manualPhoneSnapshots(ctx,rows)),expiry=await expirations(ctx,rows,snapshots);
 const started=(await ctx.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.getTime();
 if(ctx.scope.actor.kind==='user')await ctx.db.query('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[ctx.scope.workspaceId,ctx.scope.actor.userId]);
 if(!await authority()||!await admin(ctx))return refuse('authority_changed');
 const checked=await withPreparedCaptureSnapshots(ctx,await recheckManualPhoneSnapshots(ctx,rows,snapshots));
 if(!await authority()||!await admin(ctx))return refuse('authority_changed');
 const currentRows=await readRows(),currentRuns=await latestRuns(ctx,rows),current=await withPreparedCaptureSnapshots(ctx,await recheckManualPhoneSnapshots(ctx,rows,snapshots)),currentExpiry=await expirations(ctx,rows,snapshots);
 const now=(await ctx.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.getTime();
 if(expiry.some(e=>e.expires_at.getTime()>started&&e.expires_at.getTime()<=now))return refuse('source_expired');
 if(!isDeepStrictEqual(rows,currentRows)||!isDeepStrictEqual(runs,currentRuns))return refuse('candidate_changed');
 if(!isDeepStrictEqual(expiry,currentExpiry)||!isDeepStrictEqual(checked,current)||!isDeepStrictEqual(snapshots,current))return refuse('source_changed');
 const deadlines=new Map(currentExpiry.map(e=>[e.url,e.expires_at.getTime()]));
 const byUrl=new Map(current.flatMap(s=>s.permitted_urls.flatMap(url=>{const at=deadlines.get(url.replace(/\/+$/u,''));return at===undefined?[]:[[url,at] as const];})));
 const briefs=rows.flatMap(row=>{
  const brief=projectPreparedProspect(row,current.find(s=>s.candidate_id===row.id),currentRuns.find(r=>r.candidate_id===row.id),now,byUrl);if(!brief)return [];
  const rowDeadlines=(Array.isArray(row['source_urls'])?row['source_urls']:[]).flatMap(url=>typeof url==='string'&&deadlines.has(url.replace(/\/+$/u,''))?[deadlines.get(url.replace(/\/+$/u,''))!]:[]);
  if(brief.validUntil!==null)rowDeadlines.push(Date.parse(brief.validUntil));
  const parsed=preparedProspectBriefSchema.parse({...brief,validUntil:rowDeadlines.length?new Date(Math.min(...rowDeadlines)).toISOString():null});
  return parsed.policyVersion==='prepared-prospect-v2'?[parsed]:[];
 });
 return {ok:true,value:{briefs,now}};
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
 const finalOrder=await preparedPriorityOrder(ctx,parsed.data.offset,parsed.data.order);if(finalOrder.viewRevision!==order.viewRevision)return refuse('view_changed');
 if(!await authority()||!await admin(ctx))return refuse('authority_changed');
 const wall=(await ctx.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.getTime();
 if(result.value.briefs.some(b=>b.validUntil!==null&&Date.parse(b.validUntil)<=wall))return refuse('source_expired');
 return {ok:true,value:preparedProspectListSchema.parse({prospects:result.value.briefs.map(brief=>preparedProspectSummarySchema.parse({target:brief.target,displayName:brief.displayName,discoveryLabel:brief.discoveryLabel,website:brief.website,targetingLocality:brief.targetingLocality,targetingRegion:brief.targetingRegion,sourceNotices:brief.sourceNotices,state:brief.state,summary:brief.summary,unknowns:brief.unknowns,validUntil:brief.validUntil,callable:brief.callable,companyHost:brief.companyHost})),hasMore:order.rows.length>50,viewRevision:order.viewRevision,checkedAt:new Date(wall).toISOString()})};
}

export async function readPreparedProspect(ctx:RepositoryContext,target:PreparedProspectTarget,authority:()=>Promise<boolean>=async()=>true):Promise<Result<PreparedProspectCurrentBrief>>{
 const parsed=preparedProspectReadInputSchema.safeParse(target);if(!parsed.success)return refuse('candidate_unavailable');
 const readRows=async()=>{const row=await readManualProspectSubject(ctx,{candidateId:target.candidateId,expectedRevision:target.candidateRevision});return row?[{...row,duplicate_count:0}]:[];};
 const result=await currentBriefs(ctx,readRows,authority);if(!result.ok)return result;
 const brief=result.value.briefs[0];if(!brief)return refuse('candidate_unavailable');
 if(brief.target.runId!==target.runId)return refuse('candidate_changed');
 return {ok:true,value:brief};
}
