import type {RepositoryContext} from '../db/workspaceScope.ts';

/** ADR0036. A found person is current for thirty days. */
export const PEOPLE_CONTACT_VALID_DAYS=30;
/** A provider person the campaign may admit: verified, own-domain, personal-name address for this exact candidate revision. */
export interface PeopleContact {id:string;candidateId:string;candidateRevision:number;host:string;provider:string;providerPersonId:string;firstName:string;lastName:string;title:string;email:string;matchConfidence:'high'|'medium';credits:number;observedAt:Date;expiresAt:Date}
interface ContactRow extends Record<string,unknown>{id:string;candidate_id:string;candidate_revision:number;host:string;provider:string;provider_person_id:string;first_name:string;last_name:string;title:string;email:string;match_confidence:'high'|'medium';credits:number;observed_at:Date;expires_at:Date}
const view=(row:ContactRow):PeopleContact=>({id:row.id,candidateId:row.candidate_id,candidateRevision:row.candidate_revision,host:row.host,provider:row.provider,providerPersonId:row.provider_person_id,firstName:row.first_name,lastName:row.last_name,title:row.title,email:row.email,matchConfidence:row.match_confidence,credits:row.credits,observedAt:row.observed_at,expiresAt:row.expires_at});
const COLUMNS='id,candidate_id,candidate_revision,host,provider,provider_person_id,first_name,last_name,title,email,match_confidence,credits,observed_at,expires_at';
const CURRENT="state='found' AND expires_at>clock_timestamp()";
/** Every current found person of the workspace, newest observation per candidate. Advisory and unlocked: admission re-proves each. */
export async function currentPeopleContacts(ctx:RepositoryContext):Promise<Map<string,PeopleContact>>{
 const rows=(await ctx.db.query<ContactRow>(`SELECT DISTINCT ON (candidate_id) ${COLUMNS} FROM outreach_people_contacts WHERE workspace_id=$1 AND ${CURRENT} ORDER BY candidate_id,observed_at DESC,id`,[ctx.scope.workspaceId])).rows;
 return new Map(rows.map(row=>[row.candidate_id,view(row)]));
}
/** The exact current person for one candidate revision, share-locked so enrichment cannot change it under an admission transaction. */
export async function currentPeopleContact(ctx:RepositoryContext,candidateId:string,candidateRevision:number):Promise<PeopleContact|null>{
 const row=(await ctx.db.query<ContactRow>(`SELECT ${COLUMNS} FROM outreach_people_contacts WHERE workspace_id=$1 AND candidate_id=$2 AND candidate_revision=$3 AND ${CURRENT} ORDER BY observed_at DESC,id LIMIT 1 FOR SHARE`,[ctx.scope.workspaceId,candidateId,candidateRevision])).rows[0];
 return row?view(row):null;
}

