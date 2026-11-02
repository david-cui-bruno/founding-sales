import {once} from 'node:events';
import {createServer,type IncomingMessage,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {AwsClient} from 'google-auth-library';
import {afterEach,describe,expect,it} from 'vitest';
import {qualificationRequest} from '@fss/domain/sourcing/qualificationPrompt.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers,workerSourceFlags} from '../src/bootstrap/main.ts';
import {qualificationExtraction,readQualificationComposition} from '../src/sourcing/qualificationExtraction.ts';
import {awsFederatedTokenSource,awsSecurityCredentialsSupplier,vertexCredentialConfigSchema} from '../src/sourcing/vertexCredentials.ts';
import {VERTEX_VARIABLES,VertexRequestError,readVertexConfig,vertexGeminiSurface,type GeminiSurface} from '../src/sourcing/vertexGemini.ts';

const credential={
 type:'external_account',
 audience:'//iam.googleapis.com/projects/873586425850/locations/global/workloadIdentityPools/fss-prod-aws/providers/fss-prod-worker',
 subject_token_type:'urn:ietf:params:aws:token-type:aws4_request',
 token_url:'https://sts.googleapis.com/v1/token',
 service_account_impersonation_url:'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/callie-qualification@colormyworld-prod-dc824.iam.gserviceaccount.com:generateAccessToken',
};
const environment={FSS_VERTEX_PROJECT:'colormyworld-prod-dc824',FSS_VERTEX_LOCATION:'global',FSS_VERTEX_CREDENTIAL_CONFIG:JSON.stringify(credential),AWS_REGION:'us-east-1'};
const generation=qualificationRequest({candidate:{firmName:'Harbor Example Management',locality:'Boston',region:'MA',website:'https://example.test/'},observations:[{id:'11111111-1111-4111-8111-111111111111',url:'https://example.test/',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:'2026-10-05T00:00:00Z',publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'b1',text:'We manage homes.'}]}],modelName:'gemini-3.8-flash',maxInputTokens:5000,maxOutputTokens:4096});
const request={systemInstruction:generation.systemInstruction,contents:generation.contents};

interface Call {url:string;init:RequestInit}
function recordingFetch(answer:(call:Call)=>Response|Promise<Response>):{calls:Call[];fetch:typeof fetch} {
 const calls:Call[]=[];
 return {calls,fetch:(async(input:string|URL|Request,init:RequestInit={})=>{const call={url:String(input),init};calls.push(call);return await answer(call);}) as typeof fetch};
}
const json=(body:unknown,status=200):Response=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

describe('the Vertex surface',()=>{
 it('calls the global publisher endpoint with the bearer token, and counts with totalTokens',async()=>{
  const seen=recordingFetch(()=>json({totalTokens:113}));
  const surface=vertexGeminiSurface({project:'colormyworld-prod-dc824',location:'global',accessToken:async()=>'tok',fetch:seen.fetch});
  expect(await surface.countTokens(request)).toBe(113);
  expect(seen.calls[0]?.url).toBe('https://aiplatform.googleapis.com/v1/projects/colormyworld-prod-dc824/locations/global/publishers/google/models/gemini-3.8-flash:countTokens');
  expect(seen.calls[0]?.init.headers).toMatchObject({authorization:'Bearer tok'});
  expect(JSON.parse(String(seen.calls[0]?.init.body))).toEqual(request);
 });
 it('uses the regional host for a region and generateContent for generation',async()=>{
  const seen=recordingFetch(()=>json({candidates:[]}));
  const surface=vertexGeminiSurface({project:'p-project',location:'us-central1',accessToken:async()=>'tok',fetch:seen.fetch});
  expect(await surface.generate(generation)).toEqual({candidates:[]});
  expect(seen.calls[0]?.url).toBe('https://us-central1.aiplatform.googleapis.com/v1/projects/p-project/locations/us-central1/publishers/google/models/gemini-3.8-flash:generateContent');
 });
 it('rejects a count that is not a count',async()=>{
  for(const answer of [{},{totalTokens:'5'},{totalTokens:-1},{totalTokens:1.5}]){
   const surface=vertexGeminiSurface({project:'p-project',location:'global',accessToken:async()=>'tok',fetch:recordingFetch(()=>json(answer)).fetch});
   await expect(surface.countTokens(request)).rejects.toThrow('countTokens returned no totalTokens');
  }
 });
 it('reports the status of a refusal without reading the body, which can echo the prompt',async()=>{
  let bodyRead=false;
  const surface=vertexGeminiSurface({project:'p-project',location:'global',accessToken:async()=>'tok',fetch:recordingFetch(()=>{
   const response=json({error:{message:'echoes company text'}},429);
   Object.defineProperty(response,'text',{value:()=>{bodyRead=true;return Promise.resolve('');}});
   Object.defineProperty(response,'json',{value:()=>{bodyRead=true;return Promise.resolve({});}});
   return response;
  }).fetch});
  const failure=await surface.generate(generation).catch((error:unknown)=>error);
  expect(failure).toBeInstanceOf(VertexRequestError);
  expect(failure).toMatchObject({status:429,message:'vertex_http_429'});
  expect(bodyRead).toBe(false);
 });
 it('cannot say whether a dropped connection or an unreadable answer ran',async()=>{
  const dropped=vertexGeminiSurface({project:'p-project',location:'global',accessToken:async()=>'tok',fetch:(()=>Promise.reject(new Error('socket hang up'))) as typeof fetch});
  await expect(dropped.generate(generation)).rejects.toMatchObject({status:null});
  const garbled=vertexGeminiSurface({project:'p-project',location:'global',accessToken:async()=>'tok',fetch:recordingFetch(()=>new Response('<html>',{status:200})).fetch});
  await expect(garbled.generate(generation)).rejects.toMatchObject({status:null});
 });
 it('makes no request when no access token can be had, and says so',async()=>{
  const seen=recordingFetch(()=>json({}));
  const surface=vertexGeminiSurface({project:'p-project',location:'global',accessToken:async()=>{throw new Error('sts down');},fetch:seen.fetch});
  const failure=await surface.generate(generation).catch((error:unknown)=>error);
  expect(failure).toMatchObject({status:null,refusedBeforeGeneration:true});
  expect(seen.calls).toEqual([]);
 });
});

describe('the worker composition',()=>{
 const base={classifier:undefined,mail:undefined,send:undefined,research:{pageFetch:{providerKey:'test',fetchPages:async()=>({ok:false as const,costCents:0,reason:'unavailable'})}}};
 const surface:GeminiSurface={countTokens:async()=>1,generate:async()=>({})};
 it('schedules qualification only when Vertex was composed',()=>{
  expect(workerSourceFlags(base as never).qualification).toBe(false);
  expect(workerSourceFlags(base as never).sourcing).toBe(true);
  const composed={...base,qualification:qualificationExtraction(surface)};
  expect(workerSourceFlags(composed as never).qualification).toBe(true);
  expect(workerSourceFlags({...composed,research:undefined} as never).qualification).toBe(false);
 });
 it.each([['off',false],['OFF ',false],['on',true],[undefined,true]] as const)('reads FSS_CLASSIFIER=%s on its own, before any Vertex load, so neither scheduling nor the handler gets an extraction, with or without a classifier transport',async(value,enabled)=>{
  let loads=0;
  const composed=await readQualificationComposition({...environment,...value===undefined?{}:{FSS_CLASSIFIER:value}},async()=>{loads++;return surface;});
  expect(composed).toMatchObject(enabled?{problem:null}:{extraction:null,problem:'FSS_CLASSIFIER'});expect(loads).toBe(enabled?1:0);
  const transport={kind:'bedrock' as const,countTokens:async()=>1,create:async()=>{throw Error('unused');}};
  for(const classifier of [undefined,{transport,processEnabled:true},{transport,processEnabled:false}]){
   const composition={...base,classifier,...composed.extraction===null?{}:{qualification:composed.extraction}};
   expect(workerSourceFlags(composition as never).qualification).toBe(enabled);
  }
 });
 it('registers the qualification handler whenever research is composed, so an unconfigured run is refused rather than lost',()=>{
  expect(registerHandlers(new HandlerRegistry(),base as never).get('sourcing.qualify')).toBeDefined();
 });
});

describe('the Vertex configuration',()=>{
 it('is absent, without a problem, when no variable is set',()=>{
  expect(readVertexConfig({})).toEqual({config:null,problem:null});
  expect(readVertexConfig({FSS_VERTEX_PROJECT:'  ',FSS_VERTEX_LOCATION:''})).toEqual({config:null,problem:null});
 });
 it('reads the whole set, and names the variable that is wrong or missing',()=>{
  expect(readVertexConfig(environment)).toEqual({config:{project:'colormyworld-prod-dc824',location:'global',credential,awsRegion:'us-east-1'},problem:null});
  for(const name of VERTEX_VARIABLES)expect(readVertexConfig({...environment,[name]:''})).toEqual({config:null,problem:name});
  expect(readVertexConfig({...environment,AWS_REGION:''})).toEqual({config:null,problem:'AWS_REGION'});
  expect(readVertexConfig({...environment,FSS_VERTEX_PROJECT:'Bad Project'}).problem).toBe('FSS_VERTEX_PROJECT');
  expect(readVertexConfig({...environment,FSS_VERTEX_LOCATION:'https://evil.example'}).problem).toBe('FSS_VERTEX_LOCATION');
  expect(readVertexConfig({...environment,FSS_VERTEX_CREDENTIAL_CONFIG:'{'}).problem).toBe('FSS_VERTEX_CREDENTIAL_CONFIG');
 });
 it('accepts only the federation of a pool provider into a service account, never a key or another endpoint',()=>{
  const parse=(patch:Record<string,unknown>)=>vertexCredentialConfigSchema.safeParse({...credential,...patch}).success;
  expect(parse({})).toBe(true);
  expect(parse({type:'service_account'})).toBe(false);
  expect(parse({audience:'//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q'})).toBe(false);
  expect(parse({token_url:'https://evil.example/token'})).toBe(false);
  expect(parse({service_account_impersonation_url:'https://evil.example/v1/projects/-/serviceAccounts/a@b.iam.gserviceaccount.com:generateAccessToken'})).toBe(false);
  expect(parse({subject_token_type:'urn:ietf:params:oauth:token-type:jwt'})).toBe(false);
 });
 it('composes no qualification, with the variable named, when unset, partial or unloadable; composes it when whole',async()=>{
  const surface:GeminiSurface={countTokens:async()=>1,generate:async()=>({})};
  expect(await readQualificationComposition({},async()=>surface)).toEqual({extraction:null,problem:null});
  expect(await readQualificationComposition({FSS_VERTEX_PROJECT:'colormyworld-prod-dc824'},async()=>surface)).toEqual({extraction:null,problem:'FSS_VERTEX_LOCATION'});
  expect(await readQualificationComposition(environment,async()=>{throw new Error('no sdk');})).toEqual({extraction:null,problem:'vertex_load_failed'});
  const composed=await readQualificationComposition(environment,async()=>surface);
  expect(composed.problem).toBeNull();
  expect(composed.extraction?.providerKey).toBe(qualificationExtraction(surface).providerKey);
  expect(composed.extraction?.providerKey).toBe('google_vertex.sourcing_qualification');
 });
});

describe('the AWS credentials the federation signs with',()=>{
 it('hands the task role session token over as `token`',async()=>{
  const supplier=awsSecurityCredentialsSupplier('us-east-1',async()=>({accessKeyId:'AKIDEXAMPLE',secretAccessKey:'secret',sessionToken:'session'}));
  expect(await supplier.getAwsRegion()).toBe('us-east-1');
  expect(await supplier.getAwsSecurityCredentials()).toEqual({accessKeyId:'AKIDEXAMPLE',secretAccessKey:'secret',token:'session'});
  const longTerm=awsSecurityCredentialsSupplier('us-east-1',async()=>({accessKeyId:'AKIDEXAMPLE',secretAccessKey:'secret'}));
  expect(await longTerm.getAwsSecurityCredentials()).toEqual({accessKeyId:'AKIDEXAMPLE',secretAccessKey:'secret'});
 });
 it('refuses incomplete credentials rather than signing with them',async()=>{
  const supplier=awsSecurityCredentialsSupplier('us-east-1',async()=>({accessKeyId:'',secretAccessKey:'secret'}));
  await expect(supplier.getAwsSecurityCredentials()).rejects.toThrow('aws_credentials_incomplete');
 });
 it('signs a regional STS GetCallerIdentity request that names the pool provider as its audience',async()=>{
  const client=new AwsClient({
   type:'external_account',audience:credential.audience,subject_token_type:credential.subject_token_type,token_url:credential.token_url,
   aws_security_credentials_supplier:awsSecurityCredentialsSupplier('us-east-1',async()=>({accessKeyId:'AKIDEXAMPLE',secretAccessKey:'secret',sessionToken:'session'})),
  });
  const subject=JSON.parse(decodeURIComponent(await client.retrieveSubjectToken())) as {url:string;method:string;headers:{key:string;value:string}[]};
  const header=(key:string)=>subject.headers.find(candidate=>candidate.key.toLowerCase()===key)?.value;
  expect(subject.url).toBe('https://sts.us-east-1.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15');
  expect(subject.method).toBe('POST');
  expect(header('x-goog-cloud-target-resource')).toBe(credential.audience);
  expect(header('x-amz-security-token')).toBe('session');
  expect(header('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/sts\/aws4_request, SignedHeaders=.*x-amz-security-token.*, Signature=[0-9a-f]{64}$/u);
 });
});

describe('the federated token exchange',()=>{
 const servers:Server[]=[];
 afterEach(async()=>{
  await Promise.all(servers.splice(0).map(async server=>{server.close();await once(server,'close');}));
 });
 const readBody=async(incoming:IncomingMessage):Promise<string>=>{let text='';for await(const chunk of incoming)text+=String(chunk);return text;};

 it('exchanges the signed AWS identity at STS, impersonates the service account and caches the access token',async()=>{
  const seen:{url:string;authorization:string|undefined;body:string}[]=[];
  const server=createServer((incoming,outgoing)=>{
   void readBody(incoming).then(body=>{
    seen.push({url:incoming.url??'',authorization:incoming.headers.authorization,body});
    outgoing.setHeader('content-type','application/json');
    if(incoming.url==='/token')outgoing.end(JSON.stringify({access_token:'federated',issued_token_type:'urn:ietf:params:oauth:token-type:access_token',token_type:'Bearer',expires_in:3600}));
    else outgoing.end(JSON.stringify({accessToken:'service-account-token',expireTime:new Date(Date.now()+3_600_000).toISOString()}));
   });
  });
  servers.push(server);
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const source=await awsFederatedTokenSource({audience:credential.audience,tokenUrl:`${base}/token`,serviceAccountImpersonationUrl:`${base}/impersonate`},awsSecurityCredentialsSupplier('us-east-1',async()=>({accessKeyId:'AKIDEXAMPLE',secretAccessKey:'secret',sessionToken:'session'})));
  expect(await source.token()).toBe('service-account-token');
  expect(await source.token()).toBe('service-account-token');
  expect(seen.map(call=>call.url)).toEqual(['/token','/impersonate']);
  const exchange=Object.fromEntries(new URLSearchParams(seen[0]?.body??''));
  expect(exchange).toMatchObject({grant_type:'urn:ietf:params:oauth:grant-type:token-exchange',audience:credential.audience,requested_token_type:'urn:ietf:params:oauth:token-type:access_token',subject_token_type:credential.subject_token_type});
  expect(JSON.parse(decodeURIComponent(exchange['subject_token']??'')).url).toBe('https://sts.us-east-1.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15');
  expect(seen[1]?.authorization).toBe('Bearer federated');
  expect(JSON.parse(seen[1]?.body??'{}')).toMatchObject({scope:['https://www.googleapis.com/auth/cloud-platform']});
 });
});
