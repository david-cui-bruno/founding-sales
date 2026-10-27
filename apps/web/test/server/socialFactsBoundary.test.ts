import {randomBytes} from 'node:crypto';
import {beforeEach,expect,it,vi} from 'vitest';
import type {AuthDeps} from '../../../api/src/auth/config.ts';
import type {ApiOptions,ApiRequest} from '../../../api/src/server.ts';
import {createBrowserHandler} from '../../src/server/browser.ts';
import {COOKIE_NAMES,sealCookie} from '../../src/server/cookies.ts';
import {browserApiPathAllowed} from '../../src/shared/browserContract.ts';
import {socialFactsBrowserResult} from '../../src/server/socialFactsBoundary.ts';
const mocks=vi.hoisted(()=>({authenticate:vi.fn(),route:vi.fn()}));
vi.mock('../../../api/src/auth/signIn.ts',()=>({startSignIn:vi.fn(),handleCallback:vi.fn(),claimSignIn:vi.fn()}));
vi.mock('../../../api/src/auth/sessions.ts',()=>({authenticate:mocks.authenticate,endSession:vi.fn()}));
vi.mock('../../../api/src/server.ts',()=>({route:mocks.route}));
const id='10000000-0000-4000-8000-000000000001',origin='https://localhost:8443',expiresAt='2026-10-27T07:00:00Z',csrf='c'.repeat(43),token='fixture-only-'.repeat(4),key=randomBytes(32);
const principal={workspaceId:id,userId:id,deviceId:id,sessionId:id,role:'admin',membershipStatus:'active',deviceStatus:'active'};
const auth={now:()=>new Date('2026-10-27T06:00:00Z'),config:{oidc:{redirectUri:`${origin}/browser/callback`}}} as AuthDeps;
const handler=createBrowserHandler({origin,cookieKey:key,clientVersion:'1.4.0',withRequest:async work=>work({auth,api:{} as ApiOptions})});
const cookie=`${COOKIE_NAMES.access}=${sealCookie(key,origin,COOKIE_NAMES.access,{kind:'access',token,csrf,expiresAt})}`;
const accepted={status:'accepted',replayed:false,result:{id,version:2}};
async function post(path:string,body:unknown){
 const session=await handler({method:'GET',path:'/browser/session',query:new URLSearchParams(),headers:{cookie},body:undefined});
 const revision=(session?.body as {revision:string}).revision;
 const request:ApiRequest={method:'POST',path:`/browser/api${path}`,query:new URLSearchParams(),headers:{cookie,origin,'content-type':'application/json','x-callie-csrf':csrf,'x-callie-session':revision},body};return handler(request);
}
beforeEach(()=>{vi.clearAllMocks();mocks.authenticate.mockResolvedValue({authenticated:true,principal});mocks.route.mockResolvedValue({status:200,body:accepted});});
it('admits only exact existing POST fact paths, no prefixes, settings, authorization or cohort',()=>{
 for(const path of ['/outreach/answer-blocks','/outreach/answer-blocks/save','/outreach/answer-blocks/approve','/outreach/answer-blocks/retire']){expect(browserApiPathAllowed('POST',path)).toBe(true);expect(browserApiPathAllowed('GET',path)).toBe(false);}
 for(const path of ['/outreach/settings/save','/outreach/cohort/enable','/outreach/authorization/save','/outreach/answer-blocks/receipt','/outreach/answer-blocks/save/extra','/outreach/answer-blocks/../settings/save'])expect(browserApiPathAllowed('POST',path)).toBe(false);
});
it.each(['save','approve','retire'])('%s uses existing strict schema, pins trusted version and returns only identifiers',async action=>{
 const payload=action==='save'?{kind:'product',text:'Public-safe planned work.',socialInput:{topic:'build',status:'planned',sanitized:true},commandId:id}:{id,version:2,commandId:id};
 const result=await post(`/outreach/answer-blocks/${action}`,payload);expect(result).toMatchObject({status:200,body:accepted});expect(mocks.route.mock.calls[0]?.[3]).toMatchObject({body:{...payload,clientVersion:'1.4.0'},headers:{authorization:`Bearer ${token}`}});
 for(const extra of [{clientVersion:'9.9.9'},{autoApprove:true},{enabled:true},{recipient:'not-admitted'}])expect((await post(`/outreach/answer-blocks/${action}`,{...payload,...extra}))?.status).toBe(400);
 expect(mocks.route).toHaveBeenCalledTimes(1);
});
it('save preserves existing ID/expectedVersion refinement and strict paged reads',async()=>{
 const bad={id,kind:'product',text:'Text.',commandId:id};expect((await post('/outreach/answer-blocks/save',bad))?.status).toBe(400);
 mocks.route.mockResolvedValue({status:200,body:{blocks:[]}});expect((await post('/outreach/answer-blocks',{afterId:id}))?.body).toEqual({blocks:[]});expect(mocks.route.mock.calls[0]?.[3]).toMatchObject({body:{afterId:id}});
 expect((await post('/outreach/answer-blocks',{afterId:id,clientVersion:'1.4.0'}))?.status).toBe(400);
});
it('non-admin never dispatches and changed principal after API wait never projects facts',async()=>{
 mocks.authenticate.mockResolvedValue({authenticated:true,principal:{...principal,role:'salesperson'}});expect((await post('/outreach/answer-blocks',{}))?.status).toBe(403);expect(mocks.route).not.toHaveBeenCalled();
 mocks.authenticate.mockResolvedValue({authenticated:true,principal});mocks.route.mockImplementation(async()=>{mocks.authenticate.mockResolvedValue({authenticated:true,principal:{...principal,sessionId:'replacement'}});return {status:200,body:{blocks:[]}};});expect((await post('/outreach/answer-blocks',{}))?.status).toBe(401);
});
it('finite business refusal only is normalized, auth/collision/unknown failures preserve opaque custody',async()=>{
 for(const reason of ['invalid_input','not_found','stale_version','block_retired']){mocks.route.mockResolvedValue({status:409,body:{status:'refused',replayed:false,reason}});expect((await post('/outreach/answer-blocks/approve',{id,version:2,commandId:id}))?.status).toBe(200);}
 for(const reason of ['admin_required','session_changed','command_device_mismatch','command_payload_mismatch','command_kind_mismatch','unknown']){mocks.route.mockResolvedValue({status:409,body:{status:'refused',replayed:false,reason}});expect(await post('/outreach/answer-blocks/approve',{id,version:2,commandId:id})).toMatchObject({status:409,body:{error:'browser_request_refused'}});}
});
it('malformed success/private extra fields are redacted, with closed path-specific response schemas',()=>{
 for(const body of [{...accepted,text:'private'}, {...accepted,result:{id,version:2,text:'private'}},{...accepted,result:{id,version:0}}])expect(socialFactsBrowserResult('/outreach/answer-blocks/save',200,body)).toEqual({status:503,body:{error:'browser_request_refused'}});
 expect(socialFactsBrowserResult('/outreach/answer-blocks',200,accepted)?.status).toBe(503);expect(socialFactsBrowserResult('/outreach/answer-blocks/approve',200,{blocks:[]})?.status).toBe(503);expect(socialFactsBrowserResult('/outreach/settings/save',409,{status:'refused',replayed:false,reason:'stale_version'})).toBeNull();
});
