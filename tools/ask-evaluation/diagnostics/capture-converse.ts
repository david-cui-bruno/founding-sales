/** Private diagnostic capture. Opt-in callers own synthetic scope and spending.
 * Never records HTTP headers, credentials, URLs, signatures or reasoning blocks.
 */
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {z} from 'zod';
import {type createBedrockAskSdkModel,createAskSdkStepAdapter} from '../../../apps/worker/src/providers/askAgentSdk.ts';

type SdkFetch=NonNullable<Parameters<typeof createBedrockAskSdkModel>[0]['fetch']>;
const recordSchema=z.record(z.string(),z.json());
type Json= z.infer<typeof z.json>;
const requestKeys=['system','messages','toolConfig','inferenceConfig','additionalModelRequestFields','additionalModelResponseFieldPaths'] as const;
function withoutReasoning(value:Json):Json{
 if(Array.isArray(value))return value.filter(entry=>!(typeof entry==='object'&&entry!==null&&!Array.isArray(entry)&&('reasoningContent' in entry||entry['type']==='reasoning'))).map(withoutReasoning);
 if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['reasoningContent','reasoningText','signature','reasoning'].includes(key)).map(([key,entry])=>[key,withoutReasoning(entry)]));
 return value;
}
function requestBody(value:unknown){
 const parsed=recordSchema.safeParse(value);if(!parsed.success||Object.keys(parsed.data).some(key=>!requestKeys.some(allowed=>allowed===key)))return null;
 const messages=z.array(z.object({content:z.array(z.unknown())}).passthrough()).safeParse(parsed.data['messages']);
 if(messages.success&&messages.data.some(message=>message.content.some(block=>typeof block==='object'&&block!==null&&'reasoningContent' in block)))return null;
 return parsed.data;
}
function responseBody(value:unknown){
 const parsed=recordSchema.safeParse(value);if(!parsed.success)return null;
 const content=z.object({output:z.object({message:z.object({content:z.array(z.unknown())})})}).safeParse(value);
 const safeContent=content.success?content.data.output.message.content.flatMap(item=>{const block=recordSchema.safeParse(item);if(!block.success)return [];const text=typeof block.data['text']==='string'?{text:block.data['text']}:{};const tool=recordSchema.safeParse(block.data['toolUse']);return Object.keys(text).length||tool.success?[{...text,...tool.success?{toolUse:Object.fromEntries(['toolUseId','name','input','type'].filter(key=>tool.data[key]!==undefined).map(key=>[key,tool.data[key]!]))}:{}}]:[];}):[];
 return {output:{message:{content:safeContent}},...parsed.data['usage']===undefined?{}:{usage:withoutReasoning(parsed.data['usage'])},...typeof parsed.data['stopReason']==='string'?{stopReason:parsed.data['stopReason']}:{}};
}
/** Each transport attempt is stored before dispatch and after return. No retry.
 * Network errors retain only an index/phase; HTTP errors retain status only.
 */
export function createConverseCapture(input:{directory:string;fetch?:SdkFetch}){
 mkdirSync(input.directory,{recursive:true,mode:0o700});let index=0;
 const persist=(ordinal:number,phase:'request'|'response',value:unknown)=>writeFileSync(join(input.directory,`${String(ordinal).padStart(4,'0')}-${phase}.json`),JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});
 const transport=input.fetch??globalThis.fetch;
 const fetch:SdkFetch=async(url,init)=>{
  const ordinal=++index;let body:unknown=null;try{body=JSON.parse(String(init?.body)) as unknown;}catch{/* No raw malformed data retained. */}
  const safe=requestBody(body);if(safe===null)throw new Error('diagnostic_request_body_invalid');
  persist(ordinal,'request',{index:ordinal,body:safe});
  let response:Response;try{response=await transport(url,init);}catch{persist(ordinal,'response',{index:ordinal,phase:'transport_unknown'});throw new Error('diagnostic_transport_unknown');}
  if(!response.ok){persist(ordinal,'response',{index:ordinal,phase:'http_error',status:response.status});return response;}
  let decoded:unknown;try{decoded=await response.clone().json();}catch{persist(ordinal,'response',{index:ordinal,phase:'response_invalid',status:response.status});return response;}
  persist(ordinal,'response',{index:ordinal,phase:'returned',status:response.status,body:responseBody(decoded)});return response;
 };
 return {fetch,attempts:()=>index};
}

/** No-network verification through the pinned Bedrock SDK and ordinary adapter.
 * The injected fetch consumes fake signed requests; no installed credentials.
 */
export async function verifyConverseCaptureOffline(directory:string){
 const prose='The note says "Friday"; path C:\\repairs; café ☃. The contract promise —';
 const candidate={claims:[{text:prose,kind:'fact',citationWindowIds:['w1']}],abstained:false};
 const expected=JSON.stringify(candidate),windowId='ffcc9956-a5cd-41c9-94e7-38fe812fc93e';
 const transcript=[{windows:[{id:windowId,ordinal:1,text:prose,source:{kind:'selected_note',sourceId:'3ac6940a-b38d-4506-b318-f3c18c8bac35',revision:1,occurredAt:null,observedAt:'2026-10-12T00:00:00Z'}}]}];
 const capture=createConverseCapture({directory,fetch:async()=>new Response(JSON.stringify({output:{message:{role:'assistant',content:[{reasoningContent:{reasoningText:{text:'PRIVATE REASONING MUST NOT BE RETAINED',signature:'PRIVATE SIGNATURE'}}},{text:expected},{toolUse:{toolUseId:'offline-final',name:'emit_answer',input:candidate}}]}},usage:{inputTokens:30,outputTokens:10,totalTokens:40},stopReason:'end_turn',metrics:{latencyMs:1}}),{headers:{'content-type':'application/json'}})});
 type Factory=(settings:{region:string;credentialProvider:()=>Promise<{accessKeyId:string;secretAccessKey:string}>;fetch:SdkFetch})=>(id:string)=>ReturnType<typeof createBedrockAskSdkModel>;
 const require=createRequire(new URL('../../../apps/worker/package.json',import.meta.url));
 const factory=z.object({createAmazonBedrock:z.custom<Factory>(value=>typeof value==='function')}).parse(require('@ai-sdk/amazon-bedrock')).createAmazonBedrock;
 const model=factory({region:'us-east-1',credentialProvider:async()=>({accessKeyId:'offline-controlled',secretAccessKey:'offline-controlled'}),fetch:capture.fetch})('us.anthropic.claude-sonnet-4-6');
 const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:model.modelId,providerKey:'offline-capture',model});
 const outcome=await adapter.runStep({question:'Offline capture verification',transcript,remainingSteps:1,maxOutputTokens:1000,signal:new AbortController().signal});
 if(capture.attempts()!==1||outcome.acceptance!=='accepted'||!z.object({claims:z.array(z.object({text:z.literal(prose),kind:z.literal('fact'),citationWindowIds:z.tuple([z.literal(windowId)])})).length(1),abstained:z.literal(false)}).safeParse(outcome.answer).success)throw new Error('diagnostic_offline_capture_failed');
 const retained=readFileSync(join(directory,'0001-response.json'),'utf8');
 const saved=z.object({body:z.object({output:z.object({message:z.object({content:z.array(z.object({text:z.string().optional(),toolUse:z.unknown().optional()}).strict())})})})}).parse(JSON.parse(retained));
 const tool=z.object({toolUseId:z.literal('offline-final'),name:z.literal('emit_answer'),input:z.unknown()}).parse(saved.body.output.message.content.find(block=>block.toolUse!==undefined)?.toolUse);
 if(JSON.stringify(tool.input)!==JSON.stringify(candidate)||!saved.body.output.message.content.some(block=>block.text===expected)||retained.includes('PRIVATE REASONING')||retained.includes('PRIVATE SIGNATURE'))throw new Error('diagnostic_capture_redaction_failed');
 return {attempts:capture.attempts(),acceptance:outcome.acceptance,expectedText:expected,expectedProse:prose};
}
