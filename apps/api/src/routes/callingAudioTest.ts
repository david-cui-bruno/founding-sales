import {createAudioTestSessionCommandSchema,audioTestExecutionReceiptInputSchema} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import type {RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {createAudioTestSession} from '@fss/domain/calls/audioTest.ts';
import {readAudioTestExecutionReceipt} from '@fss/domain/calls/audioTestReceipt.ts';
import {requireCurrentCallSessionClearance} from '@fss/domain/calls/sessionClearance.ts';
import {CallingAuthorityChanged,requireCallingAuthority} from '@fss/domain/calling/followUpDraftAccess.ts';
import {lockSendGateForStopFact} from '@fss/domain/policy/sendGate.ts';
import {lockSettingForRead} from '@fss/domain/settings/store.ts';
import {readCallingProvider} from '@fss/domain/settings/integrations.ts';
import {CallingProviderDisabled,policyRouteDeps,runPolicyCommand} from './dialSupport.ts';
import {contextForPrincipal} from './routeSupport.ts';
import {retainedPrincipalAuthority,retainedPrincipalPublicationAuthority} from './retainedPrincipalAuthority.ts';
import {privatePrincipalIsCurrent} from './privateReadAuthority.ts';
import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';

export const CALLING_AUDIO_TEST_PATHS=['/calling/audio-test/session','/calling/audio-test/receipt'] as const;
/** A short manual test enters the existing call-session engine, with no CRM subject. */
export async function routeCallingAudioTest(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!(CALLING_AUDIO_TEST_PATHS as readonly string[]).includes(request.path))return null;
 const prepared=await policyRouteDeps(request,options);if(!prepared.ok)return prepared.result;
 if(request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 const deps=prepared.deps,scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 try{
  let answer:RouteResult;
  if(request.path===CALLING_AUDIO_TEST_PATHS[1]){
   const parsed=audioTestExecutionReceiptInputSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
   const body=await withTransaction(deps.auth.db,()=>readAudioTestExecutionReceipt(scoped.context,parsed.data,deps.principal.deviceId,retainedPrincipalAuthority(deps,scoped.context)));
   answer={status:200,body};
  }else{
   const twilio=options.integrations?.twilio??null;
   if(!twilio)return {status:503,body:{error:'integration_unconfigured'}};
   let sessionId:string|null=null;
   const beforeCommit=async(ctx:RepositoryContext)=>{
    if(sessionId===null)return;
    const publication=retainedPrincipalPublicationAuthority(deps,ctx);
    await requireCallingAuthority(ctx,publication.authority);
    const at=await requireCurrentCallSessionClearance(ctx,sessionId);
    if(publication.publicationNow(Date.parse(at))===null)throw new CallingAuthorityChanged();
   };
   answer=await runPolicyCommand(deps,createAudioTestSessionCommandSchema,'create_audio_test_session',async(ctx,input)=>{
    await lockSendGateForStopFact(ctx);await lockSettingForRead(ctx,'calling_provider');
    if(await readCallingProvider(ctx)!=='twilio')throw new CallingProviderDisabled();
    const result=await createAudioTestSession(ctx,{e164:input.e164,callingIdentityId:input.callingIdentityId,
     deviceId:deps.principal.deviceId,commandId:input.commandId,configuredCallerIdE164:twilio.callerIdE164});
    if(result.ok)sessionId=result.value.sessionId;
    return result;
   },beforeCommit);
  }
  if(!await privatePrincipalIsCurrent(deps))throw new CallingAuthorityChanged();
  return answer;
 }catch(error){
  if(error instanceof CallingAuthorityChanged)return {status:401,body:{error:'session_changed'}};
  throw error;
 }
}
