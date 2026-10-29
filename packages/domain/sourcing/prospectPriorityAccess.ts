import {isDeepStrictEqual} from 'node:util';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {currentManualActivityAuthority,MANUAL_ACTIVITY_RAW_SQL,type ManualActivityAuthority} from './manualProspectActivityAccess.ts';
import {currentPriorityRoles} from './prospectPriorityRoles.ts';
import {priorityAssessment} from './prospectPriorityStore.ts';
export class ProspectPriorityChanged extends Error{constructor(readonly reason:string){super(reason);}}
export async function prioritySourceKey(ctx:RepositoryContext,candidateId:string,revision:number):Promise<string|null>{
 return (await ctx.db.query<{key:string}>(`SELECT encode(sha256(convert_to(p.payload::text||COALESCE(p.origins::text,'')||COALESCE(p.source_check::text,''),'UTF8')),'hex') AS key FROM (${MANUAL_ACTIVITY_RAW_SQL}) p WHERE p.id=$3 AND p.revision=$4`,[ctx.scope.workspaceId,'all',candidateId,revision])).rows[0]?.key??null;
}
/** Final command callback after command receipt/audit waits. Any loss rolls back. */
export async function currentProspectPriorityAuthority(ctx:RepositoryContext,input:{candidateId:string;expectedCandidateRevision:number;considerationId?:string},authority:ManualActivityAuthority):Promise<void>{
 await currentManualActivityAuthority(ctx,input.candidateId,input.expectedCandidateRevision,authority);
 if(input.considerationId){
  const snapshot=(await ctx.db.query<{source_key:string;roles:unknown;expires_at:Date}>('SELECT source_key,roles,expires_at FROM sourcing_prospect_considerations WHERE workspace_id=$1 AND id=$2 AND candidate_id=$3 AND candidate_revision=$4',[ctx.scope.workspaceId,input.considerationId,input.candidateId,input.expectedCandidateRevision])).rows[0];
  if(!snapshot||snapshot.source_key!==await prioritySourceKey(ctx,input.candidateId,input.expectedCandidateRevision))throw new ProspectPriorityChanged('source_changed');
  if(!isDeepStrictEqual(snapshot.roles,await currentPriorityRoles(ctx,input.candidateId,snapshot.roles)))throw new ProspectPriorityChanged('role_unavailable');
  await currentManualActivityAuthority(ctx,input.candidateId,input.expectedCandidateRevision,authority);
  if(snapshot.expires_at<=(await ctx.db.query<{at:Date}>('SELECT clock_timestamp() at')).rows[0]!.at)throw new ProspectPriorityChanged('source_expired');
  return;
 }
 const row=await priorityAssessment(ctx,input.candidateId);if(!row)return;
 if(row.candidate_revision!==input.expectedCandidateRevision||row.source_key!==await prioritySourceKey(ctx,input.candidateId,input.expectedCandidateRevision))throw new ProspectPriorityChanged('source_changed');
 const roles=await currentPriorityRoles(ctx,input.candidateId,row.roles);
 if(!isDeepStrictEqual(roles,row.roles))throw new ProspectPriorityChanged('role_unavailable');
 await currentManualActivityAuthority(ctx,input.candidateId,input.expectedCandidateRevision,authority);
 const clock=(await ctx.db.query<{at:Date}>('SELECT clock_timestamp() at')).rows[0]!.at;
 if(row.expires_at<=clock)throw new ProspectPriorityChanged('source_expired');
}
