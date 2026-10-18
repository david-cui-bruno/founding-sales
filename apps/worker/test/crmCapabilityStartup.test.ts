import {expect,it} from 'vitest';
import {readCrmCapabilityStartup,createCrmCapabilityRuntime} from '@fss/domain/crm/capabilityStartup.ts';
import {composeCrmCapabilities} from '../src/bootstrap/crmCapabilities.ts';
import {CRM_SUPPORTED_ASK_VERSIONS} from '@fss/domain/crm/capabilityAuthority.ts';
const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-haiku-4-5-20251001-v1:0' as const,providerKey:'aws_bedrock.fixture',accessGrantVersion:'reviewed-crm-grant',dataHandlingVersion:'reviewed-crm-handling',fundingVerifiedUntil:'2099-01-01T00:00:00Z'};
const identity={implementationCommit:'a'.repeat(40),imageDigest:`sha256:${'b'.repeat(64)}`,side:'worker' as const,schemaVersion:88,gmailAvailable:false};
const noSession=async()=>{throw new Error('unexpected database');};
it('keeps startup absent/off without opening sessions or constructing hosted transports',async()=>{
 const configuration=readCrmCapabilityStartup({});
 const result=await composeCrmCapabilities({configuration,runtime:createCrmCapabilityRuntime(configuration,identity),openSession:noSession,loadSurface:async()=>{throw new Error('unexpected SDK');}});
 expect(configuration).toEqual({capture:false});expect(result.handlers).toEqual({});
});
it('discards legacy answer and embedding deployment fields without constructing any transport',async()=>{
 const configuration=readCrmCapabilityStartup({FSS_CRM_CAPABILITY_ADAPTERS:JSON.stringify({answer:route,embedding:{...route,modelVersion:'amazon.titan-embed-text-v2:0',dimensions:256}})});
 const runtime=createCrmCapabilityRuntime(configuration,identity);
 const result=await composeCrmCapabilities({configuration,runtime,openSession:noSession,loadSurface:async()=>{throw new Error('removed Ask must not load SDK');}});
 expect(configuration).toEqual({capture:false});expect(result.handlers).toEqual({});
 const ask={capability:'ask_answer' as const,workspaceId:'00000000-0000-4000-8000-000000000001',ownerUserId:'00000000-0000-4000-8000-000000000002',revision:1,purpose:'answer' as const,...route,...CRM_SUPPORTED_ASK_VERSIONS,evaluationFingerprint:'c'.repeat(64),dailyCeilingCents:10,monthlyCeilingCents:100,inputTokenPriceMicros:1,outputTokenPriceMicros:1};
 expect(runtime.adapterAvailable(ask)).toBe(false);
});
it('rejects authority flags and wrong extraction endpoint or region',()=>{
 for(const input of [{enabled:true},{capture:true,approved:true},{extraction:{...route,region:'us-west-2'}},{extraction:{...route,endpointId:'other.example.test'}}])expect(()=>readCrmCapabilityStartup({FSS_CRM_CAPABILITY_ADAPTERS:JSON.stringify(input)})).toThrow('crm_capability_adapter_configuration_invalid');
});
it.each(['us.anthropic.claude-sonnet-5-5','us.anthropic.claude-haiku-5-5','us.anthropic.claude-sonnet-4-6'] as const)('retains extraction-only composition for %s without calls or activation',async modelVersion=>{
 const selected={...route,modelVersion};
 const configuration=readCrmCapabilityStartup({FSS_CRM_CAPABILITY_ADAPTERS:JSON.stringify({extraction:selected,answer:route})});
 let constructed=0,calls=0;
 const runtime=createCrmCapabilityRuntime(configuration,identity);
 const composed=await composeCrmCapabilities({configuration,runtime,openSession:noSession,loadSurface:async region=>{expect(region).toBe('us-east-1');constructed++;return {endpointId:route.endpointId,converse:async()=>{calls++;throw new Error('not invoked');}};}});
 expect(constructed).toBe(1);expect(calls).toBe(0);expect(Object.keys(composed.handlers)).toEqual(['crmExtraction']);
 expect(composed.handlers.crmExtraction?.adapter?.modelVersion).toBe(modelVersion);expect(composed.handlers.crmExtraction?.verifyPurpose).toBeTypeOf('function');expect(composed.handlers.crmExtraction?.revalidatePurpose).toBeTypeOf('function');
});
