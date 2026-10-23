import type {RepositoryContext} from '../db/workspaceScope.ts';
export interface ResearchErasureScope {firmId:string;contactId:string|null}
const legacyTables=['firm_judgments','firm_facts','research_runs','firm_prepared_briefs','firm_links'] as const;
export async function measureResearchErasure(ctx:RepositoryContext,scope:ResearchErasureScope,affectedFirmIds:readonly string[]):Promise<Record<string,number>>{
 const counts:Record<string,number>={};
 for(const table of [...legacyTables,'firm_office_assessments','firm_office_assessment_sources','sourcing_automatic_research_firms']){
  const rows=await ctx.db.query<{count:string}>(`SELECT count(*) AS count FROM ${table} WHERE workspace_id=$1 AND firm_id=ANY($2::uuid[]) AND ($3::boolean OR $4::boolean)`,[ctx.scope.workspaceId,table==='firm_office_assessment_sources'?affectedFirmIds:[scope.firmId],scope.contactId===null,table==='firm_office_assessment_sources']);
  counts[table]=Number(rows.rows[0]?.count??0);
 }
 return counts;
}
/** Called before route/evidence cascades, under deletion's exclusive dispatch gate. */
export async function eraseOfficeAssessments(ctx:RepositoryContext,scope:ResearchErasureScope,affectedFirmIds:readonly string[]):Promise<Record<string,number>>{
 const children=await ctx.db.query(`DELETE FROM firm_office_assessment_sources WHERE workspace_id=$1 AND firm_id=ANY($2::uuid[])`,[ctx.scope.workspaceId,affectedFirmIds]);
 await ctx.db.query(`UPDATE firm_office_assessments SET result='stale',reason='contact_erased' WHERE workspace_id=$1 AND firm_id=ANY($2::uuid[]) AND result='pending'`,[ctx.scope.workspaceId,affectedFirmIds]);
 const parents=scope.contactId===null?await ctx.db.query(`DELETE FROM firm_office_assessments WHERE workspace_id=$1 AND firm_id=$2`,[ctx.scope.workspaceId,scope.firmId]):null;
 const publications=scope.contactId===null?await ctx.db.query(`DELETE FROM sourcing_automatic_research_firms WHERE workspace_id=$1 AND firm_id=$2`,[ctx.scope.workspaceId,scope.firmId]):null;
 return {firm_office_assessment_sources:children.rowCount??0,firm_office_assessments:parents?.rowCount??0,sourcing_automatic_research_firms:publications?.rowCount??0};
}
export async function sweepOfficeSources(ctx:RepositoryContext,input:{now:string;limit:number}):Promise<number>{
 const result=await ctx.db.query(`DELETE FROM firm_office_assessment_sources s WHERE s.workspace_id=$1 AND (s.assessment_id,s.observation_id) IN (
 SELECT s.assessment_id,s.observation_id FROM firm_office_assessment_sources s JOIN evidence_items e ON e.workspace_id=s.workspace_id AND e.firm_id=s.firm_id AND e.id=s.evidence_id
 WHERE s.workspace_id=$1 AND (s.expires_at<=$2::timestamptz OR e.retention_expires_at<=$2::timestamptz OR (NOT e.terms_allow_retention AND e.retention_expires_at IS NULL)) ORDER BY s.expires_at,s.assessment_id,s.observation_id LIMIT $3)`,[ctx.scope.workspaceId,input.now,input.limit]);
 return result.rowCount??0;
}
