import {beforeEach,expect,it,vi} from 'vitest';
import {routeEmailCampaigns} from '../src/routes/emailCampaigns.ts';
import type {ApiRequest,RoutingOptions} from '../src/routes/types.ts';
import type * as RouteSupport from '../src/routes/routeSupport.ts';
const mocks=vi.hoisted(()=>({command:vi.fn(),control:vi.fn(),approve:vi.fn(),revoke:vi.fn(),authority:vi.fn(),context:vi.fn()}));
vi.mock('../src/auth/commands.ts',()=>({runCommand:mocks.command}));
vi.mock('@fss/domain/outreach/emailCampaign.ts',()=>({approveEmailCampaign:mocks.approve,revokeEmailCampaign:mocks.revoke,readEmailCampaignControl:mocks.control}));
vi.mock('@fss/domain/db/queryable.ts',()=>({withTransaction:async(_db:unknown,work:()=>Promise<unknown>)=>work()}));
vi.mock('../src/routes/routeSupport.ts',async importOriginal=>({...await importOriginal<typeof RouteSupport>(),contextForPrincipal:mocks.context,requirePrincipal:mocks.authority}));
const id='00000000-0000-4000-8000-000000000001';
const principal={workspaceId:id,userId:id,role:'admin',membershipStatus:'active',deviceId:id,deviceStatus:'active',sessionId:id};
const options={auth:{db:{}}} as unknown as RoutingOptions;
const policy={mailboxId:id,sequenceVersionId:id,authorizationRevision:3,regions:['TX'],maxEnrollments:25,dailyAdmissionLimit:5,expiresAt:'2026-10-23T17:00:00Z'};
const command={...policy,commandId:id,clientVersion:'1.0.0'};
const request=(path:string,body:unknown={}):ApiRequest=>({method:'POST',path,headers:{},query:new URLSearchParams(),body});
beforeEach(()=>{
 vi.clearAllMocks();mocks.authority.mockResolvedValue({ok:true,principal});mocks.context.mockReturnValue({ok:true,context:{db:{},scope:{}}});mocks.control.mockResolvedValue(null);
 mocks.command.mockResolvedValue({status:'accepted',result:{campaignId:id,revision:1},replayed:false});
});
it('claims only the three exact POST routes',async()=>{
 expect(await routeEmailCampaigns(request('/outreach/email-campaigns/other'),options)).toBeNull();
 expect(await routeEmailCampaigns({...request('/outreach/email-campaigns/control'),method:'GET'},options)).toEqual({status:405,body:{error:'method_not_allowed'}});
 expect(mocks.authority).not.toHaveBeenCalled();
});
it('refuses non-admin actors before reading campaign content',async()=>{
 mocks.authority.mockResolvedValue({ok:true,principal:{...principal,role:'salesperson'}});
 expect(await routeEmailCampaigns(request('/outreach/email-campaigns/control'),options)).toEqual({status:403,body:{error:'admin_required'}});
 expect(mocks.control).not.toHaveBeenCalled();
});
it('authenticated content unavailable is404, not an auth-invalidating409',async()=>{
 expect(await routeEmailCampaigns(request('/outreach/email-campaigns/control'),options)).toEqual({status:404,body:{error:'campaign_control_unavailable'}});
});
it.each([false,true])('accepted replayed=%s returns only historical identifiers without reading private current proof',async replayed=>{
 const receipt={status:'accepted',result:{campaignId:id,revision:1},replayed};mocks.command.mockResolvedValue(receipt);
 expect(await routeEmailCampaigns(request('/outreach/email-campaigns/approve',command),options)).toEqual({status:200,body:receipt});
 expect(mocks.control).not.toHaveBeenCalled();
 expect(mocks.command).toHaveBeenCalledExactlyOnceWith(options.auth,principal,{commandId:id,clientVersion:'1.0.0',kind:'outreach.email_campaign_approve',payload:policy},expect.any(Function));
});
it.each(['control','approve','revoke'])('withholds late %s results after current session replacement',async action=>{
 mocks.authority.mockResolvedValueOnce({ok:true,principal}).mockResolvedValue({ok:true,principal:{...principal,sessionId:'replacement'}});
 const body=action==='control'?{}:action==='approve'?command:{id,expectedRevision:1,commandId:id,clientVersion:'1.0.0'};
 expect(await routeEmailCampaigns(request(`/outreach/email-campaigns/${action}`,body),options)).toEqual({status:401,body:{error:'unauthenticated'}});
});
it('rejects malformed commands without running a mutation',async()=>{
 expect(await routeEmailCampaigns(request('/outreach/email-campaigns/approve',{...command,reviewed:true}),options)).toEqual({status:400,body:{error:'malformed_body'}});
 expect(mocks.command).not.toHaveBeenCalled();
});
it('passes current authority callback into the domain mutation',async()=>{
 mocks.approve.mockResolvedValue({ok:true,value:{campaignId:id,revision:1}});
 mocks.command.mockImplementation(async(_auth:unknown,_principal:unknown,_input:unknown,work:(context:unknown)=>Promise<Record<string,unknown>>)=>({...await work({scope:{}}),replayed:false}));
 await routeEmailCampaigns(request('/outreach/email-campaigns/approve',command),options);
 expect(mocks.approve).toHaveBeenCalledWith({scope:{}},policy,expect.any(Function));
 expect(await mocks.approve.mock.calls[0]?.[2]()).toBe(true);
});
