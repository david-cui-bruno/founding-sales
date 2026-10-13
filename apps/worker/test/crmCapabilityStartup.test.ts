import {MockLanguageModelV3} from 'ai/test';
import {expect,it} from 'vitest';
import {readCrmCapabilityStartup,createCrmCapabilityRuntime} from '@fss/domain/crm/capabilityStartup.ts';
import {composeCrmCapabilities} from '../src/bootstrap/crmCapabilities.ts';
import {CRM_SUPPORTED_AGENT_ASK_VERSIONS,CRM_SUPPORTED_ASK_VERSIONS} from '@fss/domain/crm/capabilityAuthority.ts';
const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-haiku-4-5-20251001-v1:0' as const,providerKey:'synthetic-crm',accessGrantVersion:'reviewed-crm-grant',dataHandlingVersion:'reviewed-crm-handling',fundingVerifiedUntil:'2099-01-01T00:00:00Z'};
const identity={implementationCommit:'a'.repeat(40),imageDigest:`sha256:${'b'.repeat(64)}`,side:'worker' as const,schemaVersion:88,gmailAvailable:false};
it('keeps startup absent/off without opening sessions or constructing hosted transports',async()=>{const configuration=readCrmCapabilityStartup({});const result=await composeCrmCapabilities({configuration,runtime:createCrmCapabilityRuntime(configuration,identity),openSession:async()=>{throw new Error('unexpected database');},loadSurface:async()=>{throw new Error('unexpected SDK');}});expect(configuration).toEqual({capture:false});expect(result.handlers).toEqual({});});
it('pins the reviewed region/profile and exact independent purpose bindings without activating configuration',async()=>{const configuration=readCrmCapabilityStartup({FSS_CRM_CAPABILITY_ADAPTERS:JSON.stringify({extraction:route,answer:route})});let constructed=0;let calls=0;const runtime=createCrmCapabilityRuntime(configuration,identity);const result=await composeCrmCapabilities({configuration,runtime,openSession:async()=>{throw new Error('no activation session');},loadSurface:async region=>{expect(region).toBe('us-east-1');constructed++;return {endpointId:route.endpointId,converse:async()=>{calls++;throw new Error('not invoked');}};}});expect(constructed).toBe(1);expect(calls).toBe(0);expect(result.handlers.crmExtraction?.adapter?.modelVersion).toBe(route.modelVersion);expect(result.handlers.crmExtraction?.allowControlledEvaluation).toBeUndefined();expect(result.handlers.crmExtraction?.verifyPurpose).toBeTypeOf('function');expect(result.handlers.crmExtraction?.revalidatePurpose).toBeTypeOf('function');expect(result.handlers.crmAskAnswers?.verifyPurpose).toBeTypeOf('function');const config={capability:'ask_answer' as const,workspaceId:'00000000-0000-4000-8000-000000000001',ownerUserId:'00000000-0000-4000-8000-000000000002',revision:1,purpose:'answer' as const,...route,...CRM_SUPPORTED_ASK_VERSIONS,evaluationFingerprint:'c'.repeat(64),dailyCeilingCents:10,monthlyCeilingCents:100,inputTokenPriceMicros:1,outputTokenPriceMicros:1};expect(runtime.adapterAvailable(config)).toBe(true);expect(runtime.adapterAvailable({...config,retrievalVersion:'semantic-untested'})).toBe(false);expect(runtime.adapterAvailable({...config,accessGrantVersion:'classifier-grant'})).toBe(false);});
it('rejects config flags that imply authority or silently substitute another provider endpoint',()=>{for(const input of [{enabled:true},{capture:true,approved:true},{extraction:{...route,region:'us-west-2'}},{answer:{...route,modelVersion:'global.anthropic.claude-haiku'}}])expect(()=>readCrmCapabilityStartup({FSS_CRM_CAPABILITY_ADAPTERS:JSON.stringify(input)})).toThrow('crm_capability_adapter_configuration_invalid');});

it('constructs only explicitly configured current US models without calls, activation or fallback',async()=>{
 for(const modelVersion of ['us.anthropic.claude-sonnet-5-5','us.anthropic.claude-haiku-5-5','us.anthropic.claude-sonnet-4-6'] as const){
  const selected={...route,modelVersion};
  const configuration=readCrmCapabilityStartup({FSS_CRM_CAPABILITY_ADAPTERS:JSON.stringify({extraction:selected,answer:selected})});
  let calls=0;const runtime=createCrmCapabilityRuntime(configuration,identity);
  const composed=await composeCrmCapabilities({configuration,runtime,openSession:async()=>{throw new Error('no activation');},loadSurface:async()=>({endpointId:route.endpointId,converse:async()=>{calls++;throw new Error('no paid calls');}})});
  expect(composed.handlers.crmExtraction?.adapter?.modelVersion).toBe(modelVersion);expect(calls).toBe(0);
  const config={capability:'ask_answer' as const,workspaceId:'00000000-0000-4000-8000-000000000001',ownerUserId:'00000000-0000-4000-8000-000000000002',revision:1,purpose:'answer' as const,...selected,...CRM_SUPPORTED_ASK_VERSIONS,evaluationFingerprint:'c'.repeat(64),dailyCeilingCents:10,monthlyCeilingCents:100,inputTokenPriceMicros:1,outputTokenPriceMicros:1};
  expect(runtime.adapterAvailable(config)).toBe(true);expect(runtime.adapterAvailable({...config,modelVersion:route.modelVersion})).toBe(false);
 }
});

const limits={maxSteps:8,maxInputBytes:25000,maxOutputTokens:4096,deadlineMs:30000};
const vertexRoute={...route,provider:'google_vertex' as const,region:'us' as const,projectId:'callie-test-project',endpointId:'vertex.us/callie-test-project',modelVersion:'gemini-3.8-flash' as const,agentLimits:limits};
it('admits only explicit project-bound US Gemini answer configuration with bounded agent execution',()=>{
 expect(readCrmCapabilityStartup({FSS_CRM_CAPABILITY_ADAPTERS:JSON.stringify({answer:vertexRoute})})).toEqual({capture:false,answer:vertexRoute});
 for(const answer of [{...vertexRoute,agentLimits:undefined},{...vertexRoute,provider:undefined},{...vertexRoute,region:'global'},{...vertexRoute,projectId:'another-project'},{...vertexRoute,endpointId:'https://aiplatform.googleapis.com'},{...vertexRoute,modelVersion:'gemini-3.1-pro'}])expect(()=>readCrmCapabilityStartup({FSS_CRM_CAPABILITY_ADAPTERS:JSON.stringify({answer})})).toThrow('crm_capability_adapter_configuration_invalid');
 expect(()=>readCrmCapabilityStartup({FSS_CRM_CAPABILITY_ADAPTERS:JSON.stringify({extraction:vertexRoute})})).toThrow('crm_capability_adapter_configuration_invalid');
});

it('composes Vertex-only Ask without Bedrock loading, database access, provider calls or activation',async()=>{
 const configuration=readCrmCapabilityStartup({FSS_CRM_CAPABILITY_ADAPTERS:JSON.stringify({answer:vertexRoute})});
 const model=new MockLanguageModelV3({doGenerate:async()=>{throw new Error('no dispatch at startup');}});
 const composed=await composeCrmCapabilities({configuration,runtime:createCrmCapabilityRuntime(configuration,identity),openSession:async()=>{throw new Error('no authority at startup');},answerModel:model,loadSurface:async()=>{throw new Error('Vertex answer must not construct Bedrock');}});
 expect(composed.handlers.crmExtraction).toBeUndefined();expect(composed.handlers.crmAskIndex).toBeUndefined();
 expect(composed.handlers.crmAskAnswers?.agent).toMatchObject({endpointId:vertexRoute.endpointId,modelVersion:'gemini-3.8-flash',providerKey:vertexRoute.providerKey});
 expect(composed.handlers.crmAskAnswers?.agentLimits).toEqual(limits);expect(composed.handlers.crmAskAnswers?.verifyPurpose).toBeTypeOf('function');expect(composed.handlers.crmAskAnswers?.revalidatePurpose).toBeTypeOf('function');expect(composed.handlers.crmAskAnswers?.allowControlledEvaluation).toBeUndefined();
});

it('keeps Bedrock extraction and embedding independent when Gemini owns answering',async()=>{
 const embedding={...route,modelVersion:'amazon.titan-embed-text-v2:0',dimensions:256};
 const configuration=readCrmCapabilityStartup({FSS_CRM_CAPABILITY_ADAPTERS:JSON.stringify({extraction:route,embedding,answer:vertexRoute})});
 let constructed=0;
 const composed=await composeCrmCapabilities({configuration,runtime:createCrmCapabilityRuntime(configuration,identity),openSession:async()=>{throw new Error('no activation');},answerModel:new MockLanguageModelV3({doGenerate:async()=>{throw new Error('no dispatch');}}),loadSurface:async region=>{expect(region).toBe('us-east-1');constructed++;return {endpointId:route.endpointId,converse:async()=>{throw new Error('no dispatch');}};}});
 expect(constructed).toBe(1);expect(composed.handlers.crmExtraction?.adapter?.modelVersion).toBe(route.modelVersion);expect(composed.handlers.crmAskIndex?.embedding?.modelVersion).toBe('amazon.titan-embed-text-v2:0');expect(composed.handlers.crmAskAnswers?.embedding?.modelVersion).toBe('amazon.titan-embed-text-v2:0');expect(composed.handlers.crmAskAnswers?.agent?.modelVersion).toBe('gemini-3.8-flash');
});
it('binds Gemini availability to current purpose versions, project, funding, consent versions and exact limits',()=>{
 const configuration=readCrmCapabilityStartup({FSS_CRM_CAPABILITY_ADAPTERS:JSON.stringify({answer:vertexRoute})});
 const runtime=createCrmCapabilityRuntime(configuration,identity);
 const config={capability:'ask_answer' as const,workspaceId:'00000000-0000-4000-8000-000000000001',ownerUserId:'00000000-0000-4000-8000-000000000002',revision:1,purpose:'answer' as const,...vertexRoute,...CRM_SUPPORTED_AGENT_ASK_VERSIONS,evaluationFingerprint:'c'.repeat(64),dailyCeilingCents:10,monthlyCeilingCents:100,inputTokenPriceMicros:1,outputTokenPriceMicros:1};
 expect(runtime.adapterAvailable(config)).toBe(true);
 for(const changes of [{endpointId:'vertex.us/another-project'},{modelVersion:'gemini-3.1-pro'},{accessGrantVersion:'different-grant'},{dataHandlingVersion:'different-handling'},{agentLimits:{...limits,maxSteps:9}},{retrievalVersion:'untested'}])expect(runtime.adapterAvailable({...config,...changes})).toBe(false);
 const expired=createCrmCapabilityRuntime({...configuration,answer:{...vertexRoute,fundingVerifiedUntil:'2000-01-01T00:00:00Z'}},identity);expect(expired.adapterAvailable(config)).toBe(false);
});
