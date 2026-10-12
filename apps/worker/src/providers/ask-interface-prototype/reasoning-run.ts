/** THROWAWAY: same Sonnet4.6 protocol, reasoning disabled versus adaptive. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createAskSdkStepAdapter} from '../askAgentSdk.ts';
import {wrapReasoningPolicy,preflightReasoningPolicy} from './reasoning-policy.ts';
import {boundedActualBedrock} from '../../../test/support/boundedActualBedrock.ts';
import {syntheticPaidBudget} from '../../../test/support/syntheticPaidBudget.ts';

const root=process.cwd(),folder='apps/worker/src/providers/ask-interface-prototype';
const fixtures=JSON.parse(readFileSync(resolve(root,folder,'fixtures.json'),'utf8'));
const paths=[folder+'/reasoning-run.ts',folder+'/reasoning-policy.ts',folder+'/fixtures.json','apps/worker/src/providers/askAgentSdk.ts','apps/worker/test/support/boundedActualBedrock.ts','apps/worker/test/support/syntheticPaidBudget.ts','apps/worker/src/providers/crmBedrock.ts','apps/worker/package.json','package-lock.json','tools/ask-evaluation/owner-provisional-labels.json'];
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const hashes=()=>Object.fromEntries(paths.map(path=>[path,sha(readFileSync(resolve(root,path)))]));
if(process.argv.includes('--dry-run')){
 const wire=await preflightReasoningPolicy(fixtures.cases[0].transcript);
 console.log(JSON.stringify({dispatch:false,wire,cases:6,repetitions:2,maxCalls:24,maxOutputTokens:4096,toolChoice:'auto',effort:'medium',sourceSha256:hashes()},null,2));process.exit(0);
}
if(process.env['FSS_RUN_APPROVED_REASONING_COMPARISON']!=='1')throw new Error('reasoning_dispatch_flag_required');
const scopeFile=process.env['FSS_REASONING_SCOPE_FILE'];if(!scopeFile)throw new Error('reasoning_scope_required');
const bytes=readFileSync(scopeFile),scope=JSON.parse(bytes.toString());
const campaign=JSON.parse(readFileSync(resolve(root,'.context/roadmap-audit-20261011/model-comparison-campaign/campaign.json'),'utf8'));
const grant=campaign.grants.find((g:any)=>g.runId===scope.runId);
if(!grant||grant.state!=='reserved_before_dispatch'||grant.scopeSha256!==sha(bytes)||scope.campaignId!==campaign.campaignId||scope.implementationCommit!==execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()||JSON.stringify(scope.sourceSha256)!==JSON.stringify(hashes()))throw new Error('reasoning_frozen_grant_mismatch');
if(scope.modelVersion!==fixtures.modelVersion||scope.labelsSha256!==fixtures.labelsSha256||scope.maxSteps!==24||scope.maxCents!==800||scope.maxOutputTokens!==4096||scope.repetitions!==2||scope.effort!=='medium'||scope.toolChoice!=='auto'||grant.maxCalls!==24||grant.maxCents!==800||campaign.reservedCalls>campaign.maxCalls||campaign.reservedCents>campaign.maxCents)throw new Error('reasoning_scope_limit_mismatch');
const directory=resolve(root,'.context','synthetic-acceptance-'+scope.runId);mkdirSync(directory,{mode:0o700});
writeFileSync(resolve(directory,'approved-scope.json'),bytes,{mode:0o600,flag:'wx'});
const budget=syntheticPaidBudget({maxSteps:24,maxCents:800,inputTokenPriceMicros:6,outputTokenPriceMicros:30,persist:b=>writeFileSync(resolve(directory,'aggregate-budget.json'),JSON.stringify(b),{mode:0o600})});
let phase='reasoning_comparison',activeCell:any=null;const rows:any[]=[];const transport:any[]=[];
const actual=await boundedActualBedrock(budget,scope.modelVersion,observation=>{
 const content=Array.isArray(observation.output)?observation.output:[];
 transport.push({cell:activeCell,phase:observation.phase,usage:observation.usage,errorCategory:observation.errorCategory,reasoningBlocks:content.filter(x=>x?.type==='reasoning').length,output:content.filter(x=>x?.type!=='reasoning')});
 writeFileSync(resolve(directory,'private-transport-observations.json'),JSON.stringify(transport,null,2),{mode:0o600});
});
const adapter=(mode:'disabled'|'adaptive')=>createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:scope.modelVersion,providerKey:'synthetic-reasoning-comparison',model:wrapReasoningPolicy(actual.model,mode)});
const adapters={baseline:adapter('disabled'),proposed:adapter('adaptive')};
function valid(answer:any,fixture:any){
 if(!answer||typeof answer.abstained!=='boolean'||!Array.isArray(answer.claims)||answer.claims.length>20||answer.abstained&&answer.claims.length)return false;
 const originals=new Set([fixture.window.id]),exacts=new Set(fixture.observations.map((o:any)=>o.toolCallId));
 return answer.claims.every((c:any)=>typeof c.text==='string'&&c.text.trim().length>0&&c.text.length<=1000&&['fact','inference','conflict'].includes(c.kind)&&Array.isArray(c.citationWindowIds)&&c.citationWindowIds.length>0&&c.citationWindowIds.length<=10&&new Set(c.citationWindowIds).size===c.citationWindowIds.length&&c.citationWindowIds.every((id:string)=>originals.has(id))&&(c.exactResultToolCallIds===undefined||Array.isArray(c.exactResultToolCallIds)&&c.exactResultToolCallIds.length>0&&c.exactResultToolCallIds.length<=10&&new Set(c.exactResultToolCallIds).size===c.exactResultToolCallIds.length&&c.exactResultToolCallIds.every((id:string)=>exacts.has(id))));
}
function persist(){writeFileSync(resolve(directory,'results.json'),JSON.stringify({prototype:true,experiment:'Sonnet4.6 reasoning off versus adaptive medium; same existing answer protocol',status:phase,modelVersion:scope.modelVersion,source:scope.implementationCommit,budget:budget.snapshot(),cases:fixtures.cases.map((f:any)=>({caseId:f.caseId,question:f.question,source:f.source,observations:f.observations,expectedOutcome:f.expectedOutcome,forbiddenOutcome:f.forbiddenOutcome,arms:{baseline:rows.filter(r=>r.caseId===f.caseId&&r.arm==='baseline'),proposed:rows.filter(r=>r.caseId===f.caseId&&r.arm==='proposed')}})),qualityAccepted:false,activation:false},null,2),{mode:0o600});}
try{
 for(let repetition=1;repetition<=2;repetition++)for(let index=0;index<fixtures.cases.length;index++){
  const fixture=fixtures.cases[index],order=(index+repetition)%2===0?['baseline','proposed']:['proposed','baseline'];
  for(const arm of order){
   activeCell={caseId:fixture.caseId,arm,repetition};const row:any={...activeCell,reasoning:arm==='baseline'?'disabled':'adaptive',state:'pending',answer:null,steps:[],durationMs:0};rows.push(row);persist();
   const current=adapters[arm as keyof typeof adapters],start=Date.now(),before=budget.snapshot(),request={question:fixture.question,transcript:structuredClone(fixture.transcript),remainingSteps:1,maxOutputTokens:4096,signal:AbortSignal.timeout(60000)};
   const bound=current.inputBound?.(request);if(!bound||bound.inputBytes+512>scope.maxInputBytes){row.state='input_bound_reached';persist();continue;}
   // The exact rewritten request is reserved by boundedActualBedrock, including
   // adaptive configuration, before dispatch. 512 bytes conservatively cover
   // the small policy delta in the existing SDK's request-byte guard.
   const outcome=await current.runStep(request);row.durationMs=Date.now()-start;const after=budget.snapshot();row.budget={startedSteps:after.startedSteps-before.startedSteps,allocatedCents:after.allocatedCents-before.allocatedCents};
   row.steps=[{step:1,acceptance:outcome.acceptance,usage:outcome.usage,toolNames:outcome.toolCalls.map(t=>t.name),inputBytes:bound.inputBytes+512}];
   row.reasoningBlocks=transport.filter(t=>t.cell?.caseId===fixture.caseId&&t.cell?.arm===arm&&t.cell?.repetition===repetition).reduce((sum,t)=>sum+t.reasoningBlocks,0);
   if(outcome.acceptance==='unknown'||outcome.usage===null){row.state='unknown_acceptance';phase='unknown_acceptance_stopped';persist();throw new Error('reasoning_unknown_acceptance_stopped');}
   if(outcome.acceptance!=='accepted')row.state='not_accepted';
   else if(outcome.usage.inputTokens>bound.maxInputTokens+512||outcome.usage.outputTokens>4096)row.state='usage_bound_exceeded';
   else if(outcome.toolCalls.length)row.state='unexpected_read_tool';
   else row.state=valid(outcome.answer,fixture)?'complete':'unsupported_answer';
   row.answer=row.state==='complete'?outcome.answer:null;row.rawCandidate=outcome.answer;persist();
  }
 }
 phase='complete_candidates_human_review_pending';
}finally{
 persist();writeFileSync(resolve(directory,'run-status.json'),JSON.stringify({phase,scopeSha256:sha(bytes),modelVersion:scope.modelVersion,stage:'gold_context',experiment:'reasoning_comparison',budget:budget.snapshot(),qualityAccepted:false,productionActivation:false}),{mode:0o600});
}
console.log(JSON.stringify({directory,phase,budget:budget.snapshot(),outputs:rows.length,complete:rows.filter(r=>r.state==='complete').length}));
