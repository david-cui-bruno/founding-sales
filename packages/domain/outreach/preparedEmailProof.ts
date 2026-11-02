import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readPreparedEmail} from '../sourcing/preparedEmailRead.ts';
import {currentValidEmailVerification} from './emailVerification.ts';
import {automaticCampaignActor} from './emailCampaignAutomatic.ts';
import type {PreparedEmailTarget} from './emailCampaignSource.ts';
import type {EmailEvidenceRoute} from './selection.ts';
import type {EmailCampaignRow} from './emailCampaignAuthority.ts';

/** The approved campaign's owner stands behind a prepared admission: the registered worker or scheduler, or that same admin
 * at a browser, never an impersonation, and never without a current active admin membership. */
export async function preparedCampaignActor(ctx:RepositoryContext,owner:string):Promise<boolean>{
 if(!automaticCampaignActor(ctx,owner))return false;
 const member=(await ctx.db.query<{role:string;status:string}>('SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[ctx.scope.workspaceId,owner])).rows[0];
 return member?.role==='admin'&&member.status==='active';
}
export interface PreparedEmailProof {route:EmailEvidenceRoute;/** ms epoch after which this proof no longer holds. */validUntil:number}
/** Exactly the selected run, revision and address, read under the caller's locks: the candidate's current own-site pages still publish the
 * address, the company is in a campaign region and the address has a current valid verification. Null otherwise; never a reviewed flag. */
export async function preparedEmailProof(ctx:RepositoryContext,campaign:EmailCampaignRow,target:PreparedEmailTarget):Promise<PreparedEmailProof|null>{
 const read=await readPreparedEmail(ctx,{candidateId:target.candidateId,expectedRevision:target.candidateRevision},()=>preparedCampaignActor(ctx,campaign.owner_user_id));
 if(!read||read.runId!==target.runId||read.route.address!==target.address||!campaign.regions.some(region=>region===read.region))return null;
 if(!await currentValidEmailVerification(ctx,read.route.address))return null;
 return {route:{address:read.route.address,sourceObservationId:read.route.observationId,blockId:read.route.blockId,identityKind:'role',displayName:'Office'},validUntil:Math.min(read.route.expiresAt,campaign.expires_at.getTime())};
}
