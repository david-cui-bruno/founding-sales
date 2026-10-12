/** THROWAWAY: fixed synthetic context comparison, never a configured product run. */
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createAskSdkStepAdapter} from '../askAgentSdk.ts';
import {createProposedAdapter} from './proposed.ts';
import {boundedActualBedrock} from '../../../test/support/boundedActualBedrock.ts';
import {syntheticPaidBudget} from '../../../test/support/syntheticPaidBudget.ts';

const root=process.cwd();
const prototype='apps/worker/src/providers/ask-interface-prototype';
const fixtures=JSON.parse(readFileSync(resolve(root,prototype,'fixtures.json'),'utf8'));
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const paths=[prototype+'/run.ts',prototype+'/proposed.ts',prototype+'/fixtures.json','apps/worker/src/providers/askAgentSdk.ts','apps/worker/test/support/boundedActualBedrock.ts','apps/worker/test/support/syntheticPaidBudget.ts','tools/ask-evaluation/owner-provisional-labels.json','apps/worker/src/providers/crmBedrock.ts','apps/worker/package.json','package-lock.json'];
const hashes=()=>Object.fromEntries(paths.map(path=>[path,sha(readFileSync(resolve(root,path)))]));
if(process.argv.includes('--dry-run')){
 console.log(JSON.stringify({prototype:true,dispatch:false,cases:fixtures.cases.length,arms:2,repetitions:fixtures.repetitions,maxGenerations:fixtures.cases.length*2*fixtures.repetitions*fixtures.maxAskSteps,sourceSha256:hashes()},null,2));
 process.exit(0);
}
if(process.env['FSS_RUN_APPROVED_ASK_INTERFACE_PROTOTYPE']!=='1')throw new Error('explicit_prototype_dispatch_flag_required');
const scopeFile=process.env['FSS_PROTOTYPE_SCOPE_FILE'];if(!scopeFile)throw new Error('frozen_prototype_scope_required');
const scopeBytes=readFileSync(scopeFile),scope=JSON.parse(scopeBytes.toString());
const campaignPath=resolve(root,'.context/roadmap-audit-20261011/model-comparison-campaign/campaign.json');
const campaign=JSON.parse(readFileSync(campaignPath,'utf8'));
const grant=campaign.grants.find((g:any)=>g.runId===scope.runId);
if(!grant||grant.scopeSha256!==sha(scopeBytes)||grant.state!=='reserved_before_dispatch'||scope.campaignId!==campaign.campaignId||scope.maxSteps>grant.maxCalls||scope.maxCents>grant.maxCents)throw new Error('campaign_grant_mismatch');
if(scope.implementationCommit!==execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()||JSON.stringify(scope.sourceSha256)!==JSON.stringify(hashes())||scope.modelVersion!==fixtures.modelVersion||scope.labelsSha256!==fixtures.labelsSha256)throw new Error('frozen_prototype_source_mismatch');
if(campaign.reservedCalls>campaign.maxCalls||campaign.reservedCents>campaign.maxCents||scope.maxSteps>50||scope.maxCents>1000||scope.maxAskSteps!==2||scope.maxOutputTokens!==1000||scope.repetitions!==2)throw new Error('prototype_limit_mismatch');
const directory=resolve(root,'.context','synthetic-acceptance-'+scope.runId);
mkdirSync(directory,{mode:0o700}); // Exclusive claim: never replay a prior run.
writeFileSync(resolve(directory,'approved-scope.json'),scopeBytes,{mode:0o600,flag:'wx'});
const budget=syntheticPaidBudget({maxSteps:scope.maxSteps,maxCents:scope.maxCents,inputTokenPriceMicros:6,outputTokenPriceMicros:30,persist:value=>writeFileSync(resolve(directory,'aggregate-budget.json'),JSON.stringify(value),{mode:0o600})});
let phase='configured_prototype_comparison';
let activeCell:{caseId:string;arm:string;repetition:number}|null=null;
const rows:any[]=[];
const transport:any[]=[];
const actual=await boundedActualBedrock(budget,scope.modelVersion,value=>{transport.push({...value,cell:activeCell});writeFileSync(resolve(directory,'private-transport-observations.json'),JSON.stringify(transport,null,2),{mode:0o600});},{thinking:'disabled'});
const adapters={baseline:createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:scope.modelVersion,providerKey:'synthetic-prototype',model:actual.model}),proposed:createProposedAdapter({model:actual.model,modelVersion:scope.modelVersion})};
const exacts=(transcript:any[])=>transcript.filter(t=>t.name==='read_exact').map(t=>t.toolCallId);
function guard(arm:string,answer:any,transcript:any[],fixture:any){
 if(!answer||typeof answer.abstained!=='boolean')return false;
 const claims=arm==='baseline'?answer.claims:answer.passages;if(!Array.isArray(claims)||claims.length>20||answer.abstained&&claims.length)return false;
 const original=new Set([fixture.window.id]),observed=new Set(exacts(transcript));
 return claims.every((p:any)=>typeof p.text==='string'&&p.text.trim().length>0&&p.text.length<=1000&&(arm==='baseline'?
  ['fact','inference','conflict'].includes(p.kind)&&Array.isArray(p.citationWindowIds)&&p.citationWindowIds.length>0&&p.citationWindowIds.length<=10&&new Set(p.citationWindowIds).size===p.citationWindowIds.length&&p.citationWindowIds.every((id:string)=>original.has(id))&&(p.exactResultToolCallIds===undefined||Array.isArray(p.exactResultToolCallIds)&&p.exactResultToolCallIds.length>0&&p.exactResultToolCallIds.length<=10&&new Set(p.exactResultToolCallIds).size===p.exactResultToolCallIds.length&&p.exactResultToolCallIds.every((id:string)=>observed.has(id))):
  ['summary','inference','conflict'].includes(p.interpretation)&&Array.isArray(p.references)&&p.references.length>0&&p.references.length<=20&&new Set(p.references.map((r:any)=>r.kind+':'+r.id)).size===p.references.length&&p.references.every((r:any)=>r.kind==='source'?original.has(r.id):r.kind==='observation'&&observed.has(r.id))));
}
function execute(call:any,fixture:any){
 const value=call.input;if(!value||typeof value!=='object')throw new Error('invalid_fixture_read');
 if(call.name==='read_exact'){
  const observed=fixture.observations.find((o:any)=>o.operation===value.operation&&(!value.firmId||o.value.scope.firmId===value.firmId));
  if(!observed)throw new Error('fixture_observation_unavailable');
  return {...observed.value,evidenceAuthority:{kind:'current_exact_crm_state',toolCallId:call.id,citationAuthority:'exact_result_only',conversationCitationAllowed:false}};
 }
 if(call.name==='read_selected'){
  if(!Array.isArray(value.windowIds)||!value.windowIds.length||value.windowIds.length>20||value.windowIds.some((id:string)=>id!==fixture.window.id))throw new Error('fixture_source_refused');return [fixture.window];
 }
 if(call.name==='resolve_records')return {records:[],partial:true,nextAfter:null};
 if(!['search_selected','search_history','browse_history','read_conversation'].includes(call.name))throw new Error('fixture_tool_forbidden');
 if(call.name==='read_conversation'&&value.sourceId!==fixture.window.source.sourceId)throw new Error('fixture_source_refused');
 const matches=!call.name.startsWith('search')||typeof value.query==='string'&&value.query.split(/\s+/u).some((word:string)=>word.length>2&&fixture.source.toLowerCase().includes(word.toLowerCase()));
 return {windows:matches?[fixture.window]:[],partial:false,scope:fixture.transcript[0].scope,nextAfter:null,retrieval:'ranked_lexical',semantic:'unavailable',fixtureOnly:true};
}
function persist(){writeFileSync(resolve(directory,'results.json'),JSON.stringify({prototype:true,status:phase,modelVersion:scope.modelVersion,source:scope.implementationCommit,workload:fixtures.workload,budget:budget.snapshot(),scopeSha256:sha(scopeBytes),cases:fixtures.cases.map((f:any)=>({caseId:f.caseId,question:f.question,source:f.source,observations:f.observations,expectedOutcome:f.expectedOutcome,forbiddenOutcome:f.forbiddenOutcome,arms:{baseline:rows.filter(r=>r.caseId===f.caseId&&r.arm==='baseline'),proposed:rows.filter(r=>r.caseId===f.caseId&&r.arm==='proposed')}})),qualityAccepted:false,activation:false},null,2),{mode:0o600});}
try{
 for(let repetition=1;repetition<=fixtures.repetitions;repetition++)for(let index=0;index<fixtures.cases.length;index++){
  const fixture=fixtures.cases[index],order=(index+repetition)%2===0?['baseline','proposed']:['proposed','baseline'];
  for(const arm of order){
   activeCell={caseId:fixture.caseId,arm,repetition};const row:any={...activeCell,state:'pending',answer:null,steps:[],durationMs:0};rows.push(row);persist();
   const transcript=structuredClone(fixture.transcript),adapter=adapters[arm as keyof typeof adapters],start=Date.now(),before=budget.snapshot();
   for(let step=1;step<=scope.maxAskSteps;step++){
    const request={question:fixture.question,transcript,maxOutputTokens:scope.maxOutputTokens,remainingSteps:scope.maxAskSteps-step+1,signal:AbortSignal.timeout(60000)};
    const bound=adapter.inputBound?.(request);if(!bound||bound.inputBytes>scope.maxInputBytes){row.state='input_bound_reached';break;}
    const outcome=await adapter.runStep(request);row.steps.push({step,acceptance:outcome.acceptance,usage:outcome.usage,toolNames:outcome.toolCalls.map(t=>t.name),inputBytes:bound.inputBytes});
    if(outcome.acceptance==='unknown'||outcome.usage===null){row.state='unknown_acceptance';phase='unknown_acceptance_stopped';persist();throw new Error('prototype_unknown_acceptance_stopped');}
    if(outcome.acceptance!=='accepted'){row.state='not_accepted';break;}
    if(outcome.usage.inputTokens>bound.maxInputTokens||outcome.usage.outputTokens>scope.maxOutputTokens){row.state='usage_bound_exceeded';break;}
    if(outcome.toolCalls.length){
     if(step===scope.maxAskSteps){row.state='step_bound_reached';break;}
     try{for(const call of outcome.toolCalls)transcript.push({toolCallId:call.id,name:call.name,input:call.input,result:execute(call,fixture)});}catch{row.state='fixture_tool_refused';break;}continue;
    }
    row.state=guard(arm,outcome.answer,transcript,fixture)?'complete':'unsupported_answer';row.answer=row.state==='complete'?outcome.answer:null;row.rawCandidate=outcome.answer;break;
   }
   row.durationMs=Date.now()-start;const after=budget.snapshot();row.budget={startedSteps:after.startedSteps-before.startedSteps,allocatedCents:after.allocatedCents-before.allocatedCents};row.toolNames=[...new Set(row.steps.flatMap((s:any)=>s.toolNames))];persist();
  }
 }
 phase='complete_candidates_human_review_pending';
}finally{
 persist();writeFileSync(resolve(directory,'run-status.json'),JSON.stringify({phase,scopeSha256:sha(scopeBytes),modelVersion:scope.modelVersion,stage:'gold_context',workload:fixtures.workload,budget:budget.snapshot(),qualityAccepted:false,productionActivation:false}),{mode:0o600});
}
console.log(JSON.stringify({directory,phase,budget:budget.snapshot(),cells:rows.length,complete:rows.filter(r=>r.state==='complete').length}));
