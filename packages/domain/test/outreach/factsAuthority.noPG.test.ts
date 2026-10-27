import {expect,it,vi} from 'vitest';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import type {Queryable,QueryResultRowLike} from '../../db/queryable.ts';
import {saveAnswerBlock,approveAnswerBlock,retireAnswerBlock} from '../../outreach/facts.ts';
const id='10000000-0000-4000-8000-000000000001';
function setup(){
 const calls:string[]=[];let stopAt:string|null=null,revoked=false;
 const db:Queryable={async query<R extends QueryResultRowLike>(text:string){
  calls.push(text);if(stopAt&&text.includes(stopAt))revoked=true;
  const rows:unknown[]=text.includes('SELECT current_version')?[{current_version:1}]:text.includes('RETURNING id')?[{id}]:text.includes('SELECT v.*')?[{block_id:id,version:1,current_version:1,kind:'product',text:'Public-safe fact.',approved_at:null,retired_at:null,social_input:{topic:'build',status:'planned',sanitized:true}}]:[];
  return {rows:rows as R[],rowCount:rows.length};
 }};
 const authority=vi.fn(async()=>{if(revoked)throw Error('authority_changed');});
 const ctx=repositoryContext(workspaceScope(id,{kind:'user',userId:id,role:'admin'}),db);
 return {ctx,calls,authority,stop:(text:string)=>{stopAt=text;}};
}
it('save checks retained principal after send gate before any write and after parent wait before version update',async()=>{
 for(const wait of ['pg_advisory_xact_lock','SELECT current_version']){
  const s=setup();s.stop(wait);
  await expect(saveAnswerBlock(s.ctx,{id,expectedVersion:1,kind:'product',text:'Public-safe fact.'},s.authority)).rejects.toThrow('authority_changed');
  expect(s.calls.some(c=>/^(UPDATE|INSERT)/u.test(c))).toBe(false);
 }
});
it.each([approveAnswerBlock,retireAnswerBlock])('approval lifecycle checks principal after lock/read waits before writing',async command=>{
 const s=setup();s.stop('SELECT v.*');await expect(command(s.ctx,{id,version:1},s.authority)).rejects.toThrow('authority_changed');expect(s.calls.some(c=>/^(UPDATE|INSERT)/u.test(c))).toBe(false);
});
it.each(['save','approve','retire'] as const)('%s final projection fence runs after audit waits',async action=>{
 const s=setup();s.stop('INSERT INTO audit_events');const call=action==='save'?saveAnswerBlock(s.ctx,{kind:'product',text:'Public-safe fact.'},s.authority):(action==='approve'?approveAnswerBlock:retireAnswerBlock)(s.ctx,{id,version:1},s.authority);
 await expect(call).rejects.toThrow('authority_changed');expect(s.calls.at(-1)).toContain('SELECT v.*');
});
it('save keeps trimmed sanitized input unapproved and never invokes approval SQL',async()=>{
 const s=setup(),result=await saveAnswerBlock(s.ctx,{kind:'product',text:'  Public-safe fact.  ',socialInput:{topic:'build',status:'planned',sanitized:true}},s.authority);
 expect(result).toMatchObject({ok:true,value:{id,version:1,approvedAt:null,socialInput:{sanitized:true}}});expect(s.authority).toHaveBeenCalledTimes(2);expect(s.calls.some(c=>c.includes('SET approved_at'))).toBe(false);
});
it('non-admin refuses before any query or callback',async()=>{
 const s=setup(),ctx=repositoryContext(workspaceScope(id,{kind:'user',userId:id,role:'salesperson'}),s.ctx.db);expect(await saveAnswerBlock(ctx,{kind:'product',text:'Fact.'},s.authority)).toEqual({ok:false,reason:'admin_required'});expect(s.calls).toEqual([]);expect(s.authority).not.toHaveBeenCalled();
});
