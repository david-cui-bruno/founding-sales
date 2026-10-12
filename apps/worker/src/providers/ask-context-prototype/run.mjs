// THROWAWAY fixed-frame comparison. No product execution, tool execution or activation.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {syntheticPaidBudget} from '../../../test/support/syntheticPaidBudget.ts';
import {compactNativeBody} from './compact.mjs';
const require=createRequire(new URL('../../../package.json',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function inventory(body){
 const originals=[],observations=[];
 const visit=value=>{
  if(Array.isArray(value)){value.forEach(visit);return;}
  if(!value||typeof value!=='object')return;
  if(typeof value.id==='string'&&/^w[1-9]\d*$/.test(value.id)&&value.source&&typeof value.text==='string')originals.push(value);
  if(Array.isArray(value.windows))for(const w of value.windows)originals.push(w);
  if(value.evidenceAuthority?.kind==='current_exact_crm_state')observations.push(value);
 };
 for(const m of body.messages)for(const b of m.content){
  if(b.text){const v=JSON.parse(b.text);if(v.context)v.context.forEach(visit);}
  if(b.toolResult)for(const c of b.toolResult.content)if(c.text)visit(JSON.parse(c.text));
 }
 return {originals,observations};
}
function validatePair(body){
 if(body.inferenceConfig?.maxTokens!==1000||body.additionalModelRequestFields?.thinking?.type!=='disabled'||body.toolConfig?.tools.filter(t=>t.toolSpec?.name==='emit_answer'&&t.toolSpec.strict===true).length!==1)throw new Error('frozen_policy_changed');
 const compact=compactNativeBody(body);
 if(!same({...body,messages:null},{...compact,messages:null}))throw new Error('non_context_delta');
 const payloads=compact.messages.flatMap(m=>m.content.flatMap(b=>b.text?[JSON.parse(b.text).context??[]]:b.toolResult?b.toolResult.content.filter(c=>c.text).map(c=>JSON.parse(c.text)):[]));
 const records=payloads.flat(),originals=records.flatMap(p=>p.originals??[]),observations=records.flatMap(p=>p.observations??[]),old=inventory(body);
 if(originals.length!==old.originals.length||observations.length!==old.observations.length)throw new Error('evidence_lost');
 for(const w of old.originals){const fresh=originals.find(x=>x.id===w.id);if(!fresh||fresh.text!==w.text||fresh.kind!==w.source.kind||fresh.navigation.sourceId!==w.source.sourceId||!same(fresh.dates,w.sourceMetadata))throw new Error('original_changed');}
 for(const o of old.observations){const fresh=observations.find(x=>x.id===o.evidenceAuthority.toolCallId);if(!fresh||!same(fresh.queryScope,o.scope))throw new Error('observation_scope_changed');for(const key of Object.keys(o).filter(k=>!['evidenceAuthority','answerGuidance','scope','coverage'].includes(k)))if(!same(o[key],fresh.value[key]))throw new Error('observation_changed');}
 for(let i=0;i<body.messages.length;i++)for(let j=0;j<body.messages[i].content.length;j++){const a=body.messages[i].content[j],b=compact.messages[i].content[j];if(a.toolUse&&!same(a,b))throw new Error('tool_argument_changed');}
 return {compact,originalIds:new Set(old.originals.map(w=>w.id)),exactIds:new Set(old.observations.map(o=>o.evidenceAuthority.toolCallId))};
}
function candidate(raw,allowed){
 const calls=(raw.output?.message?.content??[]).filter(b=>b.toolUse).map(b=>b.toolUse);
 if(raw.stopReason!=='tool_use'||calls.length!==1||calls[0].name!=='emit_answer')return {state:'nonterminal',candidate:null};
 const v=calls[0].input;
 const valid=v&&Object.keys(v).every(k=>['claims','abstained'].includes(k))&&typeof v.abstained==='boolean'&&Array.isArray(v.claims)&&v.claims.length<=20&&(!v.abstained||v.claims.length===0)&&v.claims.every(c=>c&&Object.keys(c).every(k=>['text','kind','citationWindowIds','exactResultToolCallIds'].includes(k))&&typeof c.text==='string'&&c.text.length>=1&&c.text.length<=1000&&['fact','inference','conflict'].includes(c.kind)&&Array.isArray(c.citationWindowIds)&&c.citationWindowIds.length>=1&&c.citationWindowIds.length<=10&&new Set(c.citationWindowIds).size===c.citationWindowIds.length&&c.citationWindowIds.every(id=>allowed.originalIds.has(id))&&(c.exactResultToolCallIds===undefined||Array.isArray(c.exactResultToolCallIds)&&c.exactResultToolCallIds.length>=1&&c.exactResultToolCallIds.length<=10&&new Set(c.exactResultToolCallIds).size===c.exactResultToolCallIds.length&&c.exactResultToolCallIds.every(id=>allowed.exactIds.has(id))));
 return {state:valid?'raw_candidate':'invalid_candidate',candidate:valid?v:null,knownDraftSuffix:valid&&v.claims.some(c=>c.text.trimEnd().endsWith('('))};
}
const scopeFile=process.env['FSS_COMPACT_SCOPE'];if(!scopeFile)throw new Error('frozen_scope_required');
const bytes=readFileSync(scopeFile),scope=JSON.parse(bytes),frames=[];
for(const f of scope.frames){const bytes=readFileSync(f.path);if(sha(bytes)!==f.sha256)throw new Error('frame_changed');const body=JSON.parse(bytes).body;frames.push({...f,body,checked:validatePair(body)});}
if(process.argv.includes('--dry-run')){
 console.log(JSON.stringify({network:'none',frames:frames.map(f=>({caseId:f.caseId,baselineBytes:Buffer.byteLength(JSON.stringify(f.body)),compactBytes:Buffer.byteLength(JSON.stringify(f.checked.compact)),originals:f.checked.originalIds.size,observations:f.checked.exactIds.size,onlyChange:'message evidence view'}))},null,2));
}else{
 if(process.env['FSS_RUN_APPROVED_COMPACT']!=='1')throw new Error('paid_opt_in_required');
 const campaign=JSON.parse(readFileSync('.context/roadmap-audit-20261011/model-comparison-campaign/campaign.json'));
 const grant=campaign.grants.find(g=>g.runId===scope.runId);
 const ids=['dev_01','dev_05','dev_06','dev_08','dev_10','dev_11'];
 if(!grant||grant.state!=='reserved_before_dispatch'||grant.scopeSha256!==sha(bytes)||scope.maxCalls!==24||scope.maxCents!==500||scope.repetitions!==2||scope.modelVersion!=='us.anthropic.claude-sonnet-4-6'||!same(frames.map(f=>f.caseId),ids))throw new Error('exact_campaign_scope_required');
 if(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()!==scope.sourceCommit)throw new Error('source_changed');
 for(const required of ['apps/worker/src/providers/ask-context-prototype/compact.mjs','apps/worker/src/providers/ask-context-prototype/run.mjs','apps/worker/test/support/syntheticPaidBudget.ts','package-lock.json'])if(!scope.sourceSha256[required])throw new Error('critical_manifest_missing');
 for(const [path,digest] of Object.entries(scope.sourceSha256))if(sha(readFileSync(path))!==digest)throw new Error('source_changed');
 const folder=resolve('.context',`compact-context-${scope.runId}`);mkdirSync(folder,{mode:0o700});writeFileSync(join(folder,'scope.json'),bytes,{mode:0o600,flag:'wx'});
 const budget=syntheticPaidBudget({maxSteps:24,maxCents:500,inputTokenPriceMicros:6,outputTokenPriceMicros:30,persist:v=>writeFileSync(join(folder,'budget.json'),JSON.stringify(v),{mode:0o600})});
 const {BedrockRuntimeClient,ConverseCommand}=require('@aws-sdk/client-bedrock-runtime');
 const client=new BedrockRuntimeClient({region:'us-east-1',maxAttempts:1,requestHandler:{requestTimeout:60000,connectionTimeout:5000}});
 const results=[];let phase='running';const save=()=>writeFileSync(join(folder,'results.json'),JSON.stringify({phase,budget:budget.snapshot(),results},null,2),{mode:0o600});
 try{
  for(let repetition=1;repetition<=2;repetition++)for(let i=0;i<frames.length;i++)for(const arm of ((repetition+i)%2===0?['baseline','compact']:['compact','baseline'])){
   const frame=frames[i],body=arm==='compact'?frame.checked.compact:frame.body,row={caseId:frame.caseId,repetition,arm,state:'not_dispatched',requestSha256:sha(JSON.stringify(body)),requestBytes:Buffer.byteLength(JSON.stringify(body))};results.push(row);save();const started=Date.now();let raw;
   try{raw=await budget.run({...body,modelId:scope.modelVersion},1000,async()=>{row.state='dispatched_unknown';save();return client.send(new ConverseCommand({...body,modelId:scope.modelVersion}),{abortSignal:AbortSignal.timeout(60000)});});}
   catch{row.state=budget.snapshot().startedSteps===results.length?'unknown_acceptance':'preflight_refused';phase=row.state==='unknown_acceptance'?'unknown_acceptance_stopped':'preflight_stopped';save();throw new Error(phase);}
   const u=raw.usage;if(!u||![u.inputTokens,u.outputTokens].every(n=>Number.isSafeInteger(n)&&n>=0)||u.outputTokens>1000||(u.cacheWriteInputTokens??0)>0){row.state='unknown_usage';phase='unknown_acceptance_stopped';save();throw new Error(phase);}
   row.response={stopReason:raw.stopReason,usage:u,output:{message:{content:(raw.output?.message?.content??[]).filter(b=>b.text!==undefined||b.toolUse!==undefined).map(b=>b.toolUse?{toolUse:{toolUseId:b.toolUse.toolUseId,name:b.toolUse.name,input:b.toolUse.input}}:{text:b.text})}}};
   Object.assign(row,candidate(row.response,frame.checked),{durationMs:Date.now()-started});save();
  }
  phase='complete_candidates_codex_review_pending';save();
 }finally{client.destroy();writeFileSync(join(folder,'run-status.json'),JSON.stringify({phase,budget:budget.snapshot(),qualityAccepted:false,productionActivation:false}),{mode:0o600});}
 console.log(JSON.stringify({folder,phase,budget:budget.snapshot()}));
}
