import { withTransaction } from '../db/queryable.ts';
import { repositoryContext } from '../db/workspaceScope.ts';
import { captureRecoveryJobPayload, lockCaptureReadJob, recoveryCurrent, type CaptureReadProbeDeps } from './crmCaptureReadProbe.ts';
import type { RecoveryRow } from './crmCaptureReadRecovery.ts';
import type { JobHandlerInput } from '../jobs/handlerRegistry.ts';
import type { BusinessMailMetadataObserver } from './pipeline.ts';
import type { GmailAccessGrant } from './gmailClient.ts';
import { readRefreshToken } from './tokens.ts';
import { METADATA_HEADERS } from './types.ts';

type Progress = {recovery_id:string;mailbox_id:string;generation:number;revision:number;state:string;forward_cutoff_at:Date;window_from_at:Date;window_to_at:Date|null;next_page_token:string|null};
export interface CaptureReadForwardDeps extends CaptureReadProbeDeps {observer:BusinessMailMetadataObserver}
/** Frozen interval, strict original INTERNAL date, at most one page and 50 metadata
 * reads per turn. A partial page never advances the lower bound. No history cursor,
 * pipeline effects, historical admission, coverage or operational heartbeat. */
export async function runCaptureReadForward(input:JobHandlerInput,deps:CaptureReadForwardDeps|undefined):Promise<void>{
 const {recoveryId}=captureRecoveryJobPayload.parse(input.job.payload);
 const ctx=repositoryContext(input.scope,input.session),w=input.scope.workspaceId;
 const start=await withTransaction(input.session,async()=>{
  if(!await lockCaptureReadJob(input))return null;
  const row=(await ctx.db.query<RecoveryRow>("SELECT * FROM crm_capture_read_recoveries WHERE workspace_id=$1 AND id=$2 AND state='verified' FOR SHARE",[w,recoveryId])).rows[0];
  if(!row)return null;
  const p=(await ctx.db.query<Progress>('SELECT * FROM crm_capture_read_progress WHERE workspace_id=$1 AND recovery_id=$2 FOR UPDATE',[w,recoveryId])).rows[0];
  if(!p||['blocked','uncertain'].includes(p.state))return null;
  if(p.state==='scanning') {await ctx.db.query("UPDATE crm_capture_read_progress SET state='uncertain',coded_reason='provider_uncertain',revision=revision+1 WHERE workspace_id=$1 AND recovery_id=$2",[w,recoveryId]);return null;}
  const a=deps?await recoveryCurrent(ctx,row,deps.runtime):null;
  if(!a||new Date(a.cutoff).getTime()!==p.forward_cutoff_at.getTime()) {await ctx.db.query("UPDATE crm_capture_read_progress SET state='blocked',coded_reason='authority_changed',revision=revision+1 WHERE workspace_id=$1 AND recovery_id=$2",[w,recoveryId]);return null;}
  const frozen=(await ctx.db.query<{at:Date}>('SELECT least(clock_timestamp(),$1::timestamptz+interval \'1 day\') AS at',[p.window_from_at])).rows[0]!.at;
  if(frozen.getTime()<p.window_from_at.getTime())return null;
  const upper=p.window_to_at??frozen;
  await ctx.db.query("UPDATE crm_capture_read_progress SET state='scanning',window_to_at=$3,last_scan_at=clock_timestamp(),revision=revision+1 WHERE workspace_id=$1 AND recovery_id=$2",[w,recoveryId,upper]);
  return {row,p:{...p,window_to_at:upper,revision:p.revision+1},authority:a};
 });
 if(!start||!deps)return;
 async function fenced<T>(work:()=>Promise<T>):Promise<T|null>{return withTransaction(input.session,async()=>{
  if(!await lockCaptureReadJob(input))return null;
  const p=(await ctx.db.query<Progress>("SELECT * FROM crm_capture_read_progress WHERE workspace_id=$1 AND recovery_id=$2 AND state='scanning' AND revision=$3 FOR UPDATE",[w,recoveryId,start!.p.revision])).rows[0];
  if(!p)return null;
  if(!await recoveryCurrent(ctx,start!.row,deps!.runtime)) {await ctx.db.query("UPDATE crm_capture_read_progress SET state='blocked',coded_reason='authority_changed',revision=revision+1 WHERE workspace_id=$1 AND recovery_id=$2",[w,recoveryId]);return null;}
  return work();
 });}
 async function block(reason:'provider_refused'|'provider_uncertain'|'invalid_metadata'|'consumer_unavailable'){
  await fenced(async()=>{await ctx.db.query("UPDATE crm_capture_read_progress SET state=$3,coded_reason=$4,revision=revision+1 WHERE workspace_id=$1 AND recovery_id=$2",[w,recoveryId,reason==='provider_uncertain'?'uncertain':'blocked',reason]);return true;});
 }
 try {
  const token=await readRefreshToken(ctx,{mailboxId:start.row.mailbox_id,cipher:deps.cipher});
  if(!await fenced(async()=>true))return;
  if(token===null){await block('provider_refused');return;}
  const refreshed=await deps.gmail.refreshAccessToken(deps.oauth,token);
  if(!await fenced(async()=>true))return;
  if(!refreshed.ok||!Number.isFinite(refreshed.grant.expiresAtEpochSeconds)||refreshed.grant.expiresAtEpochSeconds<=Date.now()/1000||refreshed.grant.grantedScopes&&!refreshed.grant.grantedScopes.includes('https://www.googleapis.com/auth/gmail.readonly')){await block('provider_refused');return;}
  const access:GmailAccessGrant=refreshed.grant,p=start.p;
  const page=await deps.gmail.listMessageIds(access,{afterEpochSeconds:Math.floor(p.window_from_at.getTime()/1000)-1,beforeEpochSeconds:Math.ceil(p.window_to_at.getTime()/1000)+1,maxResults:50,excludeDrafts:true,...p.next_page_token?{pageToken:p.next_page_token}:{}});
  if(!await fenced(async()=>true))return;
  if(!page.ok){await block('provider_refused');return;}
  if(page.messageIds.length>50||new Set(page.messageIds).size!==page.messageIds.length||page.messageIds.some(id=>! /^[A-Za-z0-9_-]{1,128}$/u.test(id))||page.nextPageToken!==null&&(page.nextPageToken.length<1||page.nextPageToken.length>4096||page.nextPageToken===p.next_page_token)){await block('invalid_metadata');return;}
  let observed=0;
  for(const id of page.messageIds){
   if(!await fenced(async()=>true))return;
   const metadata=await deps.gmail.getMetadata(access,id,METADATA_HEADERS);
   if(!await fenced(async()=>true))return;
   if(metadata===null)continue; // Verified gone, not a captured original or coverage claim.
   if(metadata.id!==id||! /^[A-Za-z0-9_-]{1,128}$/u.test(metadata.threadId)||!Number.isSafeInteger(metadata.internalDateEpochMilliseconds)){await block('invalid_metadata');return;}
   const at=metadata.internalDateEpochMilliseconds;
   if(at<Math.max(p.forward_cutoff_at.getTime(),p.window_from_at.getTime())||at>=p.window_to_at.getTime()||metadata.labelIds.includes('DRAFT'))continue;
   const receipt=await fenced(()=>deps.observer.observe(ctx,{mailboxId:start.authority.mailboxId,ownerUserId:start.authority.ownerUserId,providerAccountId:start.authority.providerAccountId,generation:start.authority.generation,metadata}));
   if(receipt===null)return;
   if(!receipt||!receipt.ok&&receipt.reason==='metadata_observation_unavailable'){await block('consumer_unavailable');return;}
   // Deleted/outside-review originals remain unobserved and are never resurrected.
   if(receipt.ok)observed++;
  }
  await fenced(async()=>{await ctx.db.query(`UPDATE crm_capture_read_progress SET state=$3,window_from_at=CASE WHEN $4::text IS NULL THEN window_to_at ELSE window_from_at END,window_to_at=CASE WHEN $4::text IS NULL THEN NULL ELSE window_to_at END,next_page_token=$4,visited_messages=visited_messages+$5,observed_metadata=observed_metadata+$6,last_scan_at=clock_timestamp(),coded_reason=NULL,revision=revision+1 WHERE workspace_id=$1 AND recovery_id=$2`,[w,recoveryId,page.nextPageToken===null?'current':'pending',page.nextPageToken,page.messageIds.length,observed]);return true;});
 }catch {await block('provider_uncertain');}
}
