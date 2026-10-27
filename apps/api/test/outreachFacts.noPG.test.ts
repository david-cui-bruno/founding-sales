import {beforeEach,expect,it,vi} from 'vitest';
import type {QueryResultRowLike,SessionQueryable} from '@fss/domain/db/queryable.ts';
import type {AuthDeps} from '../src/auth/config.ts';
import {authenticate,type AuthenticatedPrincipal} from '../src/auth/sessions.ts';
import type * as Sessions from '../src/auth/sessions.ts';
import {routeOutreachFacts} from '../src/routes/outreachFacts.ts';
vi.mock('../src/auth/sessions.ts',async original=>({...await original<typeof Sessions>(),authenticate:vi.fn()}));
const id='10000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002';
const principal:AuthenticatedPrincipal={workspaceId:id,userId:id,deviceId:id,sessionId:id,role:'admin',membershipStatus:'active',deviceStatus:'active'};
let current:AuthenticatedPrincipal|null;
beforeEach(()=>{current=principal;vi.mocked(authenticate).mockImplementation(async()=>current?{authenticated:true,principal:current}:{authenticated:false,refusal:'session_ended'});});
function setup(){
 const statements:{sql:string;values:readonly unknown[]|undefined}[]=[];
 let wait:(sql:string)=>void=()=>{},replay=false;
 const db:SessionQueryable={async query<R extends QueryResultRowLike>(sql:string,values?:readonly unknown[]){
  statements.push({sql,values});wait(sql);let rows:unknown[]=[];
  if(sql.includes('FROM workspace_memberships')||sql.includes('FROM devices')||sql.includes('FROM sessions'))rows=[{id}];
  else if(sql.includes('FROM command_receipts'))rows=replay?[{device_id:id,command_kind:'outreach_answer_save',payload_hash:'ignored',result_status:'accepted',result:{id,version:1}}]:[];
  else if(sql.includes('RETURNING id'))rows=[{id}];
  else if(sql.includes('SELECT current_version'))rows=[{current_version:1}];
  else if(sql.includes('SELECT v.*'))rows=[{block_id:id,current_version:1,version:1,kind:'product',text:'Public safe fact.',approved_at:null,retired_at:null,social_input:{topic:'build',status:'planned',sanitized:true}}];
  return {rows:rows as R[],rowCount:rows.length};
 }};
 const unavailable=async():Promise<never>=>{throw Error('No provider access in query-port test');};
 const auth:AuthDeps={db,now:()=>new Date('2026-10-27T00:00:00Z'),randomSecret:()=>{throw Error('Unused secret port');},google:{discovery:unavailable,signingKey:unavailable,exchangeCode:unavailable,verifySignature:()=>false},config:{supportedClientVersions:{minimum:'1.0.0',ceiling:'1.x',incompatible:[]},sessions:{accessSessionSeconds:3600,fullSignInSeconds:86400,authorizationRequestSeconds:300},stateSigningKey:Buffer.alloc(32),oidc:{issuer:'https://fixture.invalid',discoveryUrl:'https://fixture.invalid/discovery',clientId:'fixture',clientSecret:'fixture-only',redirectUri:'https://fixture.invalid/callback',hostedDomain:'fixture.invalid',clockSkewSeconds:0}}};
 const call=(action:string,body:unknown=action==='save'?{kind:'product',text:'Public safe fact.',socialInput:{topic:'build',status:'planned',sanitized:true},commandId:id,clientVersion:'1.4.0'}:action===''?{}:{id,version:1,commandId:id,clientVersion:'1.4.0'})=>routeOutreachFacts({auth,principal,request:{method:'POST',path:`/outreach/answer-blocks${action?`/${action}`:''}`,query:new URLSearchParams(),headers:{authorization:'Bearer test-only'},body}});
 return {call,statements,wait:(hook:typeof wait)=>{wait=hook;},replay:()=>{replay=true;}};
}
it('same API schemas save sanitized draft without approval, returns IDs only with final membership/principal fence',async()=>{
 const s=setup();expect(await s.call('save')).toEqual({status:200,body:{status:'accepted',replayed:false,result:{id,version:1}}});expect(s.statements.some(s=>s.sql.includes('SET approved_at'))).toBe(false);expect(s.statements.at(-1)?.sql).toBe('COMMIT');const receipt=s.statements.find(s=>s.sql.includes('INSERT INTO command_receipts'));expect(receipt?.values?.[3]).toBe('outreach_answer_save');expect(receipt?.values?.[6]).toBe(JSON.stringify({id,version:1}));
});
it.each(['save','approve','retire'])('%s invalidated after receipt insert rolls back both write and receipt in runner transaction',async action=>{
 const s=setup();s.wait(sql=>{if(sql.includes('INSERT INTO command_receipts'))current=null;});expect((await s.call(action)).status).toBe(401);expect(s.statements.at(-1)?.sql).toBe('ROLLBACK');expect(s.statements.some(s=>s.sql==='COMMIT')).toBe(false);
});
it.each(['role','session','device','workspace','user','revoked'] as const)('read %s changes after content wait are withheld and rollback',async change=>{
 const s=setup();s.wait(sql=>{if(sql.includes('SELECT v.*'))current=change==='revoked'?null:{...principal,...(change==='role'?{role:'salesperson' as const}:{[`${change}Id`]:other})};});expect((await s.call('')).status).toBe(401);expect(s.statements.at(-1)?.sql).toBe('ROLLBACK');
});
it('read reauthenticates again after COMMIT, without projecting late private content',async()=>{
 const s=setup();s.wait(sql=>{if(sql==='COMMIT')current=null;});expect((await s.call('')).status).toBe(401);expect(s.statements.at(-1)?.sql).toBe('COMMIT');
});
it('receipt replay wait still gets a final exact-principal check',async()=>{
 const s=setup();s.replay();s.wait(sql=>{if(sql.includes('FROM command_receipts'))current={...principal,sessionId:other};});expect((await s.call('save')).status).toBe(401);expect(s.statements.some(s=>s.sql==='BEGIN')).toBe(false);
});
it('strict existing schemas refuse extra actions without writing',async()=>{
 const s=setup();expect((await s.call('save',{kind:'product',text:'Text',autoApprove:true,commandId:id,clientVersion:'1.4.0'})).status).toBe(400);expect(s.statements).toEqual([]);
});
