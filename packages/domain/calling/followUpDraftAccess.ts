import type {CallingFollowUpSource} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';
import {loadFirmForUpdate} from '../crm/firms.ts';
import {decideFirmMutation} from '../crm/authorization.ts';
import {lockManualActivityCandidate,currentManualActivityAuthority,ManualActivityUnavailable} from '../sourcing/manualProspectActivityAccess.ts';

export type CallingAuthority=()=>Promise<boolean>;
export class CallingAuthorityChanged extends Error {}
export class CallingUnavailable extends Error {
 constructor(readonly reason:'source_unavailable'|'source_changed'|'draft_unavailable'|'stale_revision'){super(reason);}
}
export async function requireCallingAuthority(ctx:RepositoryContext,authority:CallingAuthority):Promise<void>{
 if(ctx.scope.actor.kind==='user')await ctx.db.query('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[ctx.scope.workspaceId,ctx.scope.actor.userId]);
 if(ctx.scope.actor.kind!=='user'||!await authority()||!await activeIdentityActor(ctx))throw new CallingAuthorityChanged();
}
/** Source first, draft second. Never dispatch or acquire the send gate from a read. */
export async function lockCallingSource(ctx:RepositoryContext,source:CallingFollowUpSource):Promise<void>{
 if(source.kind==='candidate'){
  try{await lockManualActivityCandidate(ctx,source.candidateId,source.candidateRevision);}
  catch(error){if(error instanceof ManualActivityUnavailable)throw new CallingUnavailable('source_unavailable');throw error;}
  const attempt=(await ctx.db.query<{content:unknown;reason:string|null}>(`SELECT content,reason FROM sourcing_manual_prospect_attempts
   WHERE workspace_id=$1 AND id=$2 AND candidate_id=$3 AND candidate_revision=$4 FOR UPDATE`,[ctx.scope.workspaceId,source.attemptId,source.candidateId,source.candidateRevision])).rows[0];
  if(!attempt||attempt.content===null||attempt.reason!==null)throw new CallingUnavailable('source_unavailable');
 }else{
  const firm=await loadFirmForUpdate(ctx,source.firmId);
  if(!firm||firm.status!=='active'||!decideFirmMutation(ctx,firm).permitted)throw new CallingUnavailable('source_unavailable');
  const log=(await ctx.db.query('SELECT id FROM call_logs WHERE workspace_id=$1 AND id=$2 AND firm_id=$3 FOR KEY SHARE',[ctx.scope.workspaceId,source.callLogId,source.firmId])).rows[0];
  if(!log)throw new CallingUnavailable('source_unavailable');
 }
}
/** Run again after draft, receipt-uniqueness and principal lock waits, before commit. */
export async function currentCallingSource(ctx:RepositoryContext,source:CallingFollowUpSource,authority:CallingAuthority):Promise<void>{
 await requireCallingAuthority(ctx,authority);
 if(source.kind==='candidate'){
  try{await currentManualActivityAuthority(ctx,source.candidateId,source.candidateRevision,authority);}
  catch(error){if(error instanceof ManualActivityUnavailable)throw new CallingUnavailable('source_unavailable');throw error;}
  const current=(await ctx.db.query(`SELECT id FROM sourcing_manual_prospect_attempts WHERE workspace_id=$1 AND id=$2
   AND candidate_id=$3 AND candidate_revision=$4 AND content IS NOT NULL AND reason IS NULL`,[ctx.scope.workspaceId,source.attemptId,source.candidateId,source.candidateRevision])).rows[0];
  if(!current)throw new CallingUnavailable('source_unavailable');
 }else{
  const firm=await loadFirmForUpdate(ctx,source.firmId);
  if(!firm||firm.status!=='active'||!decideFirmMutation(ctx,firm).permitted)throw new CallingUnavailable('source_unavailable');
  if(!(await ctx.db.query('SELECT id FROM call_logs WHERE workspace_id=$1 AND id=$2 AND firm_id=$3',[ctx.scope.workspaceId,source.callLogId,source.firmId])).rows.length)throw new CallingUnavailable('source_unavailable');
 }
}
