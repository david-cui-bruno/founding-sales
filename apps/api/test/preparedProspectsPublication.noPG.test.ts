import {beforeEach,expect,it,vi} from 'vitest';
import {preparedProspectBriefSchema} from '@fss/contracts';
import type {SessionQueryable,QueryResultRowLike} from '@fss/domain/db/queryable.ts';
import type {AuthDeps} from '../src/auth/config.ts';
import type {AuthenticatedPrincipal} from '../src/auth/sessions.ts';
import type {RouteDeps} from '../src/routes/routeSupport.ts';
import {routePreparedProspects} from '../src/routes/preparedProspects.ts';
import {formatAccessToken} from '../src/auth/tokens.ts';
const mocks=vi.hoisted(()=>({read:vi.fn(),list:vi.fn(),authenticate:vi.fn()}));
vi.mock('@fss/domain/sourcing/preparedProspects.ts',()=>({listPreparedProspects:mocks.list,readPreparedProspect:mocks.read}));
vi.mock('../src/auth/sessions.ts',()=>({authenticate:mocks.authenticate}));
const id='10000000-0000-4000-8000-000000000001',run='10000000-0000-4000-8000-000000000002';
const principal:AuthenticatedPrincipal={workspaceId:id,userId:id,deviceId:id,sessionId:id,role:'admin',membershipStatus:'active',deviceStatus:'active'};
let clock:number,started:number,statements:string[],pause:'none'|'commit'|'final_auth'|'principal',authQueries:number;
const db:SessionQueryable={query:async<Row extends QueryResultRowLike>(sql:string)=>{
 statements.push(sql);
 if(sql.includes('FROM devices')){authQueries++;if(pause==='final_auth'&&authQueries===2)clock+=10000;}
 if(sql==='COMMIT'&&pause!=='none'&&pause!=='final_auth')clock+=pause==='principal'?70000:10000;
 const rows:QueryResultRowLike[]=sql.includes('SELECT clock_timestamp()')?[{at:new Date(clock)}]:sql.includes('expires_at,reauthenticate_after')?[{expires_at:new Date(started+60000),reauthenticate_after:new Date(started+120000)}]:sql.includes('FROM devices')||sql.includes('FROM sessions')?[{id}]:[];
 return {rows:rows as Row[],rowCount:rows.length};
}};
function brief(){return preparedProspectBriefSchema.parse({target:{candidateId:id,candidateRevision:1,runId:run},displayName:'Fictional Cedar',discoveryLabel:'Cedar search label',website:'https://fixture.example.test/',targetingLocality:'Boston',targetingRegion:'MA',state:'prepared',summary:'Dated residential-management research.',unknowns:['Email unknown'],validUntil:new Date(started+5000).toISOString(),policyVersion:'prepared-prospect-v1',checkedAt:new Date(started).toISOString(),passages:[{kind:'business',observationId:id,blockId:'business',url:'https://fixture.example.test/',retrievedAt:new Date(started-1000).toISOString(),quote:'Fictional retained private business context'}],coverage:'complete_retained_pages',nextAction:'Research the appropriate Person.',contactAuthority:'not_granted'});}
function deps(kind:'list'|'read'):RouteDeps{
 return {principal,auth:{db,now:()=>new Date(clock)} as AuthDeps,request:{method:'POST',path:`/sourcing/prepared-prospects/${kind}`,query:new URLSearchParams(),headers:{authorization:`Bearer ${formatAccessToken(id,'t'.repeat(43))}`},body:kind==='list'?{offset:0}:brief().target}};
}
beforeEach(()=>{
 vi.clearAllMocks();clock=Date.now();started=clock;statements=[];pause='none';authQueries=0;mocks.authenticate.mockResolvedValue({authenticated:true,principal});
 mocks.read.mockImplementation(async(_ctx:unknown,_input:unknown,authority:()=>Promise<boolean>)=>await authority()?{ok:true,value:brief()}:{ok:false,reason:'authority_changed'});
 mocks.list.mockImplementation(async(_ctx:unknown,_input:unknown,authority:()=>Promise<boolean>)=>await authority()?{ok:true,value:{prospects:[brief()],hasMore:false,viewRevision:'a'.repeat(64),checkedAt:new Date(started).toISOString()}}:{ok:false,reason:'authority_changed'});
});
it.each(['read','list'] as const)('returns %s without commands or any asynchronous query after COMMIT',async kind=>{
 expect(await routePreparedProspects(deps(kind))).toMatchObject({status:200});expect(statements.at(-1)).toBe('COMMIT');
 expect(statements.join(' ')).not.toMatch(/INSERT|UPDATE|DELETE|command_receipts|provider_reservations/u);expect(authQueries).toBe(2);
});
it.each([['read','commit'],['read','final_auth'],['list','commit'],['list','final_auth']] as const)('withholds %s original context when source expiry crosses %s',async(kind,mode)=>{
 pause=mode;const answer=await routePreparedProspects(deps(kind));
 expect(answer).toEqual({status:409,body:{error:'source_expired'}});expect(JSON.stringify(answer)).not.toContain('Fictional retained private');expect(statements.at(-1)).toBe('COMMIT');
});
it('refuses a principal deadline crossing COMMIT with no late authentication query',async()=>{
 pause='principal';expect(await routePreparedProspects(deps('read'))).toEqual({status:401,body:{error:'unauthenticated'}});expect(statements.at(-1)).toBe('COMMIT');
});
