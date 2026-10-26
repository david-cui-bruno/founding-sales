import {expect,it,vi} from 'vitest';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import type {Queryable,QueryResultRowLike} from '../../db/queryable.ts';
import {readCallingExecutionReceipt} from '../../calls/executionReceipt.ts';
import {CallingAuthorityChanged} from '../../calling/followUpDraftAccess.ts';
const id='00000000-0000-4000-8000-000000000001',sessionId='00000000-0000-4000-8000-000000000002',expiresAt='2026-10-26T10:00:00.000Z';
const input={firmId:id,commandId:id,payloadSHA256:'a'.repeat(64)};
function setup(){
 const trace:{sql:string;values:readonly unknown[]|undefined}[]=[];
 const state={receipt:true,result_status:'accepted',result:{sessionId,expiresAt},firm:true,assigned:id,session:true,status:'authorized',consumed:false,afterExpiry:true};
 const db:Queryable={async query<Row extends QueryResultRowLike>(sql:string,values?:readonly unknown[]){trace.push({sql,values});let rows:unknown[]=[];
  if(sql.includes('FROM command_receipts'))rows=state.receipt?[{result_status:state.result_status,result:state.result}]:[];
  else if(sql.includes('FROM firms'))rows=state.firm?[{assigned_user_id:state.assigned,status:'active'}]:[];
  else if(sql.includes('FROM call_sessions'))rows=state.session?[{id:sessionId,status:state.status,expires_at:new Date(expiresAt),consumed_at:state.consumed?new Date(expiresAt):null}]:[];
  else if(sql.includes('clock_timestamp'))rows=[{at:new Date(state.afterExpiry?'2026-10-26T10:01:00.000Z':'2026-10-26T09:59:00.000Z')}];
  else if(sql.includes('workspace_memberships'))rows=[{role:'admin',status:'active',user_id:id}];
  return {rows:rows as Row[],rowCount:rows.length};
 }};
 const ctx=repositoryContext(workspaceScope(id,{kind:'user',userId:id,role:'admin'}),db),authority=vi.fn(async()=>true);
 return {trace,state,ctx,authority};
}
it('only locked expired unconsumed session is final, scoped to exact original receipt/device/kind/hash',async()=>{
 const f=setup();expect(await readCallingExecutionReceipt(f.ctx,input,id,f.authority)).toEqual({state:'accepted',firmId:id,sessionId,expiresAt,status:'expired_unconsumed',canReconnect:false});
 const receipt=f.trace[0]!;expect(receipt.sql).toContain("r.command_kind='create_call_session'");expect(receipt.values).toEqual([id,id,id,id,input.payloadSHA256]);
 expect(f.trace.find(t=>t.sql.includes('FROM firms'))?.sql).toContain('FOR SHARE');const session=f.trace.findIndex(t=>t.sql.includes('FROM call_sessions')),clock=f.trace.findIndex(t=>t.sql.includes('clock_timestamp'));expect(clock).toBeGreaterThan(session);expect(f.trace[session]?.sql).toContain('FOR UPDATE OF s');expect(f.trace[session]?.sql).toContain('t.command_id=$6');expect(f.authority).toHaveBeenCalledTimes(1);
});
it.each(['authorized','ringing','in_progress'])('consumed %s is never terminalized by expiry or cost settlement',async status=>{const f=setup();f.state.consumed=true;f.state.status=status;expect(await readCallingExecutionReceipt(f.ctx,input,id,f.authority)).toMatchObject({state:'accepted',status});expect(f.trace.some(t=>/provider_reservations|UPDATE|INSERT/u.test(t.sql)&&!t.sql.includes('FOR UPDATE'))).toBe(false);});
it.each(['completed','failed','canceled'])('returns authoritative consumed terminal %s without reconnect permission',async status=>{const f=setup();f.state.consumed=true;f.state.status=status;expect(await readCallingExecutionReceipt(f.ctx,input,id,f.authority)).toMatchObject({state:'accepted',status,canReconnect:false});});
it.each(['receipt','firm','session','assignment'])('missing or changed %s preserves uncertainty',async kind=>{const f=setup();if(kind==='assignment')f.state.assigned=sessionId;else if(kind==='receipt')f.state.receipt=false;else if(kind==='firm')f.state.firm=false;else f.state.session=false;expect(await readCallingExecutionReceipt(f.ctx,input,id,f.authority)).toEqual({state:'unknown'});expect(f.authority).toHaveBeenCalled();});
it('does not infer expiry from client time and fences a final revoked principal',async()=>{const f=setup();f.state.afterExpiry=false;expect(await readCallingExecutionReceipt(f.ctx,input,id,f.authority)).toMatchObject({state:'accepted',status:'authorized'});f.authority.mockResolvedValueOnce(false);await expect(readCallingExecutionReceipt(f.ctx,input,id,f.authority)).rejects.toBeInstanceOf(CallingAuthorityChanged);});
it('opaque refusal has no reason, token or private original payload',async()=>{const f=setup();f.state.result_status='refused';expect(await readCallingExecutionReceipt(f.ctx,input,id,f.authority)).toEqual({state:'refused'});expect(f.trace.some(t=>t.sql.includes('FROM call_sessions'))).toBe(false);});
