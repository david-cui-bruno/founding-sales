// Synthetic-only diagnostic, not a product execution/activation path.
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {syntheticPaidBudget} from '../../../apps/worker/test/support/syntheticPaidBudget.ts';
import {verifyConverseCaptureOffline} from './capture-converse.ts';
const require=createRequire(new URL('../../../apps/worker/package.json',import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
const keys=['system','messages','toolConfig','inferenceConfig','additionalModelRequestFields','additionalModelResponseFieldPaths'];
export function pairBody(body,strict){
 if(Object.keys(body).some(key=>!keys.includes(key))||body.inferenceConfig?.maxTokens!==1000||body.additionalModelRequestFields?.thinking?.type!=='disabled')throw new Error('diagnostic_body_not_frozen');
 const copy=structuredClone(body);const tools=copy.toolConfig?.tools;if(!Array.isArray(tools))throw new Error('diagnostic_tools_missing');
 const matches=tools.filter(tool=>tool.toolSpec?.name==='emit_answer');if(matches.length!==1||matches[0].toolSpec.strict!==true)throw new Error('diagnostic_emit_tool_missing');
 matches[0].toolSpec.strict=strict;return copy;
}
function rawAnswer(body){
 const blocks=body.output?.message?.content;
 if(!Array.isArray(blocks))return {state:'invalid_response',candidate:null};
 const calls=blocks.filter(block=>block.toolUse);const emitted=calls.filter(block=>block.toolUse.name==='emit_answer');
 if(body.stopReason!=='tool_use'||emitted.length!==1||calls.length!==1)return {state:'not_terminal_generation',candidate:null};
 const value=emitted[0].toolUse.input;
 const valid=value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.abstained==='boolean'&&Array.isArray(value.claims)&&value.claims.length<=20&&value.claims.every(c=>typeof c.text==='string'&&c.text.length>0&&c.text.length<=1000&&['fact','inference','conflict'].includes(c.kind)&&Array.isArray(c.citationWindowIds)&&c.citationWindowIds.length>=1&&c.citationWindowIds.length<=10);
 return {state:valid?'candidate':'invalid_candidate',candidate:valid?value:null};
}
async function offline(){
 const folder=mkdtempSync(join(tmpdir(),'callie-strict-preflight-'));try{
  await verifyConverseCaptureOffline(folder);
  const body=JSON.parse(readFileSync(join(folder,'0001-request.json'),'utf8')).body;
  const on=pairBody(body,true),off=pairBody(body,false);off.toolConfig.tools.find(x=>x.toolSpec.name==='emit_answer').toolSpec.strict=true;
  if(JSON.stringify(on)!==JSON.stringify(body)||JSON.stringify(on)!==JSON.stringify(off))throw new Error('diagnostic_non_strict_delta');
  console.log(JSON.stringify({network:'fake only',singleDelta:'emit_answer.strict',requestBytes:Buffer.byteLength(JSON.stringify(body))}));
 }finally{rmSync(folder,{recursive:true,force:true});}
}
async function paid(){
 if(process.env['FSS_RUN_APPROVED_STRICT_PAIRS']!=='1')throw new Error('paid_diagnostic_opt_in_required');
 const file=process.env['FSS_STRICT_PAIRS_SCOPE'];if(!file)throw new Error('scope_required');
 const bytes=readFileSync(file),scope=JSON.parse(bytes),campaign=JSON.parse(readFileSync('.context/roadmap-audit-20261011/model-comparison-campaign/campaign.json','utf8'));
 const grant=campaign.grants.find(x=>x.runId===scope.runId);
 if(!grant||grant.state!=='reserved_before_dispatch'||grant.scopeSha256!==hash(bytes)||scope.modelVersion!=='us.anthropic.claude-sonnet-4-6'||scope.maxCalls!==12||scope.maxCents!==300||scope.repetitions!==2||JSON.stringify(scope.caseIds)!==JSON.stringify(['dev_08','dev_10','dev_11']))throw new Error('exact_campaign_scope_required');
 if(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()!==scope.sourceCommit)throw new Error('source_changed');
 const requiredSources=['tools/ask-evaluation/diagnostics/strict-pairs.mjs','tools/ask-evaluation/diagnostics/capture-converse.ts','apps/worker/test/support/syntheticPaidBudget.ts'];
 if(requiredSources.some(path=>!scope.sourceSha256[path]))throw new Error('critical_source_manifest_missing');
 for(const [path,digest] of Object.entries(scope.sourceSha256))if(hash(readFileSync(path))!==digest)throw new Error('source_changed');
 const frozen=[];for(const cell of scope.frames){const original=readFileSync(cell.path);if(hash(original)!==cell.sha256)throw new Error('captured_frame_changed');const frame=JSON.parse(original);pairBody(frame.body,true);frozen.push({...cell,body:frame.body});}
 if(frozen.length!==3||JSON.stringify(frozen.map(x=>x.caseId))!==JSON.stringify(scope.caseIds))throw new Error('frame_scope_changed');
 const folder=resolve('.context',`strict-pairs-${scope.runId}`);mkdirSync(folder,{mode:0o700});writeFileSync(join(folder,'scope.json'),bytes,{flag:'wx',mode:0o600});
 const budget=syntheticPaidBudget({maxSteps:12,maxCents:300,inputTokenPriceMicros:6,outputTokenPriceMicros:30,persist:v=>writeFileSync(join(folder,'budget.json'),JSON.stringify(v),{mode:0o600})});
 const {BedrockRuntimeClient,ConverseCommand}=require('@aws-sdk/client-bedrock-runtime');
 const client=new BedrockRuntimeClient({region:'us-east-1',maxAttempts:1,requestHandler:{requestTimeout:60000,connectionTimeout:5000}});
 const results=[];let phase='running';
 const save=()=>writeFileSync(join(folder,'results.json'),JSON.stringify({phase,scopeSha256:hash(bytes),budget:budget.snapshot(),results},null,2),{mode:0o600});
 try{
  for(let repetition=1;repetition<=2;repetition++)for(let i=0;i<frozen.length;i++)for(const strict of ((repetition+i)%2===0?[true,false]:[false,true])){
   const frame=frozen[i],body=pairBody(frame.body,strict),row={caseId:frame.caseId,repetition,strict,state:'not_dispatched',requestSha256:hash(JSON.stringify(body))};results.push(row);save();
   const started=Date.now();
   let raw;
   try{raw=await budget.run({...body,modelId:scope.modelVersion},1000,async()=>{row.state='dispatched_unknown';save();return client.send(new ConverseCommand({...body,modelId:scope.modelVersion}),{abortSignal:AbortSignal.timeout(60000)});});}
   catch{row.state=budget.snapshot().startedSteps===results.length?'unknown_acceptance':'preflight_refused';phase=row.state==='unknown_acceptance'?'unknown_acceptance_stopped':'preflight_stopped';save();throw new Error(phase);}
   const u=raw.usage;
   if(!u||![u.inputTokens,u.outputTokens].every(n=>Number.isSafeInteger(n)&&n>=0)||(u.cacheWriteInputTokens??0)>0){row.state='unknown_usage';phase='unknown_acceptance_stopped';save();throw new Error(phase);}
   // Native response content/usage only, never transport headers or reasoning.
   row.response={stopReason:raw.stopReason,usage:u,output:{message:{content:(raw.output?.message?.content??[]).filter(block=>block.text!==undefined||block.toolUse!==undefined).map(block=>block.toolUse?{toolUse:{toolUseId:block.toolUse.toolUseId,name:block.toolUse.name,input:block.toolUse.input}}:{text:block.text})}}};
   Object.assign(row,rawAnswer(row.response),{durationMs:Date.now()-started});save();
  }
  phase='complete_candidates_codex_review_pending';save();
 }finally{client.destroy();writeFileSync(join(folder,'run-status.json'),JSON.stringify({phase,budget:budget.snapshot(),qualityAccepted:false,productionActivation:false}),{mode:0o600});}
 console.log(JSON.stringify({folder,phase,budget:budget.snapshot()}));
}
if(process.argv.includes('--dry-run'))await offline();else await paid();
