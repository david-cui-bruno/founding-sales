import {z} from 'zod';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {readBackfillAuthority,type BackfillAuthority} from '@fss/domain/mail/crmBackfillAuthority.ts';
import {readBackfillAllocation,reserveBackfillRead,observeBackfillRead,type BackfillAllocationVerifier,type BackfillReadMethod} from '@fss/domain/mail/crmBackfillBudget.ts';
import {repositoryContext} from '@fss/domain/db/workspaceScope.ts';
import type {GmailClient,GmailAccessGrant} from '@fss/domain/mail/gmailClient.ts';
import type {MailCaptureProofVerifier} from '@fss/domain/mail/crmSources.ts';
import {recordBackfillMetadata} from '@fss/domain/mail/crmBackfillMetadata.ts';
import {METADATA_HEADERS} from '@fss/domain/mail/types.ts';
import type {BusinessMailMetadataObserver} from '@fss/domain/mail/pipeline.ts';
import type {JobHandler,JobHandlerInput} from '@fss/domain/jobs/handlerRegistry.ts';
class BackfillFailure extends Error{}
const importPayload=z.strictObject({importId:z.string().uuid(),accountBinding:z.string().regex(/^[a-f0-9]{64}$/u),generation:z.number().int().positive(),controlsRevision:z.number().int().positive(),policyRevision:z.number().int().positive(),attemptConfigurationHash:z.string().regex(/^[a-f0-9]{64}$/u).optional(),attemptProgressHash:z.string().regex(/^[a-f0-9]{64}$/u).optional()});
export interface CrmMailBackfillDeps {
 gmail:GmailClient;
 /** Already-proven token resolver; no Gmail data reads may be hidden here. */
 resolveAccess(input:{mailboxId:string;providerAccountId:string;generation:number}):Promise<{mailboxId:string;providerAccountId:string;generation:number;access:GmailAccessGrant}|null>;
 proofVerifier:MailCaptureProofVerifier;allocationVerifier:BackfillAllocationVerifier;observer:BusinessMailMetadataObserver;
}
async function fenced(input:JobHandlerInput){return (await input.session.query("SELECT id FROM jobs WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>clock_timestamp() FOR UPDATE",[input.scope.workspaceId,input.job.id,input.job.leaseOwner,input.job.fencingToken])).rows.length===1;}
/** Provider waits and receipt verification are outside every short fenced transaction. */
export function crmMailBackfillJobHandler(deps?:CrmMailBackfillDeps):JobHandler{return {
 kind:'crm.mail_backfill',protection:'outbound_fence',maxAttempts:4,leaseSeconds:120,
 async handle(input){
  const parsed=importPayload.safeParse(input.job.payload);
  if(!parsed.success||input.scope.actor.kind!=='system'||input.scope.actor.component!=='worker'||input.scope.workspaceId!==input.job.workspaceId)return;
  const importId=parsed.data.importId,context=repositoryContext(input.scope,input.session);
  async function block(reason:string){await withTransaction(input.session,async()=>{if(!await fenced(input))return;await input.session.query("UPDATE crm_mail_imports SET state='blocked',reason=$3 WHERE workspace_id=$1 AND id=$2 AND state<>'complete'",[input.scope.workspaceId,importId,reason]);});}
  if(deps===undefined){await block('backfill_configuration_required');return;}
  const adapters=deps;
  let authority=await readBackfillAuthority(context,importId);
  if(authority===null||authority.proof.accountBinding!==parsed.data.accountBinding||authority.proof.generation!==parsed.data.generation||authority.proof.controlsRevision!==parsed.data.controlsRevision||authority.proof.policyRevision!==parsed.data.policyRevision){await block('acquisition_binding_changed');return;}
  if(await readBackfillAllocation(context,authority.proof.mailboxId)===null){await block('quota_configuration_required');return;}
  async function providerRead<T>(method:BackfillReadMethod,bound:BackfillAuthority,read:(access:GmailAccessGrant)=>Promise<T>):Promise<T>{
   if(!await adapters.proofVerifier.verify(bound.proof))throw new BackfillFailure('acquisition_verification_required');
   const proofInput={mailboxId:bound.proof.mailboxId,providerAccountId:bound.proof.providerAccountId,generation:bound.proof.generation};
   const access=await adapters.resolveAccess(proofInput);
   if(access===null||access.mailboxId!==proofInput.mailboxId||access.providerAccountId!==proofInput.providerAccountId||access.generation!==proofInput.generation)throw new BackfillFailure('acquisition_binding_changed');
   const reservation=await reserveBackfillRead(context,{importId,mailboxId:bound.proof.mailboxId,ownerUserId:bound.proof.ownerUserId,accountBinding:bound.proof.accountBinding,generation:bound.proof.generation,method,expectedProof:bound.proof,jobId:input.job.id,leaseOwner:input.job.leaseOwner,fencingToken:input.job.fencingToken},adapters.allocationVerifier);
   if(reservation===null)throw new BackfillFailure('quota_or_authority_unavailable');
   let result:T;
   try{result=await read(access.access);}catch{throw new BackfillFailure('provider_read_unavailable');}
   await observeBackfillRead(context,reservation.reservationId);
   const latest=await adapters.resolveAccess(proofInput),current=await readBackfillAuthority(context,importId);
   if(latest===null||latest.mailboxId!==proofInput.mailboxId||latest.providerAccountId!==proofInput.providerAccountId||latest.generation!==proofInput.generation||current===null||JSON.stringify(current.proof)!==JSON.stringify(bound.proof))throw new BackfillFailure('acquisition_binding_changed');
   return result;
  }
  try{
   if(authority.historyAnchor===null){
    const profile=await providerRead('profile',authority,access=>adapters.gmail.getProfile(access));
    if(!/^[0-9]{1,20}$/u.test(profile.historyId))throw new BackfillFailure('provider_evidence_invalid');
    const original=authority;
    await withTransaction(input.session,async()=>{
     if(!await fenced(input))return;
     const current=await readBackfillAuthority(context,importId,true);
     if(current===null||JSON.stringify(current.proof)!==JSON.stringify(original.proof)||current.historyAnchor!==null)return;
     await input.session.query(`WITH instant AS(SELECT clock_timestamp() AS at) UPDATE crm_mail_imports SET to_at=instant.at,from_at=instant.at-interval '7776000 seconds',history_anchor=$3,history_cursor=$3,state='partial',reason=NULL FROM instant WHERE workspace_id=$1 AND id=$2`,[input.scope.workspaceId,importId,profile.historyId]);
     await input.session.query(`UPDATE crm_mail_import_slices x SET from_epoch_seconds=floor(extract(epoch FROM i.from_at))::bigint+x.ordinal*86400,to_epoch_seconds=floor(extract(epoch FROM i.from_at))::bigint+(x.ordinal+1)*86400 FROM crm_mail_imports i WHERE i.workspace_id=$1 AND i.id=$2 AND x.workspace_id=i.workspace_id AND x.import_id=i.id AND x.state='pending'`,[input.scope.workspaceId,importId]);
    });
    authority=await readBackfillAuthority(context,importId);if(authority===null||authority.historyAnchor===null)return;
   }
   const slice=(await input.session.query<{ordinal:number;from_epoch_seconds:string;to_epoch_seconds:string;next_page_token:string|null}>("SELECT ordinal,from_epoch_seconds,to_epoch_seconds,next_page_token FROM crm_mail_import_slices WHERE workspace_id=$1 AND import_id=$2 AND state='pending' ORDER BY ordinal LIMIT 1",[input.scope.workspaceId,importId])).rows[0];
   if(slice===undefined){
    const bound=authority;
    if(bound.historyCursor===null)return;
    const history=await providerRead('history',bound,access=>adapters.gmail.listHistory(access,{startHistoryId:bound.historyCursor!,maxResults:25,...bound.historyPageToken===null?{}:{pageToken:bound.historyPageToken}}));
    if(!history.ok)throw new BackfillFailure(history.reason==='history_expired'?'history_coverage_expired':'provider_read_unavailable');
    if(!/^[0-9]{1,20}$/u.test(history.historyId)||BigInt(history.historyId)<BigInt(bound.historyCursor)||history.nextPageToken!==null&&history.nextPageToken.length>2000)throw new BackfillFailure('provider_evidence_invalid');
    let previous=BigInt(bound.historyCursor);
    for(const record of history.records){
     if(!/^[0-9]{1,20}$/u.test(record.id)||BigInt(record.id)<=previous||BigInt(record.id)>BigInt(history.historyId))throw new BackfillFailure('provider_evidence_invalid');
     previous=BigInt(record.id);
     const unique=new Set(record.changes.map(change=>change.messageId));
     for(const messageId of unique){
      if(!/^[A-Za-z0-9_-]{1,128}$/u.test(messageId))throw new BackfillFailure('provider_evidence_invalid');
      const metadata=await providerRead('metadata',bound,access=>adapters.gmail.getMetadata(access,messageId,METADATA_HEADERS));
      if(metadata!==null&&(metadata.id!==messageId||!Number.isSafeInteger(metadata.internalDateEpochMilliseconds)))throw new BackfillFailure('provider_evidence_invalid');
      await withTransaction(input.session,async()=>{
       if(!await fenced(input))throw new BackfillFailure('acquisition_binding_changed');
       const current=await readBackfillAuthority(context,importId,true);
       if(current===null||JSON.stringify(current.proof)!==JSON.stringify(bound.proof)||current.historyCursor!==bound.historyCursor||current.historyPageToken!==bound.historyPageToken||current.fromEpochMicroseconds!==bound.fromEpochMicroseconds||current.toEpochMicroseconds!==bound.toEpochMicroseconds)throw new BackfillFailure('acquisition_binding_changed');
       const observationReceipt=metadata===null?undefined:await adapters.observer.observe(context,{mailboxId:current.proof.mailboxId,ownerUserId:current.proof.ownerUserId,providerAccountId:current.proof.providerAccountId,generation:current.proof.generation,metadata,acquisitionOrigin:{importId}});
       await recordBackfillMetadata(context,{authority:current,messageId,metadata,scope:'overlap',observationReceipt});
      });
     }
    }
    await withTransaction(input.session,async()=>{
     if(!await fenced(input))return;
     const current=await readBackfillAuthority(context,importId,true);
     if(current===null||JSON.stringify(current.proof)!==JSON.stringify(bound.proof)||current.historyCursor!==bound.historyCursor||current.historyPageToken!==bound.historyPageToken||current.fromEpochMicroseconds!==bound.fromEpochMicroseconds||current.toEpochMicroseconds!==bound.toEpochMicroseconds)return;
     const count=(await input.session.query<{count:string}>("SELECT count(*)::text AS count FROM crm_mail_import_slices WHERE workspace_id=$1 AND import_id=$2 AND state='complete'",[input.scope.workspaceId,importId])).rows[0]!.count;
     if(count!=='90')return;
     await input.session.query("UPDATE crm_mail_imports SET history_cursor=$3,history_page_token=$4,history_complete=$5,state=$6,completed_at=CASE WHEN $5 THEN clock_timestamp() ELSE NULL END,reason=NULL WHERE workspace_id=$1 AND id=$2",[input.scope.workspaceId,importId,history.nextPageToken===null?history.historyId:bound.historyCursor,history.nextPageToken,history.nextPageToken===null,history.nextPageToken===null?'complete':'partial']);
    });
    return;
   }
   const listed=await providerRead('list',authority,access=>adapters.gmail.listMessageIds(access,{afterEpochSeconds:Number(slice.from_epoch_seconds)-1,beforeEpochSeconds:Number(slice.to_epoch_seconds)+1,maxResults:25,...slice.next_page_token===null?{}:{pageToken:slice.next_page_token}}));
   if(!listed.ok)throw new BackfillFailure('provider_read_unavailable');
   for(const messageId of listed.messageIds){
    if(!/^[A-Za-z0-9_-]{1,128}$/u.test(messageId))throw new BackfillFailure('provider_evidence_invalid');
    const metadata=await providerRead('metadata',authority,access=>adapters.gmail.getMetadata(access,messageId,METADATA_HEADERS));
    if(metadata!==null&&(metadata.id!==messageId||!Number.isSafeInteger(metadata.internalDateEpochMilliseconds)))throw new BackfillFailure('provider_evidence_invalid');
    if(metadata!==null&&(BigInt(metadata.internalDateEpochMilliseconds)*1000n<BigInt(authority.fromEpochMicroseconds)||BigInt(metadata.internalDateEpochMilliseconds)*1000n>=BigInt(authority.toEpochMicroseconds)))continue;
    const expected=authority;
    await withTransaction(input.session,async()=>{
     if(!await fenced(input))throw new BackfillFailure('acquisition_binding_changed');
     const current=await readBackfillAuthority(context,importId,true);
     if(current===null||JSON.stringify(current.proof)!==JSON.stringify(expected.proof)||current.fromEpochMicroseconds!==expected.fromEpochMicroseconds||current.toEpochMicroseconds!==expected.toEpochMicroseconds)throw new BackfillFailure('acquisition_binding_changed');
     const observationReceipt=metadata===null?undefined:await adapters.observer.observe(context,{mailboxId:current.proof.mailboxId,ownerUserId:current.proof.ownerUserId,providerAccountId:current.proof.providerAccountId,generation:current.proof.generation,metadata,acquisitionOrigin:{importId}});
     await recordBackfillMetadata(context,{authority:current,messageId,metadata,scope:'historical',observationReceipt});
    });
   }
   const bound=authority;
   await withTransaction(input.session,async()=>{
    if(!await fenced(input))return;
    const current=await readBackfillAuthority(context,importId,true);
    if(current===null||JSON.stringify(current.proof)!==JSON.stringify(bound.proof)||current.fromEpochMicroseconds!==bound.fromEpochMicroseconds||current.toEpochMicroseconds!==bound.toEpochMicroseconds)return;
    const locked=(await input.session.query<{from_epoch_seconds:string;to_epoch_seconds:string;next_page_token:string|null}>("SELECT from_epoch_seconds,to_epoch_seconds,next_page_token FROM crm_mail_import_slices WHERE workspace_id=$1 AND import_id=$2 AND ordinal=$3 AND state='pending' FOR UPDATE",[input.scope.workspaceId,importId,slice.ordinal])).rows[0];
    const start=Math.floor(Date.parse(current.fromAt)/1000)+slice.ordinal*86400;
    if(locked===undefined||Number(locked.from_epoch_seconds)!==start||Number(locked.to_epoch_seconds)!==start+86400||locked.next_page_token!==slice.next_page_token)return;
    await input.session.query("UPDATE crm_mail_import_slices SET state=$4,next_page_token=$5 WHERE workspace_id=$1 AND import_id=$2 AND ordinal=$3",[input.scope.workspaceId,importId,slice.ordinal,listed.nextPageToken===null?'complete':'pending',listed.nextPageToken]);
    await input.session.query("UPDATE crm_mail_imports SET state='partial',reason=NULL WHERE workspace_id=$1 AND id=$2 AND state<>'complete'",[input.scope.workspaceId,importId]);
   });
  }catch(error){if(error instanceof BackfillFailure){await block(error.message);if(error.message==='provider_read_unavailable'||error.message==='quota_or_authority_unavailable')throw error;}else throw error;}
 },
};}
