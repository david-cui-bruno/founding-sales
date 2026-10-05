import {randomUUID} from 'node:crypto';
import {candidateDeleteInputSchema,candidateSourceCheckSchema,type CandidateInput,type CandidateSourceCheck} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {decideAdminOnly} from '../crm/authorization.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {databaseNow} from '../policy/clock.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {enqueueJob} from '../jobs/jobStore.ts';
import {jobIdempotencyKey} from '../jobs/jobKinds.ts';
import {incrementDailyCounter} from '../jobs/counters.ts';
import {readResearchSettings} from '../research/settings.ts';
import {RESEARCH_FIRM_RUN_COUNTER} from '../research/ceilings.ts';
import {workspaceBusinessZone} from '../research/ledger.ts';
import {isPublicResearchUrl,withoutFragment} from '../research/sourcePolicy.ts';
import {parsePageText} from '../research/pageText.ts';
import type {PageFetchProvider} from '../research/providers.ts';

interface Row {id:string;revision:number;status:string;payload:CandidateInput;source_check:unknown;check_job_state:string|null;[key:string]:unknown}
const select=`SELECT id,revision,status,payload,source_check,(SELECT state FROM jobs j WHERE j.workspace_id=sourcing_candidates.workspace_id AND j.id::text=source_check->>'jobId') AS check_job_state FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2`;
export function visibleSourceCheck(value:unknown,jobState:string|null):CandidateSourceCheck|null {
  if(value===null)return null;
  const parsed=candidateSourceCheckSchema.safeParse(value);if(!parsed.success)return null;
  const check=parsed.data;
  if(check.state==='pending' && (jobState===null || jobState==='dead' || jobState==='done'))return {...check,state:'unavailable',reason:'job_failed'};
  return check;
}
async function blocked(context:RepositoryContext):Promise<'research_disabled'|'research_held'|null>{
  if(!(await readResearchSettings(context)).enabled)return 'research_disabled';
  if((await listApplicableHolds(context,{actionKind:'research'})).length>0)return 'research_held';
  return null;
}
export async function requestSourceCheck(context:RepositoryContext,input:{id:string;expectedRevision:number}):Promise<{ok:true;value:{id:string}}|{ok:false;reason:string}> {
  if(!decideAdminOnly(context).permitted)return {ok:false,reason:'admin_only'};
  if(!candidateDeleteInputSchema.safeParse(input).success)return {ok:false,reason:'invalid_input'};
  const row=(await context.db.query<Row>(`${select} FOR UPDATE`,[context.scope.workspaceId,input.id])).rows[0];
  if(!row)return {ok:false,reason:'not_found'};
  if(row.revision!==input.expectedRevision)return {ok:false,reason:'candidate_changed'};
  if(row.status==='dismissed')return {ok:false,reason:'candidate_dismissed'};
  const now=await databaseNow(context),previous=visibleSourceCheck(row.source_check,row.check_job_state);
  if(previous?.state==='pending' && Date.parse(now)-Date.parse(previous.requestedAt)<30*60_000)return {ok:false,reason:'check_in_progress'};
  const refusal=await blocked(context);if(refusal)return {ok:false,reason:refusal};
  if(!isPublicResearchUrl(withoutFragment(row.payload.sourceUrl)))return {ok:false,reason:'source_not_permitted'};
  const settings=await readResearchSettings(context);
  const count=await incrementDailyCounter(context,{subjectKind:'workspace',subjectKey:context.scope.workspaceId,counterKind:RESEARCH_FIRM_RUN_COUNTER,businessTimeZone:await workspaceBusinessZone(context),at:now},settings.dailyFirmCeiling);
  if(!count.allowed)return {ok:false,reason:'daily_firm_ceiling'};
  const checkId=randomUUID();
  const job=await enqueueJob(context.db,{workspaceId:context.scope.workspaceId,kind:'sourcing.check',idempotencyKey:jobIdempotencyKey.sourcingCheck(input.id,checkId),payload:{candidateId:input.id,checkId},maxAttempts:1});
  const check:CandidateSourceCheck={checkId,jobId:job.jobId,requestedAt:now,state:'pending',reason:null,checkedAt:null,lastSuccess:previous?.lastSuccess??null};
  await context.db.query('UPDATE sourcing_candidates SET source_check=$3::jsonb,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,input.id,JSON.stringify(check)]);
  await recordCrmAuditEvent(context,{action:'sourcing.source_check_requested',subjectKind:'sourcing_candidate',subjectId:input.id});
  return {ok:true,value:{id:input.id}};
}
export async function runSourceCheck(context:RepositoryContext,input:{candidateId:string;checkId:string},fetcher:PageFetchProvider):Promise<void>{
  const row=(await context.db.query<Row>(select,[context.scope.workspaceId,input.candidateId])).rows[0];if(!row)return;
  const parsed=candidateSourceCheckSchema.safeParse(row.source_check);
  if(!parsed.success || parsed.data.checkId!==input.checkId || parsed.data.state!=='pending')return;
  const prior=parsed.data;let reason:CandidateSourceCheck['reason']=row.status==='dismissed'?'candidate_dismissed':await blocked(context);
  let lastSuccess=prior.lastSuccess;
  const source=withoutFragment(row.payload.sourceUrl);
  if(!reason && !isPublicResearchUrl(source))reason='source_not_permitted';
  if(!reason && Date.parse(await databaseNow(context))-Date.parse(prior.requestedAt)>30*60_000)reason='check_expired';
  if(!reason){
    const settings=await readResearchSettings(context);
    try {
      const result=await fetcher.fetchPages({urls:[source],firmWebsite:row.payload.website,links:[source],maxPagesPerFirm:1,maxBytes:settings.maxPageBytes,shouldContinue:async()=>{
        if(await blocked(context))return false;
        const current=(await context.db.query<Row>(select,[context.scope.workspaceId,input.candidateId])).rows[0];
        return current!==undefined && current.status!=='dismissed' && candidateSourceCheckSchema.safeParse(current.source_check).success && (current.source_check as CandidateSourceCheck).checkId===input.checkId;
      }});
      const page=result.ok?result.value.pages[0]:undefined;
      reason=await blocked(context);
      if(!reason && !page)reason='source_unavailable';
      if(!reason && page){
        const text=parsePageText(page.body,page.contentType);
        if(text.text.length===0)reason='no_readable_text';
        else {
          const fold=(value:string)=>value.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();
          const quote=fold(row.payload.evidence);
          const matching=text.blocks.find(block=>fold(block.text).includes(quote));
          const excerpt=(matching?.text??text.text).slice(0,4000);
          const snapshot=candidateSourceCheckSchema.shape.lastSuccess.unwrap().safeParse({url:page.url,contentHash:page.contentHash,retrievedAt:page.retrievedAt,firstParty:page.firstParty,excerpt,quoteMatched:matching!==undefined,truncated:text.truncated||(matching?.text??text.text).length>4000});
          if(snapshot.success && Buffer.byteLength(JSON.stringify(snapshot.data),'utf8')<=12000)lastSuccess=snapshot.data;else reason='source_unavailable';
        }
      }
    }catch{reason='source_unavailable';}
  }
  let check=candidateSourceCheckSchema.parse({...prior,state:reason?'unavailable':'checked',reason,checkedAt:await databaseNow(context),lastSuccess});
  if(Buffer.byteLength(JSON.stringify(check),'utf8')>16000)check={...check,state:'unavailable',reason:'source_unavailable',lastSuccess:prior.lastSuccess};
  // Review edits do not invalidate a snapshot. A newer check or deletion does.
  const changed=await context.db.query(`UPDATE sourcing_candidates SET source_check=$4::jsonb,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND source_check->>'checkId'=$3 AND source_check->>'state'='pending' RETURNING id`,[context.scope.workspaceId,input.candidateId,input.checkId,JSON.stringify(check)]);
  if(changed.rows.length)await recordCrmAuditEvent(context,{action:'sourcing.source_checked',subjectKind:'sourcing_candidate',subjectId:input.candidateId,detail:{state:check.state,reason:check.reason}});
}
