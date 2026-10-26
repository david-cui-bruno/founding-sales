import {isDeepStrictEqual} from 'node:util';
import type {SourceObservation,ProspectPhoneDiscoveryReason} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockDiscoveryReviewSources} from './discoveryReviewVisibility.ts';
import {retainedCandidateOnly} from './retainedAcquisition.ts';
import {phoneDiscoveryAdmin,phoneDiscoveryContext,phoneDiscoveryNow,phoneDiscoveryResearchRefusal,phoneDiscoverySourceLimit,type PhoneDiscoveryContext} from './prospectPhoneDiscoveryAuthority.ts';

export interface PhoneDiscoveryContent extends PhoneDiscoveryContext {observations:SourceObservation[]}
export interface PhoneDiscoveryRun extends Record<string,unknown>{
 id:string;candidate_id:string;candidate_revision:number;creator_user_id:string;creator_ref:string|null;
 method:'company-public-phone-v1';state:'pending'|'running'|'complete'|'unavailable';reason:ProspectPhoneDiscoveryReason|null;
 requested_at:Date;deadline_at:Date;checked_at:Date|null;expires_at:Date;dispatched_at:Date|null;dispatch_finished_at:Date|null;
 content:PhoneDiscoveryContent|null;
}
export async function lockPhoneDiscoveryCandidate(ctx:RepositoryContext,candidateId:string):Promise<{revision:number}|null>{
 await lockDiscoveryReviewSources(ctx);
 return (await ctx.db.query<{revision:number}>('SELECT revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,candidateId])).rows[0]??null;
}
export async function phoneDiscoveryRun(ctx:RepositoryContext,candidateId:string,revision:number):Promise<PhoneDiscoveryRun|null>{
 const owner=(await ctx.db.query<{creator_user_id:string}>('SELECT creator_user_id FROM sourcing_prospect_phone_discoveries WHERE workspace_id=$1 AND candidate_id=$2 AND candidate_revision=$3',[ctx.scope.workspaceId,candidateId,revision])).rows[0];
 if(owner)await phoneDiscoveryAdmin(ctx,owner.creator_user_id);
 return (await ctx.db.query<PhoneDiscoveryRun>('SELECT * FROM sourcing_prospect_phone_discoveries WHERE workspace_id=$1 AND candidate_id=$2 AND candidate_revision=$3 FOR UPDATE',[ctx.scope.workspaceId,candidateId,revision])).rows[0]??null;
}
/** IDs-only initial read, then lifecycle -> candidate -> run locks. */
export async function lockPhoneDiscoveryRun(ctx:RepositoryContext,runId:string):Promise<PhoneDiscoveryRun|null>{
 const ref=(await ctx.db.query<{candidate_id:string;creator_user_id:string}>('SELECT candidate_id,creator_user_id FROM sourcing_prospect_phone_discoveries WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,runId])).rows[0];
 if(!ref)return null;
 await lockPhoneDiscoveryCandidate(ctx,ref.candidate_id);
 await phoneDiscoveryAdmin(ctx,ref.creator_user_id);
 return (await ctx.db.query<PhoneDiscoveryRun>('SELECT * FROM sourcing_prospect_phone_discoveries WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,runId])).rows[0]??null;
}
export async function invalidatePhoneDiscovery(ctx:RepositoryContext,runId:string,reason:ProspectPhoneDiscoveryReason,dispatchFinished=false):Promise<void>{
 await ctx.db.query(`UPDATE sourcing_prospect_phone_discoveries SET state='unavailable',reason=$3,content=NULL,checked_at=clock_timestamp(),
 dispatch_finished_at=CASE WHEN $4 AND dispatched_at IS NOT NULL THEN COALESCE(dispatch_finished_at,clock_timestamp()) ELSE dispatch_finished_at END
 WHERE workspace_id=$1 AND id=$2`,[ctx.scope.workspaceId,runId,reason,dispatchFinished]);
}
/** Always recheck after locks/waits. A shorter source lifetime can only shrink the grant. */
export async function validatePhoneDiscoveryRun(ctx:RepositoryContext,run:PhoneDiscoveryRun,acquisition:boolean):Promise<ProspectPhoneDiscoveryReason|null>{
 if(!run.creator_ref||!await phoneDiscoveryAdmin(ctx,run.creator_user_id))return 'authority_changed';
 const candidate=(await ctx.db.query<{revision:number}>('SELECT revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,run.candidate_id])).rows[0];
 if(!candidate)return 'candidate_unavailable';
 if(candidate.revision!==run.candidate_revision)return 'candidate_changed';
 const current=await phoneDiscoveryContext(ctx,run.candidate_id,run.candidate_revision);
 if(!current||!run.content)return 'source_unavailable';
 if(!isDeepStrictEqual(current,{website:run.content.website,sourceUrls:run.content.sourceUrls}))return 'source_changed';
 if(await retainedCandidateOnly(ctx,run.candidate_id))return 'retained_only';
 if(acquisition){const research=await phoneDiscoveryResearchRefusal(ctx,run.creator_user_id,run.requested_at);if(research)return research;}
 const limits=await phoneDiscoverySourceLimit(ctx,[...current.sourceUrls,...run.content.observations.map(source=>source.url)]);
 if(limits.denied)return 'source_not_permitted';
 const now=await phoneDiscoveryNow(ctx);
 if(run.expires_at<=now||limits.expiresAt&&limits.expiresAt<=now)return 'source_expired';
 if(limits.expiresAt&&limits.expiresAt<run.expires_at){
  run.expires_at=limits.expiresAt;
  await ctx.db.query('UPDATE sourcing_prospect_phone_discoveries SET expires_at=$3 WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,run.id,run.expires_at]);
 }
 if(['pending','running'].includes(run.state)&&run.deadline_at<=now)return 'discovery_expired';
 return null;
}
/** Caller holds source and candidate locks. Creator locks precede run locks because
 * membership deletion physically erases runs while holding the membership row. */
export async function phoneDiscoverySnapshots(ctx:RepositoryContext,rows:readonly {id:string;revision:number}[]):Promise<PhoneDiscoveryRun[]>{
 if(!rows.length)return [];
 const ids=rows.map(row=>row.id);
 const owners=(await ctx.db.query<{creator_user_id:string}>('SELECT DISTINCT creator_user_id FROM sourcing_prospect_phone_discoveries WHERE workspace_id=$1 AND candidate_id=ANY($2::uuid[]) ORDER BY creator_user_id',[ctx.scope.workspaceId,ids])).rows;
 for(const owner of owners)await phoneDiscoveryAdmin(ctx,owner.creator_user_id);
 const runs=(await ctx.db.query<PhoneDiscoveryRun>('SELECT * FROM sourcing_prospect_phone_discoveries WHERE workspace_id=$1 AND candidate_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[ctx.scope.workspaceId,ids])).rows.filter(run=>rows.some(row=>row.id===run.candidate_id&&row.revision===run.candidate_revision));
 for(const run of runs)if(run.state!=='unavailable'){
  const denial=await validatePhoneDiscoveryRun(ctx,run,false);
  if(denial){await invalidatePhoneDiscovery(ctx,run.id,denial);run.state='unavailable';run.reason=denial;run.content=null;run.checked_at=await phoneDiscoveryNow(ctx);}
 }
 return runs;
}
