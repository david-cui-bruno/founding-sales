import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {ResearchErasureScope} from './officeAssessments.ts';
/** ADR0036. The provider person's copy (name, title, address, provider id: `outreach_people_contacts`) of every company admitted into the deleted Firm or
 * contact, or whose address is one of the deleted routes. `$1` workspace, `$2` contact (null: the whole Firm), `$3` Firm. The body-free spend custody
 * (`outreach_people_lookups`) and paid-check ledger (`outreach_people_paid_checks`) survive, so erasure never resets a spend cap or paid-check fence. */
const PEOPLE_IN_SCOPE=`c.workspace_id=$1 AND (c.candidate_id IN (SELECT candidate_id FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND firm_id=$3 AND ($2::uuid IS NULL OR contact_id=$2::uuid))
 OR c.email IN (SELECT lower(address) FROM email_addresses WHERE workspace_id=$1 AND firm_id=$3 AND ($2::uuid IS NULL OR contact_id=$2::uuid)))`;
const parameters=(ctx:RepositoryContext,scope:ResearchErasureScope)=>[ctx.scope.workspaceId,scope.contactId,scope.firmId];
const count=async(ctx:RepositoryContext,sql:string,scope:ResearchErasureScope)=>Number((await ctx.db.query<{count:string}>(sql,parameters(ctx,scope))).rows[0]?.count??0);
/** What a deletion preview shows: person copies it would remove, and the spend custody it leaves alone (by table). */
export async function measurePeopleErasure(ctx:RepositoryContext,scope:ResearchErasureScope):Promise<{removes:Record<string,number>;retains:Record<string,number>}>{
 return {
  removes:{outreach_people_contacts:await count(ctx,`SELECT count(*) AS count FROM outreach_people_contacts c WHERE ${PEOPLE_IN_SCOPE}`,scope)},
  retains:{
   outreach_people_lookups:await count(ctx,`SELECT count(*) AS count FROM outreach_people_lookups l WHERE l.workspace_id=$1 AND l.id IN (SELECT c.lookup_id FROM outreach_people_contacts c WHERE ${PEOPLE_IN_SCOPE})`,scope),
   outreach_people_paid_checks:await count(ctx,`SELECT count(*) AS count FROM outreach_people_paid_checks p WHERE p.workspace_id=$1 AND p.candidate_id IN (
    SELECT c.candidate_id FROM outreach_people_contacts c WHERE ${PEOPLE_IN_SCOPE}
    UNION SELECT candidate_id FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND firm_id=$3 AND ($2::uuid IS NULL OR contact_id=$2::uuid))`,scope),
  },
 };
}
/** Commit: delete the person copies measured above. Called before the routes and contacts they are matched through are redacted. */
export async function erasePeople(ctx:RepositoryContext,scope:ResearchErasureScope):Promise<Record<string,number>>{
 // The custody row is locked first: it is what an admission share-locks to read the person copy (which the application may delete but not lock).
 await ctx.db.query(`SELECT l.id FROM outreach_people_lookups l WHERE l.workspace_id=$1 AND l.id IN (SELECT c.lookup_id FROM outreach_people_contacts c WHERE ${PEOPLE_IN_SCOPE}) ORDER BY l.id FOR UPDATE`,parameters(ctx,scope));
 const result=await ctx.db.query(`DELETE FROM outreach_people_contacts c WHERE ${PEOPLE_IN_SCOPE}`,parameters(ctx,scope));
 return {outreach_people_contacts:result.rowCount??0};
}
