import type {RepositoryContext} from '../db/workspaceScope.ts';
interface Scope{firmId:string;contactId:string|null}
/** Use deletion's exact existing meeting predicate, including unmatched attendees.
 * No prose is selected or hashed into deletion artifacts. Revision is the fence. */
export async function privateDraftDeletionRows(ctx:RepositoryContext,scope:Scope,meetingPredicate:string):Promise<{count:number;versions:{kind:string;id:string;revision:number;hash:null;state:string}[]}>{
 const rows=(await ctx.db.query<{id:string;revision:number}>(`SELECT d.id,d.revision FROM social_private_drafts d WHERE d.workspace_id=$1 AND d.reason IS NULL AND (
 ($2::uuid IS NULL AND d.dependencies @> jsonb_build_object('firms',jsonb_build_array(($3::uuid)::text)))
 OR EXISTS(SELECT 1 FROM call_sessions c WHERE c.workspace_id=d.workspace_id AND c.firm_id=$3::uuid AND ($2::uuid IS NULL OR c.contact_id=$2) AND d.dependencies @> jsonb_build_object('call_sessions',jsonb_build_array(c.id::text)))
 OR EXISTS(SELECT 1 FROM meetings m WHERE m.workspace_id=d.workspace_id AND ${meetingPredicate} AND d.dependencies @> jsonb_build_object('meetings',jsonb_build_array(m.id::text)))) ORDER BY d.id`,[ctx.scope.workspaceId,scope.contactId,scope.firmId])).rows;
 return {count:rows.length,versions:rows.map(row=>({kind:'social_private_draft',id:row.id,revision:row.revision,hash:null,state:'available'}))};
}
