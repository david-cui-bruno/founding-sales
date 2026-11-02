import type {RepositoryContext} from '../db/workspaceScope.ts';

/** ADR0036/0037. A found person is current for thirty days. */
export const PEOPLE_CONTACT_VALID_DAYS=30;
/** A named decision-maker found for this exact candidate revision (a people-data provider's, or the company's own pages: `own_site`). `email` is a verified or own-page-published personal address at the company's own host, or null for a person who is named but has no address (shown to Calling, never admitted). `source` is the page citation of an own-site person. */
export interface PeopleContact {id:string;candidateId:string;candidateRevision:number;host:string;provider:string;providerPersonId:string;firstName:string;lastName:string;title:string;email:string|null;emailStatus:'verified'|'published'|'unavailable';source:{url:string;blockId:string;quote:string}|null;matchConfidence:'high'|'medium';credits:number;observedAt:Date;expiresAt:Date}
interface ContactRow extends Record<string,unknown>{id:string;candidate_id:string;candidate_revision:number;host:string;provider:string;provider_person_id:string;first_name:string;last_name:string;title:string;email:string|null;email_status:PeopleContact['emailStatus'];source_url:string|null;source_block_id:string|null;source_quote:string|null;match_confidence:'high'|'medium';credits:number;observed_at:Date;expires_at:Date}
const view=(row:ContactRow):PeopleContact=>({id:row.id,candidateId:row.candidate_id,candidateRevision:row.candidate_revision,host:row.host,provider:row.provider,providerPersonId:row.provider_person_id,firstName:row.first_name,lastName:row.last_name,title:row.title,email:row.email,emailStatus:row.email_status,source:row.source_url===null?null:{url:row.source_url,blockId:row.source_block_id!,quote:row.source_quote!},matchConfidence:row.match_confidence,credits:row.credits,observedAt:row.observed_at,expiresAt:row.expires_at});
/** The found lookup (spend custody) joined to the provider person's copy; an erased person leaves the lookup `found` but joins to nothing. */
const FROM="outreach_people_lookups p JOIN outreach_people_contacts q ON q.workspace_id=p.workspace_id AND q.lookup_id=p.id";
const COLUMNS='p.id,p.candidate_id,p.candidate_revision,p.host,p.provider,q.provider_person_id,q.first_name,q.last_name,q.title,q.email,q.email_status,q.source_url,q.source_block_id,q.source_quote,q.match_confidence,p.credits,p.observed_at,p.expires_at';
const CURRENT="p.state='found' AND p.expires_at>clock_timestamp()";
/** Every current found person of the workspace (or of the listed candidates), with or without an address, newest observation per candidate. Advisory and unlocked: admission re-proves each. */
export async function currentPeopleContacts(ctx:RepositoryContext,candidateIds?:readonly string[]):Promise<Map<string,PeopleContact>>{
 const rows=(await ctx.db.query<ContactRow>(`SELECT DISTINCT ON (p.candidate_id) ${COLUMNS} FROM ${FROM} WHERE p.workspace_id=$1 AND ($2::uuid[] IS NULL OR p.candidate_id=ANY($2::uuid[])) AND ${CURRENT} ORDER BY p.candidate_id,p.observed_at DESC,p.id`,[ctx.scope.workspaceId,candidateIds??null])).rows;
 return new Map(rows.map(row=>[row.candidate_id,view(row)]));
}
/** The exact current person WITH an address for one candidate revision (a person without one is never admissible), its custody row share-locked (the person copy has no UPDATE grant to lock; erasure locks the same custody row first) so neither enrichment nor an erasure changes it under an admission transaction. */
export async function currentPeopleContact(ctx:RepositoryContext,candidateId:string,candidateRevision:number):Promise<PeopleContact|null>{
 const row=(await ctx.db.query<ContactRow>(`SELECT ${COLUMNS} FROM ${FROM} WHERE p.workspace_id=$1 AND p.candidate_id=$2 AND p.candidate_revision=$3 AND q.email IS NOT NULL AND ${CURRENT} ORDER BY p.observed_at DESC,p.id LIMIT 1 FOR SHARE OF p`,[ctx.scope.workspaceId,candidateId,candidateRevision])).rows[0];
 return row?view(row):null;
}

/** Companies whose current named person has no published address (ADR0037): named for Calling, not emailable. Workspace-wide and advisory. */
export async function countNamedWithoutEmail(ctx:RepositoryContext):Promise<number>{
 return Number((await ctx.db.query<{n:string}>(`SELECT count(DISTINCT p.candidate_id)::text AS n FROM ${FROM} WHERE p.workspace_id=$1 AND q.email IS NULL AND ${CURRENT}`,[ctx.scope.workspaceId])).rows[0]!.n);
}
