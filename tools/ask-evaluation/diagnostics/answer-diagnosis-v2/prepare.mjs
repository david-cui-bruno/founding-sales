// Offline preparation only: no provider import, credentials, transport or dispatch.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {inspectProse} from './format.mjs';
const root=dirname(new URL(import.meta.url).pathname);
const sha=value=>createHash('sha256').update(value).digest('hex');
const read=name=>readFileSync(resolve(root,name));
const common=read('semantic-guidance.txt').toString();
const completions={structured:read('structured-completion.txt').toString(),prose:read('prose-completion.txt').toString()};
const strictTool=JSON.parse(read('structured-tool.json'));
if(strictTool.toolSpec?.name!=='emit_answer'||strictTool.toolSpec.strict!==true)throw new Error('strict_grammar_missing');
const models=[{key:'sonnet',modelId:'us.anthropic.claude-sonnet-4-6',inputMicros:6.6,outputMicros:33},{key:'haiku',modelId:'us.anthropic.claude-haiku-4-5-20251001-v1:0',inputMicros:2.2,outputMicros:11}];
const ids=new Set(),cases=[];
for(const split of ['development','reserved']){
 const data=JSON.parse(read(`${split}.json`));
 if(data.version!=='answer-diagnosis-v2'||data.split!==split||data.cases.length!==6)throw new Error('fixture_manifest_invalid');
 for(const c of data.cases){
  if(ids.has(c.caseId)||typeof c.question!=='string'||!c.question.trim()||!c.requiredFacts.length||!c.forbiddenClaims.length)throw new Error('case_invalid');ids.add(c.caseId);
  const refs=[...c.evidence.originals.map(o=>o.ref),...c.evidence.observations.map(o=>o.ref),...c.evidence.coverage.ref?[c.evidence.coverage.ref]:[]];
  if(new Set(refs).size!==refs.length||refs.some(r=>!/^([we])[1-9]\d*$/u.test(r)))throw new Error('reference_registry_invalid');
  if(c.evidence.originals.some(o=>!/^w[1-9]\d*$/u.test(o.ref)||!['selected_note','mail'].includes(o.kind)||typeof o.text!=='string')||c.evidence.observations.some(o=>!/^e[1-9]\d*$/u.test(o.ref)))throw new Error('authority_kind_invalid');
  if(c.evidence.coverage.authority==='synthetic_host_observation'&&!c.evidence.coverage.ref)throw new Error('coverage_has_no_reference');
  if(c.referenceAnswer.references.some(r=>!refs.includes(r))||!c.referenceAnswer.references.length||!c.referenceAnswer.text.trim())throw new Error('reference_solution_invalid');
  const markers=[...c.referenceAnswer.text.matchAll(/\[([we]\d+)\]/gu)].map(m=>m[1]);
  if(!markers.length||c.referenceAnswer.references.some(r=>!markers.includes(r))||markers.some(r=>!c.referenceAnswer.references.includes(r)))throw new Error('unknown_reference_solution_marker');
  const golden=inspectProse({text:c.referenceAnswer.text,stopReason:'end_turn',hasToolCalls:false,originals:new Set(c.evidence.originals.map(o=>o.ref)),exacts:new Set(refs.filter(ref=>ref.startsWith('e')))});
  if(!golden.valid)throw new Error('reference_solution_fails_prose_grader');
  cases.push({...c,split,refs});
 }
}
const target=process.argv[2];if(!target)throw new Error('usage: node prepare.mjs /absolute/new-output-directory');
const output=resolve(target);mkdirSync(output,{mode:0o700});
const rows=[];
for(let repetition=1;repetition<=2;repetition++)for(let index=0;index<cases.length;index++){
 const c=cases[index],order=(index+repetition)%2?[[models[0],'structured'],[models[1],'prose'],[models[0],'prose'],[models[1],'structured']]:[[models[1],'structured'],[models[0],'prose'],[models[1],'prose'],[models[0],'structured']];
 for(const [model,format] of order){
  const context={question:c.question,evidence:c.evidence,referenceRegistry:c.refs,fixtureClass:'synthetic_gold_context_not_production_observation'};
  // Both formats receive byte-identical question/evidence. Grading labels and
  // reference answers are never included in the model-facing context.
  const body={modelId:model.modelId,system:[{text:common+'\n\n'+completions[format]}],messages:[{role:'user',content:[{text:JSON.stringify(context)}]}],inferenceConfig:{maxTokens:1000},additionalModelRequestFields:{thinking:{type:'disabled'}},...format==='structured'?{toolConfig:{tools:[strictTool],toolChoice:{tool:{name:'emit_answer'}}}}:{}};
  const serialized=JSON.stringify(body),bound=Buffer.byteLength(serialized)+2048;
  if(bound>30000)throw new Error('conservative_input_ceiling_exceeded');
  const allocationCents=Math.ceil((bound*model.inputMicros+1000*model.outputMicros)/10000);
  const filename=`${String(rows.length+1).padStart(3,'0')}-${c.caseId}-${model.key}-${format}-${repetition}.json`;
  writeFileSync(resolve(output,filename),JSON.stringify(body,null,2)+'\n',{mode:0o600,flag:'wx'});
  rows.push({caseId:c.caseId,split:c.split,repetition,model:model.key,format,filename,requestSha256:sha(serialized),fileSha256:sha(readFileSync(resolve(output,filename))),inputByteBound:bound,allocationCents});
 }
}
if(rows.length!==96)throw new Error('comparison_matrix_invalid');
const files=['prepare.mjs','format.mjs','development.json','reserved.json','semantic-guidance.txt','structured-completion.txt','prose-completion.txt','structured-tool.json'];
const manifest={version:'answer-diagnosis-v2-preparation',status:'prepared_offline_not_authorized_for_dispatch',issue:551,region:'us-east-1',maxCalls:96,maxCents:1500,conservativePreparedAllocationCents:rows.reduce((sum,r)=>sum+r.allocationCents,0),models,files:Object.fromEntries(files.map(name=>[name,sha(read(name))])),limits:['synthetic gold context only','no Gmail/customer data','no tools executed or production publication','two formats by two existing AWS models','two repetitions of 12 cases','one attempt per cell; stop on ambiguous dispatch/usage','no quality or activation acceptance'],interpretation:'Format factor includes its completion instructions and output mode; this is not a pure JSON-only or whole-harness comparison. Coverage observations simulate known host data, not implemented production reads.',rows};
if(manifest.conservativePreparedAllocationCents>manifest.maxCents)throw new Error('prepared_envelope_exceeds_proposal');
writeFileSync(resolve(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
writeFileSync(resolve(output,'reference-solutions.json'),JSON.stringify(cases.map(c=>({caseId:c.caseId,split:c.split,referenceAnswer:c.referenceAnswer,requiredFacts:c.requiredFacts,forbiddenClaims:c.forbiddenClaims,gradingNotes:c.gradingNotes})),null,2)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify({network:'none',providerCalls:0,cases:cases.length,preparedRequests:rows.length,conservativeAllocationCents:manifest.conservativePreparedAllocationCents,maxCalls:manifest.maxCalls,maxCents:manifest.maxCents,output},null,2));
