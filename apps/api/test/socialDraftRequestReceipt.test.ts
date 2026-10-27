import {beforeEach,expect,it,vi} from 'vitest';
import type {SessionQueryable,QueryResultRowLike} from '@fss/domain/db/queryable.ts';
import type {AuthDeps} from '../src/auth/config.ts';
import {authenticate,type AuthenticatedPrincipal} from '../src/auth/sessions.ts';
import type * as Sessions from '../src/auth/sessions.ts';
import {socialDraftRequestReceipt} from '../src/routes/socialDraftRequestReceipt.ts';
vi.mock('../src/auth/sessions.ts',async original=>({...await original<typeof Sessions>(),authenticate:vi.fn()}));
const id='10000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002',hash='a'.repeat(64);
const principal:AuthenticatedPrincipal={workspaceId:id,userId:id,deviceId:id,sessionId:id,role:'admin',membershipStatus:'active',deviceStatus:'active'};
let current:AuthenticatedPrincipal|null;
beforeEach(()=>{current={...principal};vi.mocked(authenticate).mockImplementation(async()=>current?{authenticated:true,principal:current}:{authenticated:false,refusal:'session_ended'});});
function setup(){
 let result_status='accepted',result:unknown={requestId:id},wait:()=>Promise<void>=async()=>{},expected:unknown[]=[id,id,id,id,'social_drafts_request',hash];
 const statements:{sql:string;values:readonly unknown[]|undefined}[]=[];
 const db:SessionQueryable={query:async<Row extends QueryResultRowLike>(sql:string,values?:readonly unknown[])=>{
  statements.push({sql,values});let rows:unknown[]=[];
  if(sql.includes('FROM devices')||sql.includes('FROM sessions'))rows=[{id}];
  if(sql.includes('FROM command_receipts')){await wait();rows=JSON.stringify(values)===JSON.stringify(expected)?[{result_status,result}]:[];}
  return {rows:rows as Row[],rowCount:rows.length};
 }};
 // Identity authentication is explicitly mocked. No OIDC/network/database setup.
 const auth={db} as AuthDeps;
 const call=(body:unknown={commandId:id,payloadSHA256:hash},p=principal)=>socialDraftRequestReceipt({auth,principal:p,request:{method:'POST',path:'/social/drafts/request/receipt',query:new URLSearchParams(),headers:{},body}});
 return {call,statements,expected:(value:unknown[])=>{expected=value;},result:(status:string,value:unknown)=>{result_status=status;result=value;},wait:(hook:()=>Promise<void>)=>{wait=hook;}};
}
it('receipt binds exact workspace/user/device/kind/hash and returns only historical request ID',async()=>{
 const s=setup();expect(await s.call()).toEqual({status:200,body:{state:'accepted',result:{requestId:id}}});
 const query=s.statements.find(value=>value.sql.includes('FROM command_receipts'))!;expect(query.values).toEqual([id,id,id,id,'social_drafts_request',hash]);
 expect(query.sql).toContain('d.workspace_id=r.workspace_id');expect(query.sql).toContain('d.user_id=$4');expect(s.statements.at(-1)?.sql).toBe('COMMIT');expect(s.statements.every(value=>!/^INSERT|^UPDATE|^DELETE/u.test(value.sql))).toBe(true);
});
it.each(['workspace','command','device','user','kind','hash'] as const)('%s collision projects UNKNOWN without leaking result',async field=>{
 const s=setup(),expected=[id,id,id,id,'social_drafts_request',hash];expected[['workspace','command','device','user','kind','hash'].indexOf(field)]=other;s.expected(expected);
 expect(await s.call()).toEqual({status:200,body:{state:'unknown'}});
});
it('finite stored refusal and missing receipt have no suggestion/source/guide prose',async()=>{
 const s=setup();s.result('refused','voice_guide_changed_or_unavailable');expect(await s.call()).toEqual({status:200,body:{state:'refused',reason:'voice_guide_changed_or_unavailable'}});
 expect(await s.call({commandId:other,payloadSHA256:hash})).toEqual({status:200,body:{state:'unknown'}});
 for(const body of [{commandId:id,payloadSHA256:hash,text:'not admitted'},{commandId:id,payloadSHA256:'bad'},{}])expect((await s.call(body)).status).toBe(400);
});
it.each(['session','device','user','workspace','role','revoked'] as const)('current %s changed across receipt wait refuses and rolls back without projection',async change=>{
 const s=setup();s.wait(async()=>{current=change==='revoked'?null:{...principal,...(change==='role'?{role:'salesperson' as const}:{[`${change}Id`]:other})};});
 expect((await s.call()).status).toBe(401);expect(s.statements.at(-1)?.sql).toBe('ROLLBACK');
});
it('revalidates original principal again after transaction commit before response',async()=>{
 const s=setup();let checks=0;vi.mocked(authenticate).mockImplementation(async()=>++checks<3?{authenticated:true,principal}:{authenticated:false,refusal:'session_ended'});
 expect((await s.call()).status).toBe(401);expect(s.statements.at(-1)?.sql).toBe('COMMIT');
});
it('extra accepted private fields are rejected by strict receipt projection',async()=>{const s=setup();s.result('accepted',{requestId:id,text:'must not escape'});await expect(s.call()).rejects.toThrow();expect(s.statements.at(-1)?.sql).toBe('ROLLBACK');});
