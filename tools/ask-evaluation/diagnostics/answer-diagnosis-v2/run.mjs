// Native diagnostic only. No host tool execution, product writes or publication.
import {readFileSync,writeFileSync,mkdirSync,realpathSync,existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {inspectProse} from './format.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const directory=process.argv[2];if(!directory)throw new Error('prepared_directory_required');
const prepared=resolve(directory),manifestBytes=readFileSync(join(prepared,'manifest.json')),manifest=JSON.parse(manifestBytes);
const expectedModels={sonnet:'us.anthropic.claude-sonnet-4-6',haiku:'us.anthropic.claude-haiku-4-5-20251001-v1:0'};
if(manifest.version!=='answer-diagnosis-v2-preparation'||manifest.maxCalls!==96||manifest.maxCents!==1500||manifest.region!=='us-east-1'||manifest.rows.length!==96)throw new Error('matrix_manifest_invalid');
const sourceRoot=dirname(new URL(import.meta.url).pathname);
const requiredFiles=['prepare.mjs','format.mjs','development.json','reserved.json','semantic-guidance.txt','structured-completion.txt','prose-completion.txt','structured-tool.json'];
if(requiredFiles.some(name=>!manifest.files?.[name]))throw new Error('critical_manifest_missing');
for(const [name,digest] of Object.entries(manifest.files)){if(!['prepare.mjs','format.mjs','development.json','reserved.json','semantic-guidance.txt','structured-completion.txt','prose-completion.txt','structured-tool.json'].includes(name)||sha(readFileSync(join(sourceRoot,name)))!==digest)throw new Error('source_manifest_changed');}
const cases=[...JSON.parse(readFileSync(join(sourceRoot,'development.json'))).cases,...JSON.parse(readFileSync(join(sourceRoot,'reserved.json'))).cases];
const loaded=manifest.rows.map(row=>{
 if(!/^\d{3}-(?:dev2|reserved2)_\d{2}-(?:sonnet|haiku)-(?:structured|prose)-[12]\.json$/u.test(row.filename))throw new Error('request_filename_invalid');
 const bytes=readFileSync(join(prepared,row.filename));if(sha(bytes)!==row.fileSha256)throw new Error('request_file_changed');
 const body=JSON.parse(bytes),fixture=cases.find(c=>c.caseId===row.caseId),input=JSON.parse(body.messages[0].content[0].text);
 if(!fixture||body.modelId!==expectedModels[row.model]||row.format!=='structured'&&row.format!=='prose'||body.inferenceConfig.maxTokens!==1000||body.additionalModelRequestFields.thinking.type!=='disabled'||sha(JSON.stringify(body))!==row.requestSha256||JSON.stringify(input.evidence)!==JSON.stringify(fixture.evidence)||input.question!==fixture.question)throw new Error('matrix_request_changed');
 const price=row.model==='sonnet'?{input:6.6,output:33}:{input:2.2,output:11};const inputBound=Buffer.byteLength(JSON.stringify(body))+2048;
 const reserve=Math.ceil((inputBound*price.input+1000*price.output)/10000);
 if(inputBound>30000||reserve!==row.allocationCents||inputBound!==row.inputByteBound)throw new Error('allocation_changed');
 const originals=new Set(fixture.evidence.originals.map(o=>o.ref)),exacts=new Set([...fixture.evidence.observations.map(o=>o.ref),...fixture.evidence.coverage.ref?[fixture.evidence.coverage.ref]:[]]);
 return {row,body,inputBound,reserve,originals,exacts};
});
if(new Set(loaded.map(f=>`${f.row.caseId}:${f.row.model}:${f.row.format}:${f.row.repetition}`)).size!==96||loaded.reduce((sum,f)=>sum+f.reserve,0)>1500)throw new Error('matrix_or_total_bound_changed');
if(process.env['FSS_EXECUTE_ANSWER_V2']!=='1'&&!process.argv.includes('--check-authority')){
 console.log(JSON.stringify({network:'none',providerCalls:0,requests:loaded.length,conservativeAllocationCents:loaded.reduce((sum,f)=>sum+f.reserve,0),status:'preflight_only_requires_fresh_authority'}));
}else{
 const authorityFile=process.env['FSS_ANSWER_V2_AUTHORITY'];if(!authorityFile)throw new Error('fresh_authority_required');
 const authorityBytes=readFileSync(authorityFile),authority=JSON.parse(authorityBytes);
 const canonicalAuthorityPath=realpathSync(authorityFile);
 if(!process.argv.includes('--check-authority')&&authority.diagnosticOnly!==false)throw new Error('nonfunded_receipt_cannot_dispatch');
 if(authority.authorityPath!==canonicalAuthorityPath)throw new Error('authority_location_changed');
 if(authority.approved!==true||typeof authority.approvalReference!=='string'||!authority.approvalReference.trim()||authority.maxCalls!==96||authority.maxCents!==1500||authority.manifestSha256!==sha(manifestBytes)||authority.region!=='us-east-1'||authority.purpose!=='synthetic_answer_diagnosis_v2'||authority.sourceCommit!==execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()||!authority.sourceSha256?.['tools/ask-evaluation/diagnostics/answer-diagnosis-v2/run.mjs']||!authority.sourceSha256?.['package-lock.json']||!/^\w[\w-]{10,80}$/u.test(authority.runId))throw new Error('fresh_exact_authority_invalid');
 for(const [path,digest] of Object.entries(authority.sourceSha256))if(sha(readFileSync(path))!==digest)throw new Error('paid_source_changed');
 // Old campaign remains immutable. This exact new receipt funds only one matrix;
 // an exclusive run directory makes an unknown or completed run non-reusable.
 const output=join(dirname(canonicalAuthorityPath),`answer-v2-${authority.runId}`);
 if(process.argv.includes('--check-authority')){if(existsSync(output))throw new Error('authority_already_consumed');console.log(JSON.stringify({network:'none',providerCalls:0,status:'authority_preflight_only',output}));process.exit(0);}
 mkdirSync(output,{mode:0o700});writeFileSync(join(output,'authority.json'),authorityBytes,{mode:0o600,flag:'wx'});writeFileSync(join(output,'manifest.json'),manifestBytes,{mode:0o600,flag:'wx'});
 let startedCalls=0,allocatedCents=0,phase='running';const results=[];
 const save=()=>{writeFileSync(join(output,'budget.json'),JSON.stringify({startedCalls,allocatedCents}),{mode:0o600});writeFileSync(join(output,'results.json'),JSON.stringify({phase,startedCalls,allocatedCents,qualityAccepted:false,productionActivation:false,results},null,2),{mode:0o600});};
 const require=createRequire(new URL('../../../../apps/worker/package.json',import.meta.url));
 const {BedrockRuntimeClient,ConverseCommand}=require('@aws-sdk/client-bedrock-runtime');
 const client=new BedrockRuntimeClient({region:'us-east-1',maxAttempts:1,requestHandler:{requestTimeout:60000,connectionTimeout:5000}});
 try{
  save();for(const frame of loaded){
   if(startedCalls>=96||allocatedCents+frame.reserve>1500)throw new Error('fresh_matrix_limit_exceeded');
   startedCalls++;allocatedCents+=frame.reserve;const record={caseId:frame.row.caseId,split:frame.row.split,model:frame.row.model,format:frame.row.format,repetition:frame.row.repetition,state:'dispatched_unknown'};results.push(record);save();const start=Date.now();let raw;
   try{raw=await client.send(new ConverseCommand(frame.body),{abortSignal:AbortSignal.timeout(60000)});}catch{phase='unknown_acceptance_stopped';save();throw new Error(phase);}
   const content=(raw.output?.message?.content??[]).filter(c=>c.text!==undefined||c.toolUse!==undefined).map(c=>c.toolUse?{toolUse:{name:c.toolUse.name,input:c.toolUse.input}}:{text:c.text});
   record.response={stopReason:raw.stopReason,usage:raw.usage,content};record.durationMs=Date.now()-start;save();
   const u=raw.usage,caches=[u?.cacheReadInputTokens??0,u?.cacheWriteInputTokens??0];
   if(!u||![u.inputTokens,u.outputTokens,...caches].every(n=>Number.isSafeInteger(n)&&n>=0)||u.outputTokens>1000||u.inputTokens>frame.inputBound||u.inputTokens+caches[0]+caches[1]>frame.inputBound||caches.some(n=>n>frame.inputBound)||caches[1]>0){record.state='unknown_usage';phase='unknown_usage_stopped';save();throw new Error(phase);}
   if(frame.row.format==='prose'){
    const text=content.filter(c=>c.text!==undefined).map(c=>c.text).join('');const format=inspectProse({text,stopReason:raw.stopReason,hasToolCalls:content.some(c=>c.toolUse),originals:frame.originals,exacts:frame.exacts});
    record.state=format.valid?'raw_prose':'invalid_prose';record.text=text;record.references=format.references;
   }else{
    const calls=content.filter(c=>c.toolUse).map(c=>c.toolUse);const answer=calls.length===1&&calls[0].name==='emit_answer'?calls[0].input:null;
    const valid=raw.stopReason==='tool_use'&&answer&&Object.keys(answer).every(k=>['claims','abstained'].includes(k))&&typeof answer.abstained==='boolean'&&Array.isArray(answer.claims)&&answer.claims.length<=20&&(!answer.abstained||answer.claims.length===0)&&answer.claims.every(c=>c&&Object.keys(c).every(k=>['text','kind','citationWindowIds','exactResultToolCallIds'].includes(k))&&typeof c.text==='string'&&c.text.length>0&&c.text.length<=1000&&['fact','inference','conflict'].includes(c.kind)&&Array.isArray(c.citationWindowIds)&&c.citationWindowIds.length>=1&&c.citationWindowIds.length<=10&&new Set(c.citationWindowIds).size===c.citationWindowIds.length&&c.citationWindowIds.every(r=>frame.originals.has(r))&&(c.exactResultToolCallIds===undefined||Array.isArray(c.exactResultToolCallIds)&&c.exactResultToolCallIds.length>=1&&c.exactResultToolCallIds.length<=10&&new Set(c.exactResultToolCallIds).size===c.exactResultToolCallIds.length&&c.exactResultToolCallIds.every(r=>frame.exacts.has(r))));
    record.state=valid?'raw_candidate':'invalid_candidate';record.candidate=valid?answer:null;
   }
   save();
  }phase='complete_candidates_review_pending';save();
 }finally{client.destroy();writeFileSync(join(output,'run-status.json'),JSON.stringify({phase,startedCalls,allocatedCents,qualityAccepted:false,productionActivation:false}),{mode:0o600});}
 console.log(JSON.stringify({output,phase,startedCalls,allocatedCents}));
}
