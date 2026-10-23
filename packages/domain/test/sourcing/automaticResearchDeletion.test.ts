import {expect,it} from 'vitest';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {measureResearchErasure,eraseOfficeAssessments} from '../../retention/officeAssessments.ts';
import {SOURCING_RETENTION_COVERAGE} from '../../retention/sourcingCoverage.ts';
const workspace='00000000-0000-4000-8000-000000000001',firmId='00000000-0000-4000-8000-000000000002';
it.each([null,'00000000-0000-4000-8000-000000000003'])('ordinary deletion preview and commit remove publication only for full Firm scope contact=%s',async contactId=>{
 const queries:{sql:string;args:readonly unknown[]}[]=[];
 const ctx=repositoryContext(workspaceScope(workspace,{kind:'user',userId:workspace,role:'admin'}),{query:async<Row,>(sql:string,args:readonly unknown[]=[])=>{
  queries.push({sql,args});const rows=sql.startsWith('SELECT count(*)')?[{count:args[2]||args[3]?'1':'0'}]:[];
  return {rows:rows as Row[],rowCount:1};
 }});
 const scope={firmId,contactId};
 const preview=await measureResearchErasure(ctx,scope,[firmId]);
 expect(preview['sourcing_automatic_research_firms']).toBe(contactId===null?1:0);
 const result=await eraseOfficeAssessments(ctx,scope,[firmId]);
 expect(result['sourcing_automatic_research_firms']).toBe(contactId===null?1:0);
 const removals=queries.filter(q=>q.sql.startsWith('DELETE FROM sourcing_automatic_research_firms'));
 expect(removals).toHaveLength(contactId===null?1:0);
 if(contactId===null)expect(removals[0]!.args).toEqual([workspace,firmId]);
 expect(queries.some(q=>q.sql.startsWith('DELETE FROM sourcing_candidates')||q.sql.startsWith('DELETE FROM firms'))).toBe(false);
 expect(SOURCING_RETENTION_COVERAGE['sourcing_automatic_research_firms']?.dispositions).toEqual(['deletion_removes']);
});
