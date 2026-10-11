import {createServer} from 'node:http';
import {once} from 'node:events';
import {expect,it,vi} from 'vitest';
import {createAskSdkStepAdapter} from '../src/providers/askAgentSdk.ts';
it('uses the ordinary AWS role credential chain for actual AI SDK signing without static environment keys',async()=>{
 const endpoint=createServer((_request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({AccessKeyId:'ROLEFIXTUREACCESS',SecretAccessKey:'role-fixture-secret',Token:'role-fixture-token',Expiration:'2099-01-01T00:00:00Z'}));});
 endpoint.listen(0,'127.0.0.1');await once(endpoint,'listening');const address=endpoint.address();if(!address||typeof address==='string')throw new Error('controlled endpoint unavailable');
 try{
  for(const name of ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_PROFILE','AWS_WEB_IDENTITY_TOKEN_FILE','AWS_ROLE_ARN','AWS_CONTAINER_CREDENTIALS_RELATIVE_URI','AWS_BEARER_TOKEN_BEDROCK'])vi.stubEnv(name,undefined);
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE','/nonexistent-controlled-credentials');vi.stubEnv('AWS_CONFIG_FILE','/nonexistent-controlled-config');vi.stubEnv('AWS_EC2_METADATA_DISABLED','true');vi.stubEnv('AWS_CONTAINER_CREDENTIALS_FULL_URI',`http://127.0.0.1:${address.port}/credentials`);
  let calls=0;
  const fetch:typeof globalThis.fetch=async(_url,options)=>{
   calls++;const headers=new Headers(options?.headers);expect(headers.get('authorization')).toContain('Credential=ROLEFIXTUREACCESS/');expect(headers.get('x-amz-security-token')).toBe('role-fixture-token');
   return new Response(JSON.stringify({output:{message:{role:'assistant',content:[{text:'{"claims":[],"abstained":true}'}]}},stopReason:'end_turn',usage:{inputTokens:10,outputTokens:4,totalTokens:14},metrics:{latencyMs:1}}),{status:200,headers:{'content-type':'application/json'}});
  };
  const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'us.anthropic.claude-haiku-4-5-20251001-v1:0',providerKey:'controlled',fetch});
  expect(await adapter.runStep({question:'Synthetic?',transcript:[],maxOutputTokens:32,signal:new AbortController().signal})).toMatchObject({acceptance:'accepted',usage:{inputTokens:10,outputTokens:4},answer:{claims:[],abstained:true}});expect(calls).toBe(1);
 }finally{vi.unstubAllEnvs();endpoint.close();await once(endpoint,'close');}
});
