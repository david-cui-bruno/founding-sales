import {beforeEach,expect,it,vi} from 'vitest';
import type {QueryResultRowLike,SessionQueryable} from '@fss/domain/db/queryable.ts';
import type {RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import type {AuthDeps} from '../src/auth/config.ts';
import type {AuthenticatedPrincipal} from '../src/auth/sessions.ts';
import type {RouteDeps} from '../src/routes/routeSupport.ts';
import {payloadHashOf} from '../src/auth/tokens.ts';
import {routeProspectPhoneDiscovery} from '../src/routes/prospectPhoneDiscovery.ts';

const mocks=vi.hoisted(()=>({request:vi.fn(),read:vi.fn(),authenticate:vi.fn()}));
vi.mock('@fss/domain/sourcing/prospectPhoneDiscovery.ts',()=>({requestProspectPhoneDiscovery:mocks.request,readProspectPhoneDiscovery:mocks.read}));
vi.mock('../src/auth/sessions.ts',()=>({authenticate:mocks.authenticate}));
const id='10000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002';
const principal:AuthenticatedPrincipal={workspaceId:id,userId:id,deviceId:id,sessionId:id,role:'admin',membershipStatus:'active',deviceStatus:'active'};
const input={candidateId:id,expectedRevision:2},command={...input,commandId:other,clientVersion:'1.4.0'};
const base='/sourcing/candidates/phone-discovery';
let statements:{sql:string;values:readonly unknown[]}[],receipt:Record<string,unknown>|null,scopeReceipt:Record<string,unknown>|null;
const query=vi.fn(async(sql:string,values:readonly unknown[]=[])=>{
 statements.push({sql,values});
 if(sql.includes('FROM command_receipts r'))return {rows:scopeReceipt?[scopeReceipt]:[],rowCount:scopeReceipt?1:0};
 if(sql.includes('FROM command_receipts'))return {rows:receipt?[receipt]:[],rowCount:receipt?1:0};
 if(sql.includes('FROM devices')||sql.includes('FROM sessions'))return {rows:[{id}],rowCount:1};
 return {rows:[],rowCount:0};
});
const db:SessionQueryable={query:async<Row extends QueryResultRowLike>(sql:string,values?:readonly unknown[])=>{
 const result=await query(sql,values);return {rows:result.rows as Row[],rowCount:result.rowCount};
}};
const unused=()=>{throw Error('No Google/network allowed in adapter tests');};
const auth:AuthDeps={db,now:()=>new Date('2026-10-26T06:00:00Z'),randomSecret:unused,google:{discovery:unused,signingKey:unused,exchangeCode:unused,verifySignature:unused},config:{
 oidc:{issuer:'https://example.test',discoveryUrl:'https://example.test/discovery',clientId:'fixture',clientSecret:'fixture',redirectUri:'https://example.test/callback',hostedDomain:'example.test',clockSkewSeconds:0},
 sessions:{accessSessionSeconds:3600,fullSignInSeconds:3600,authorizationRequestSeconds:600},stateSigningKey:Buffer.alloc(32),supportedClientVersions:{minimum:'1.4.0',ceiling:'1.4.x',incompatible:[]},
}};
const deps=(operation:string,body:unknown,actor=principal,method='POST'):RouteDeps=>({auth,principal:actor,request:{method,path:`${base}/${operation}`,query:new URLSearchParams(),headers:{authorization:'Bearer fixture'},body}});
const authorityWork=async(ctx:RepositoryContext,_input:unknown,authority:()=>Promise<boolean>)=>{
 expect(ctx.db).toBe(db);expect(statements.some(s=>s.sql==='BEGIN')).toBe(true);
 return await authority()?{ok:true,value:{runId:id}}:{ok:false,reason:'authority_changed'};
};
const view={runId:id,candidateId:id,candidateRevision:2,state:'complete',reason:null,requestedAt:'2026-10-26T06:00:00Z',checkedAt:'2026-10-26T06:01:00Z',expiresAt:'2026-11-02T06:00:00Z',method:'company-public-phone-v1',phoneEvidence:{state:'not_extracted',reason:'no_current_permitted_phone_evidence'},website:'https://example.test/',channelAuthority:'not_granted'};
beforeEach(()=>{
 vi.clearAllMocks();statements=[];receipt=null;scopeReceipt=null;
 mocks.authenticate.mockResolvedValue({authenticated:true,principal});
 mocks.request.mockImplementation(authorityWork);
 mocks.read.mockImplementation(async(ctx:RepositoryContext,_input:unknown,authority:()=>Promise<boolean>)=>{
  expect(ctx.db).toBe(db);expect(statements.at(0)?.sql).toBe('BEGIN');
  return await authority()?{ok:true,value:view}:{ok:false,reason:'authority_changed'};
 });
});
it('requests only revision-bound IDs through the actual command runner and authority callback',async()=>{
 expect(await routeProspectPhoneDiscovery(deps('request',command))).toEqual({status:200,body:{status:'accepted',replayed:false,result:{runId:id}}});
 expect(mocks.request).toHaveBeenCalledWith(expect.anything(),input,expect.any(Function));
 const inserted=statements.find(s=>s.sql.includes('INSERT INTO command_receipts'));
 expect(inserted?.values).toEqual([id,id,other,'sourcing.phone_discover',payloadHashOf(input),'accepted',JSON.stringify({runId:id})]);
 expect(statements.at(-1)?.sql).toBe('COMMIT');
});
it.each([{...command,url:'https://arbitrary.test'}, {...command,expectedRevision:0}, {...command,candidateId:'bad'}])('refuses malformed/URL-bearing requests before domain IO: %j',async body=>{
 expect((await routeProspectPhoneDiscovery(deps('request',body))).status).toBe(400);expect(mocks.request).not.toHaveBeenCalled();expect(statements).toEqual([]);
});
it('does not dispatch a request replay or turn an unresolved receipt into a request',async()=>{
 receipt={device_id:id,command_kind:'sourcing.phone_discover',payload_hash:payloadHashOf(input),result_status:'accepted',result:{runId:id}};
 expect((await routeProspectPhoneDiscovery(deps('request',command))).body).toEqual({status:'accepted',replayed:true,result:{runId:id}});
 expect(mocks.request).not.toHaveBeenCalled();
 expect(await routeProspectPhoneDiscovery(deps('receipt',{commandId:other,payloadHash:payloadHashOf(input)}))).toEqual({status:200,body:{state:'unknown'}});
 expect(mocks.request).not.toHaveBeenCalled();
});
it.each(['command_device_mismatch','command_payload_mismatch','command_kind_mismatch'])('preserves %s rather than resubmitting',async reason=>{
 receipt={device_id:reason==='command_device_mismatch'?other:id,command_kind:reason==='command_kind_mismatch'?'other':'sourcing.phone_discover',payload_hash:reason==='command_payload_mismatch'?'f'.repeat(64):payloadHashOf(input),result_status:'accepted',result:{runId:id}};
 expect((await routeProspectPhoneDiscovery(deps('request',command))).body).toMatchObject({status:'refused',reason});expect(mocks.request).not.toHaveBeenCalled();
});
it('reads under a transaction and retained authority without requesting or refreshing',async()=>{
 expect(await routeProspectPhoneDiscovery(deps('read',input))).toEqual({status:200,body:view});
 expect(mocks.read).toHaveBeenCalledWith(expect.anything(),input,expect.any(Function));expect(mocks.request).not.toHaveBeenCalled();expect(statements.at(-1)?.sql).toBe('COMMIT');
 mocks.read.mockResolvedValueOnce({ok:true,value:null});
 expect(await routeProspectPhoneDiscovery(deps('read',input))).toEqual({status:404,body:{error:'not_found'}});
});
it.each(['candidate_changed','source_unavailable','authority_changed'])('refuses current read %s without exposing a stale view',async reason=>{
 mocks.read.mockResolvedValue({ok:false,reason});
 const answer=await routeProspectPhoneDiscovery(deps('read',input));expect(answer.status).not.toBe(200);expect(JSON.stringify(answer)).not.toContain('example.test');expect(mocks.request).not.toHaveBeenCalled();
});
it('scopes receipt lookup to exact action, creator/workspace/device/command/hash and returns only IDs',async()=>{
 scopeReceipt={result_status:'accepted',result:{runId:id}};
 expect(await routeProspectPhoneDiscovery(deps('receipt',{commandId:other,payloadHash:payloadHashOf(input)}))).toEqual({status:200,body:{state:'accepted',result:{runId:id}}});
 const lookup=statements.find(s=>s.sql.includes('FROM command_receipts r'));
 expect(lookup?.values).toEqual([id,other,id,id,'sourcing.phone_discover',payloadHashOf(input)]);
 for(const constraint of ['d.workspace_id=r.workspace_id','d.id=r.device_id','r.workspace_id=$1','r.command_id=$2','r.device_id=$3','d.user_id=$4','r.command_kind=$5','r.payload_hash=$6'])expect(lookup?.sql).toContain(constraint);
 expect(statements.some(s=>s.sql.includes('FOR SHARE'))).toBe(true);expect(mocks.request).not.toHaveBeenCalled();expect(mocks.read).not.toHaveBeenCalled();
});
it.each([{result_status:'refused',result:'private failure text'}, {result_status:'accepted',result:{runId:id,sourceText:'private source'}}, {result_status:'unknown',result:{runId:id}}])('does not disclose receipt prose or malformed historical results: %j',async stored=>{
 scopeReceipt=stored;
 const answer=await routeProspectPhoneDiscovery(deps('receipt',{commandId:other,payloadHash:payloadHashOf(input)}));
 expect(answer).toEqual({status:200,body:{state:stored.result_status==='refused'?'refused':'unknown'}});
});
it.each(['workspaceId','userId','sessionId','deviceId','role'] as const)('withholds a read when authenticated %s changes in flight',async key=>{
 mocks.read.mockImplementation(async()=>{mocks.authenticate.mockResolvedValue({authenticated:true,principal:{...principal,[key]:key==='role'?'salesperson':other}});return {ok:true,value:view};});
 expect(await routeProspectPhoneDiscovery(deps('read',input))).toEqual({status:401,body:{error:'session_changed'}});
});
it('refuses receipt authority loss after the receipt wait',async()=>{
 scopeReceipt={result_status:'accepted',result:{runId:id}};
 mocks.authenticate.mockResolvedValue({authenticated:false,refusal:'session_ended'});
 expect(await routeProspectPhoneDiscovery(deps('receipt',{commandId:other,payloadHash:payloadHashOf(input)}))).toEqual({status:401,body:{error:'session_changed'}});
});
it('keeps the adapter closed to paths, methods, roles and malformed receipt/read bodies',async()=>{
 expect((await routeProspectPhoneDiscovery(deps('other',input))).status).toBe(404);
 expect((await routeProspectPhoneDiscovery(deps('request',command,principal,'GET'))).status).toBe(405);
 expect((await routeProspectPhoneDiscovery(deps('read',input,{...principal,role:'salesperson'}))).status).toBe(403);
 expect((await routeProspectPhoneDiscovery(deps('read',{candidateId:id}))).status).toBe(400);
 expect((await routeProspectPhoneDiscovery(deps('receipt',{commandId:other,payloadHash:'bad'}))).status).toBe(400);
 expect(mocks.request).not.toHaveBeenCalled();expect(mocks.read).not.toHaveBeenCalled();expect(statements).toEqual([]);
});
