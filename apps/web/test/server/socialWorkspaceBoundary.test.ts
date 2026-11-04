import {describe,expect,it} from 'vitest';
import {socialWorkspaceRequestAllowed,socialWorkspaceBrowserResult,socialStorageResultAllowed} from '../../src/server/socialWorkspaceBoundary.ts';
import {socialGuidedRequestInputSchema} from '@fss/contracts';
const id='00000000-0000-4000-8000-000000000001';
const command={commandId:id,clientVersion:'1.0.0'};
describe('signed Social workspace boundary',()=>{
 it('keeps an intended reconnect account identity separate from usable publisher authority',()=>{
  const body={binding:null,intendedAccountId:id,calibrationId:null,guideRef:null,inputIds:[]};
  expect(socialWorkspaceBrowserResult('/social/standing-plan/options',200,body)).toEqual({status:200,body});
  expect(socialWorkspaceRequestAllowed('/social/publisher/connection',{operation:'start',accountId:id})).toBe(true);
  expect(socialWorkspaceRequestAllowed('/social/publisher/connection',{operation:'start',accountId:id,usable:true})).toBe(false);
 });
 it('admits only current input refs and explicit founder processing, never standing worker authority',()=>{
  const input={mode:'linkedin_founder',sourceRefs:[],factBlocks:[],founderInputRefs:[{inputId:id,revision:1}],founderInputProcessingScope:'bedrock_haiku_founder_inputs_v1',founderFormat:'story'};
  expect(socialGuidedRequestInputSchema.safeParse(input).success).toBe(true);
  expect(socialGuidedRequestInputSchema.safeParse({...input,founderInputProcessingScope:undefined}).success).toBe(false);
  expect(socialGuidedRequestInputSchema.safeParse({...input,standingPlanRef:{planId:id,revision:1,slotId:id}}).success).toBe(false);
  expect(socialGuidedRequestInputSchema.safeParse({...input,sourceRefs:[{kind:'meeting',id,revision:1}]}).success).toBe(false);
 });
 it('refuses renderer authority fields and prose in read requests',()=>{
  expect(socialWorkspaceRequestAllowed('/social/inputs/read',{inputId:id})).toBe(true);
  expect(socialWorkspaceRequestAllowed('/social/inputs/read',{inputId:id,ownerUserId:id})).toBe(false);
  expect(socialWorkspaceRequestAllowed('/social/calibration/read',{notes:'private'})).toBe(false);
  expect(socialWorkspaceRequestAllowed('/social/publisher/connection',{operation:'input',connectionId:id,event:{kind:'text',text:'ephemeral'},...command})).toBe(false);
 });
 it('preserves domain CAS refusal without pretending authority collisions succeeded',()=>{
  const refusal={status:'refused',replayed:false,reason:'stale_revision'};
  expect(socialWorkspaceBrowserResult('/social/inputs/save',409,refusal)).toEqual({status:200,body:refusal});
  expect(socialWorkspaceBrowserResult('/social/inputs/save',409,{...refusal,reason:'command_payload_mismatch'})).toEqual({status:409,body:{error:'browser_request_refused'}});
 });
 it('never projects malformed or extra private fields from provider responses',()=>{
  expect(socialWorkspaceBrowserResult('/social/calibration/read',200,{completion:null,rawPrompt:'private'})).toEqual({status:502,body:{error:'browser_response_invalid'}});
  expect(socialWorkspaceBrowserResult('/social/publisher/connection',200,{state:'closed',cookies:'secret'})).toEqual({status:502,body:{error:'browser_response_invalid'}});
 });
 it('allows only exact configured signed storage origin, bounded expiry and upload headers',()=>{
  const origin='https://fixture-social.s3.us-east-1.amazonaws.com';
  const body={url:`${origin}/fixture?X-Amz-Signature=abc`,expiresAt:new Date(Date.now()+60_000).toISOString(),headers:{'content-type':'image/png','content-length':'10','if-none-match':'*'}};
  expect(socialStorageResultAllowed('/social/assets/upload-url',200,body,origin)).toBe(true);
  for(const url of ['https://evil.example/fixture?X-Amz-Signature=abc',`${origin}.evil.example/fixture?X-Amz-Signature=abc`,`${origin}/unsigned`])expect(socialStorageResultAllowed('/social/assets/upload-url',200,{...body,url},origin)).toBe(false);
  expect(socialStorageResultAllowed('/social/assets/upload-url',200,body,undefined)).toBe(false);
  expect(socialStorageResultAllowed('/social/assets/upload-url',200,{...body,headers:{authorization:'secret'}},origin)).toBe(false);
  for(const headers of [null,[],42,'content-type',{'content-type':42}])expect(socialStorageResultAllowed('/social/assets/upload-url',200,{...body,headers},origin)).toBe(false);
  expect(socialStorageResultAllowed('/social/assets/upload-url',200,{...body,expiresAt:new Date(Date.now()-1).toISOString()},origin)).toBe(false);
 });
});
