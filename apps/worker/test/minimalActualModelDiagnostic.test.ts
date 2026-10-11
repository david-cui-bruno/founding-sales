import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {it} from 'vitest';
import {boundedActualBedrock} from './support/boundedActualBedrock.ts';
import {syntheticPaidBudget} from './support/syntheticPaidBudget.ts';
import {runMinimalModelDiagnostic,MINIMAL_ASK_DIAGNOSTIC_QUESTION} from './support/minimalModelDiagnostic.ts';
const repository=fileURLToPath(new URL('../../../',import.meta.url));
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
// Paid OFF by default. This is a separate fresh diagnostic scope; never reset or
// reuse the original cohort approval, allocation or exclusive run directory.
it.skipIf(process.env['FSS_RUN_APPROVED_MINIMAL_MODEL_DIAGNOSTIC']!=='1')('records two explicitly approved native synthetic transport observations',async()=>{
 const bytes=readFileSync(resolve(repository,'.context/551-minimal-model-diagnostic-scope.json'));
 const scope=JSON.parse(bytes.toString()) as {runId:string;implementationCommit:string;sourceSha256:Record<string,string>;modelVersion:string;caseId:string;labelsSha256:string;sourceText:string;question:string;maxSteps:number;maxCents:number;previousRun:{allocationSha256:string;startedSteps:number;allocatedCents:number}};
 const approvalFile=process.env['FSS_MINIMAL_MODEL_APPROVAL_FILE'];if(!approvalFile)throw new Error('fresh_minimal_scope_approval_required');
 const approval=JSON.parse(readFileSync(approvalFile,'utf8')) as {approved:boolean;approvedBy:string;scopeSha256:string;reference:string};
 if(approval.approved!==true||approval.approvedBy!=='David Cui'||approval.scopeSha256!==sha(bytes)||!approval.reference)throw new Error('fresh_minimal_scope_approval_required');
 const head=spawnSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'});if(head.status!==0||head.stdout.trim()!==scope.implementationCommit)throw new Error('approved_implementation_changed');
 for(const [path,fingerprint] of Object.entries(scope.sourceSha256))if(sha(readFileSync(resolve(repository,path)))!==fingerprint)throw new Error('approved_source_changed');
 if(scope.modelVersion!=='us.anthropic.claude-haiku-4-5-20251001-v1:0'||scope.maxSteps!==2||scope.maxCents!==10||scope.question!==MINIMAL_ASK_DIAGNOSTIC_QUESTION||!scope.sourceText||!/^[-a-f0-9]{36}$/u.test(scope.runId))throw new Error('minimal_scope_changed');
 const labelsBytes=readFileSync(resolve(repository,'tools/ask-evaluation/owner-provisional-labels.json'));
 const labels=JSON.parse(labelsBytes.toString()) as {cases:{caseId:string;syntheticText:string}[]};
 if(scope.caseId!=='dev_01'||sha(labelsBytes)!==scope.labelsSha256||labels.cases.find(item=>item.caseId===scope.caseId)?.syntheticText!==scope.sourceText)throw new Error('approved_synthetic_input_changed');
 const priorFile=resolve(repository,'.context/synthetic-acceptance-5536720d-0a77-4d5c-b5c1-7197e17ade05/aggregate-budget.json');
 const priorBytes=readFileSync(priorFile);const prior=JSON.parse(priorBytes.toString()) as {startedSteps:number;allocatedCents:number};
 if(sha(priorBytes)!==scope.previousRun.allocationSha256||prior.startedSteps!==scope.previousRun.startedSteps||prior.allocatedCents!==scope.previousRun.allocatedCents||prior.startedSteps+scope.maxSteps>25||prior.allocatedCents+scope.maxCents>100)throw new Error('cumulative_scope_changed');
 const directory=resolve(repository,'.context',`minimal-model-diagnostic-${scope.runId}`);mkdirSync(directory,{mode:0o700});
 writeFileSync(resolve(directory,'approved-scope.json'),bytes,{mode:0o600,flag:'wx'});
 writeFileSync(resolve(directory,'approval-record.json'),JSON.stringify(approval,null,2),{mode:0o600,flag:'wx'});
 const budget=syntheticPaidBudget({maxSteps:2,maxCents:10,persist:allocation=>writeFileSync(resolve(directory,'aggregate-budget.json'),JSON.stringify({allocation,cumulative:{startedSteps:prior.startedSteps+allocation.startedSteps,allocatedCents:prior.allocatedCents+allocation.allocatedCents}}),{mode:0o600})});
 const observations:unknown[]=[];
 let phase='preparing_transport';
 try{
  const actual=await boundedActualBedrock(budget,scope.modelVersion,observation=>{observations.push(observation);writeFileSync(resolve(directory,'private-transport-observations.json'),JSON.stringify(observations,null,2),{mode:0o600});});
  phase='native_diagnostic';
  const result=await runMinimalModelDiagnostic({modelVersion:scope.modelVersion,model:actual.model,surface:actual.surface,sourceText:scope.sourceText});
  phase=result.phase;
  writeFileSync(resolve(directory,'private-result.json'),JSON.stringify(result,null,2),{mode:0o600,flag:'wx'});
 }finally{
  writeFileSync(resolve(directory,'run-status.json'),JSON.stringify({phase,scopeSha256:sha(bytes),allocation:budget.snapshot(),cumulative:{startedSteps:prior.startedSteps+budget.snapshot().startedSteps,allocatedCents:prior.allocatedCents+budget.snapshot().allocatedCents},businessQualityAccepted:false,productionActivation:false}),{mode:0o600});
 }
},90000);
