import type {RepositoryContext} from '../db/workspaceScope.ts';
export interface ExistingEmailRoute {id:string;contactId:string;attributed:boolean}
type Result={ok:true;value:ExistingEmailRoute|null}|{ok:false;reason:'existing_email_requires_review'};
/** Reuse only one exact active, usable route at the matched firm. No record is
 * repaired, reassigned or revalidated here. Admission holds the firm, which CRM
 * mutations also acquire before writing. Do not lock a route after the firm: route
 * mutations acquire those row locks in the opposite order. */
export async function existingEmailRoute(ctx:RepositoryContext,firmId:string,address:string,source?:{candidateId:string;qualificationRunId:string}):Promise<Result>{
 const rows=(await ctx.db.query<{id:string;contact_id:string|null;eligibility:string;technical_validation:string;retired_at:Date|null;contact_status:string|null;contact_firm_id:string|null;attributed:boolean}>(`SELECT e.id,e.contact_id,e.eligibility,e.technical_validation,e.retired_at,c.status AS contact_status,c.firm_id AS contact_firm_id,
  EXISTS(SELECT 1 FROM outreach_email_sources s WHERE s.workspace_id=e.workspace_id AND s.candidate_id=$4 AND s.run_id=$5 AND s.firm_id=e.firm_id AND s.contact_id=e.contact_id AND s.route_id=e.id AND NOT s.association_review_required) AS attributed
  FROM email_addresses e LEFT JOIN contacts c ON c.workspace_id=e.workspace_id AND c.id=e.contact_id
  WHERE e.workspace_id=$1 AND e.firm_id=$2 AND e.address=$3 ORDER BY e.id`,[ctx.scope.workspaceId,firmId,address,source?.candidateId??null,source?.qualificationRunId??null])).rows;
 if(!rows.length)return {ok:true,value:null};
 // Previously admitted evidence may await normal validation. This exception is
 // bound to the same run/contact/route and never permits a new unverified reuse.
 const active=rows.filter(r=>r.retired_at===null),r=active[0];
 if(active.length!==1||!r?.contact_id||!(r.eligibility==='usable'&&r.technical_validation==='passed'||r.attributed&&r.eligibility==='candidate'&&r.technical_validation==='unknown')||r.contact_status!=='active'||r.contact_firm_id!==firmId)return {ok:false,reason:'existing_email_requires_review'};
 return {ok:true,value:{id:r.id,contactId:r.contact_id,attributed:r.attributed}};
}
