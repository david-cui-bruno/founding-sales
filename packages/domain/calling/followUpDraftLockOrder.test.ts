import {beforeEach,expect,it,vi} from 'vitest';
import {repositoryContext,workspaceScope} from '../db/workspaceScope.ts';
import type {Queryable,QueryResultRowLike} from '../db/queryable.ts';
import {readCallingDraft,saveCallingDraft} from './followUpDrafts.ts';
import type * as DraftAccess from './followUpDraftAccess.ts';
const trace=vi.hoisted(()=>[] as string[]);
vi.mock('./followUpDraftAccess.ts',async original=>{
 const actual=await original<typeof DraftAccess>();
 return {...actual,lockCallingSource:async()=>{trace.push('source locks');},currentCallingSource:async(ctx:Parameters<typeof actual.currentCallingSource>[0],_source:unknown,authority:()=>Promise<boolean>)=>{await actual.requireCallingAuthority(ctx,authority);trace.push('final source check');}};
});
const id='00000000-0000-4000-8000-000000000001';
const row={id,creator_user_id:id,revision:1,source_kind:'firm',candidate_id:null,candidate_revision:null,attempt_id:null,firm_id:id,call_log_id:id,content:{subject:'Synthetic independent subject',body:'Synthetic independent body'},reason:null,created_at:new Date('2026-10-26T00:00:00Z'),updated_at:new Date('2026-10-26T00:00:00Z')};
const db:Queryable={async query<Row extends QueryResultRowLike>(text:string){trace.push(text);const rows:QueryResultRowLike[]=text.includes('FROM calling_follow_up_drafts')?[row]:text.startsWith('UPDATE calling_follow_up_drafts')?[{id,revision:2}]:text.startsWith('SELECT role,status')?[{role:'admin',status:'active'}]:[{user_id:id}];return {rows:rows as Row[],rowCount:rows.length};}};
const ctx=repositoryContext(workspaceScope(id,{kind:'user',userId:id,role:'admin'}),db);
beforeEach(()=>{trace.length=0;});
it.each(['read','update'] as const)('%s takes source then membership then draft, with final checks retained',async operation=>{
 const input={draftId:id,expectedRevision:1};if(operation==='read')await readCallingDraft(ctx,input,async()=>true);else await saveCallingDraft(ctx,{operation:'update',...input,subject:'Edited independently',body:'Edited independent body'},async()=>true);
 const source=trace.indexOf('source locks'),member=trace.findIndex(s=>s.startsWith('SELECT user_id FROM workspace_memberships')),draft=trace.findIndex(s=>s.includes('FROM calling_follow_up_drafts')&&s.endsWith('FOR UPDATE'));
 expect(source).toBeGreaterThanOrEqual(0);expect(source).toBeLessThan(member);expect(member).toBeLessThan(draft);expect(trace.lastIndexOf('final source check')).toBeGreaterThan(draft);
});
