import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readPreparedEmail} from '../sourcing/preparedEmailRead.ts';
import {currentValidEmailVerification} from './emailVerification.ts';
import {currentPeopleContact} from './peopleContacts.ts';
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
export interface PreparedEmailProof {route:EmailEvidenceRoute;/** The resolved business name (`resolveBusinessName`): the Firm's name. */businessName:string;/** ms epoch after which this proof no longer holds: the earliest of the provider contact's expiry, the campaign's, the prepared evidence's deadline and, for an own-site person, the cited page's own deadline. */validUntil:number}
/** The association confidence a provider's match earns: a high match is the person at this company; a medium one clears the route floor. */
const CONFIDENCE={high:0.95,medium:0.85} as const;
/** Exactly the selected run, revision and address, read under the caller's locks: the company is still prepared (its brief, name and region)
 * and in a campaign region, a current found provider person for this exact revision owns the address, and the address has a current valid
 * verification; an own-site person's cited page (its URL and block) is still among the admitted pages, and its deadline bounds the proof (ADR0037). The route's "observation" is the provider contact row, so the source row cites the person's provenance. Null otherwise; never a reviewed flag. */
export async function preparedEmailProof(ctx:RepositoryContext,campaign:EmailCampaignRow,target:PreparedEmailTarget):Promise<PreparedEmailProof|null>{
 const read=await readPreparedEmail(ctx,{candidateId:target.candidateId,expectedRevision:target.candidateRevision},()=>preparedCampaignActor(ctx,campaign.owner_user_id));
 if(!read||read.runId!==target.runId||!campaign.regions.some(region=>region===read.region))return null;
 const person=await currentPeopleContact(ctx,target.candidateId,target.candidateRevision);
 if(!person||person.email!==target.address||person.host!==read.host||!await currentValidEmailVerification(ctx,person.email))return null;
 // An own-site person is read from one page: that page and block must still be admitted (not expired, removed or changed), else the person is no longer evidenced.
 const cited=person.source?read.pages.find(page=>page.url===person.source!.url&&page.blocks.some(block=>block.id===person.source!.blockId)):undefined;
 if(person.source&&!cited)return null;
 return {businessName:read.businessName,route:{address:person.email,sourceObservationId:person.id,blockId:`person:${person.provider}`,identityKind:'named',displayName:`${person.firstName} ${person.lastName}`,person:{title:person.title,associationConfidence:CONFIDENCE[person.matchConfidence]}},validUntil:Math.min(person.expiresAt.getTime(),campaign.expires_at.getTime(),read.evidenceDeadline,cited?.deadline??Infinity)};
}
