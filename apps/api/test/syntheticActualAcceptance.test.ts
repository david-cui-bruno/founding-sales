import {parseSyntheticHistoryFixtures,runSyntheticHistoryJourney,SYNTHETIC_HISTORY_UNKNOWN_ACCEPTANCE} from './support/syntheticHistoryJourney.ts';
import {parseSyntheticAskFixtures,prepareSyntheticAskFixture} from './support/syntheticAskFixtures.ts';
import {snapshotSyntheticAcceptanceSource,claimSharedSyntheticAcceptanceDirectory} from './support/syntheticSourceBinding.ts';
import {createConverseCapture} from '../../../tools/ask-evaluation/diagnostics/capture-converse.ts';
import {createBedrockAskSdkModel} from '../../worker/src/providers/askAgentSdk.ts';
import {loadCrmBedrockSurface} from '../../worker/src/providers/crmBedrock.ts';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';
import {selectedImportPageSchema} from '@fss/contracts';
import {REQUIRED_SCHEMA} from '@fss/domain/db/schemaRange.ts';
import {createCrmCapabilityRuntime,type CrmCapabilityStartupConfiguration} from '@fss/domain/crm/capabilityStartup.ts';
import {CRM_SUPPORTED_AGENT_ASK_VERSIONS} from '@fss/domain/crm/capabilityAuthority.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {composeCrmCapabilities} from '../../worker/src/bootstrap/crmCapabilities.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {syntheticPaidBudget} from '../../worker/test/support/syntheticPaidBudget.ts';
import {boundedActualBedrock} from '../../worker/test/support/boundedActualBedrock.ts';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm} from './support/crmSeed.ts';
import {validateSyntheticAcceptance,claimSyntheticAcceptanceDirectory,syntheticAskStageScope} from './support/syntheticAcceptanceApproval.ts';

const repository=fileURLToPath(new URL('../../../',import.meta.url));
const scopeFile=process.env['FSS_SYNTHETIC_SCOPE_FILE']?resolve(process.env['FSS_SYNTHETIC_SCOPE_FILE']!):resolve(repository,'.context/551-actual-synthetic-scope.json');
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
// This is a separately approved, opt-in paid acceptance. Required CI never calls a
// model. Expectations and original synthetic inputs are bound before dispatch;
// outputs are private human-review candidates, not automatic quality acceptance.
it.skipIf(process.env['FSS_RUN_APPROVED_SYNTHETIC_ACCEPTANCE']!=='1')('executes the exact approved synthetic scope through ordinary configured workers',async()=>{
 const scopeBytes=readFileSync(scopeFile);
 const approvalFile=process.env['FSS_SYNTHETIC_APPROVAL_FILE'];if(!approvalFile)throw new Error('exact_paid_scope_approval_required');
 const version=(JSON.parse(scopeBytes.toString()) as {scopeVersion?:unknown}).scopeVersion;
 const newFixtures=version===4,historyFixtures=version===5;
 const labelsBytes=readFileSync(resolve(repository,historyFixtures?'tools/ask-evaluation/fixtures/ask-history-continuity-v1.json':newFixtures?'tools/ask-evaluation/fixtures/ask-contract-v4.json':'tools/ask-evaluation/owner-provisional-labels.json'));
 const {scope,approval,pricing}=validateSyntheticAcceptance({scopeBytes,approvalBytes:readFileSync(approvalFile),labelsBytes,readSource:path=>readFileSync(resolve(repository,path)),...(newFixtures||historyFixtures)?{sourceTree:snapshotSyntheticAcceptanceSource(repository)}:{}});
 const labels=JSON.parse(labelsBytes.toString()) as {cases:{caseId:string;syntheticText:string;expectedOutcome:string;forbiddenOutcome:string;eventAt:string}[]};
 const chosen=historyFixtures?[]:scope.scopeVersion===4?parseSyntheticAskFixtures(labelsBytes).cases.map(item=>({caseId:item.id,firmName:item.firmName,expectedOutcome:item.expected.join(' '),forbiddenOutcome:item.forbidden.join(' '),syntheticText:'',eventAt:null,fixtureCase:item})):[...new Set([...scope.extractionIds,...scope.askIds])].map(id=>{const found=labels.cases.find(item=>item.caseId===id);if(!found)throw new Error('frozen_case_missing');return {...found,firmName:['dev_01','dev_06'].includes(found.caseId)?'Example Sales':`Synthetic ${found.caseId}`,fixtureCase:undefined};});
 const directory=(scope.scopeVersion===4||scope.scopeVersion===5)?claimSharedSyntheticAcceptanceDirectory(repository,scope.runId,sha(scopeBytes)):claimSyntheticAcceptanceDirectory(repository,scope.runId);
 writeFileSync(resolve(directory,'approved-scope.json'),scopeBytes,{mode:0o600,flag:'wx'});
 const budget=syntheticPaidBudget({maxSteps:scope.maxSteps,maxCents:scope.maxCents,inputTokenPriceMicros:pricing.inputTokenPriceMicros,outputTokenPriceMicros:pricing.outputTokenPriceMicros,persist:snapshot=>writeFileSync(resolve(directory,'aggregate-budget.json'),JSON.stringify(snapshot),{mode:0o600})});
 const fixture=await createAuthFixture();let phase='transport_probe';
 try{
  const observations:unknown[]=[];
  const capturedTransports=scope.scopeVersion!==undefined&&scope.scopeVersion>=3&&scope.captureNative===true?{model:createBedrockAskSdkModel({region:'us-east-1',modelVersion:scope.modelVersion,fetch:createConverseCapture({directory:resolve(directory,'native')}).fetch}),surface:await loadCrmBedrockSurface({region:'us-east-1',timeoutMilliseconds:30000})}:undefined;
  const actual=await boundedActualBedrock(budget,scope.modelVersion,observation=>{observations.push(scope.captureNative?{...observation,output:undefined}:observation);writeFileSync(resolve(directory,'private-transport-observations.json'),JSON.stringify(observations,null,2),{mode:0o600});},scope.scopeVersion!==undefined?{thinking:'disabled'}:undefined,capturedTransports);
  // One scoped, bounded transport probe precedes any truthful configured-model
  // attestation; it counts against the SAME aggregate ceiling and never uses Gmail.
  const probe=await actual.surface.converse({modelId:scope.modelVersion,system:[{text:'Return JSON only: []. No tools.'}],messages:[{role:'user',content:[{text:'Synthetic diagnostic transport probe. Return [].'}]}],inferenceConfig:{maxTokens:32,temperature:0},...(scope.scopeVersion!==undefined?{additionalModelRequestFields:{thinking:{type:'disabled'}}}:{})},new AbortController().signal);
  const observed=probe as {usage?:{inputTokens?:number;outputTokens?:number};output?:{message?:{content?:{text?:string}[]}}};
  if(!Number.isInteger(observed.usage?.inputTokens)||!Number.isInteger(observed.usage?.outputTokens)||!observed.output?.message?.content?.some(item=>item.text))throw new Error('actual_transport_not_observed');
  writeFileSync(resolve(directory,'transport-observation.json'),JSON.stringify({modelVersion:scope.modelVersion,scopeSha256:sha(scopeBytes),usage:observed.usage,syntheticOnly:true}),{mode:0o600});
  phase='configured_evaluation';
  const db=await fixture.database.appRuntimeSession();const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
  const route={
   region:'us-east-1' as const,
   endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,
   modelVersion:scope.modelVersion,
   providerKey:'synthetic',
   accessGrantVersion:'synthetic',
   dataHandlingVersion:'synthetic-only-US-geographic-profile-v1',
   fundingVerifiedUntil:new Date(Date.now()+900000).toISOString(),
  };
  const configuration:CrmCapabilityStartupConfiguration={capture:false,extraction:route,answer:{...route,agentLimits:{maxSteps:scope.maxAskSteps,maxInputBytes:scope.maxAskInputBytes,maxOutputTokens:scope.maxAskOutputTokens,deadlineMs:60000}}};
  const runtime=createCrmCapabilityRuntime(configuration,{implementationCommit:null,imageDigest:null,side:'api',schemaVersion:REQUIRED_SCHEMA,gmailAvailable:false});
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:db,auth:{...fixture.deps,db},supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmCapabilityRuntime:runtime});
  const command=(body:object)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
  const approvalDecision={consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:approval.reference,limitations:['representative_quality_unverified','limited_business_examples']};
  const common={enabled:false,expectedRevision:0,endpointId:route.endpointId,modelVersion:route.modelVersion,accessGrantVersion:route.accessGrantVersion,dataHandlingVersion:route.dataHandlingVersion,dailyCeilingCents:scope.maxCents,monthlyCeilingCents:scope.maxCents,inputTokenPriceMicros:Number.isInteger(pricing.inputTokenPriceMicros)?pricing.inputTokenPriceMicros:String(pricing.inputTokenPriceMicros),outputTokenPriceMicros:Number.isInteger(pricing.outputTokenPriceMicros)?pricing.outputTokenPriceMicros:String(pricing.outputTokenPriceMicros)};
  if(scope.extractionIds.length)expect((await post('/crm/processing/purpose/save',command(common))).status).toBe(200);

  expect((await post('/ask/purpose/save',command({...common,purpose:'answer',evaluationFingerprint:scope.labelsSha256,...CRM_SUPPORTED_AGENT_ASK_VERSIONS,agentLimits:configuration.answer!.agentLimits}))).status).toBe(200);
  const composed=await composeCrmCapabilities({configuration,runtime:{...runtime,side:'worker'},openSession:async()=>({session:await fixture.database.appRuntimeSession(),close:async()=>{}}),answerModel:actual.model,loadSurface:async()=>actual.surface});
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,...composed.handlers});
  const prepared=[];
  for(const item of chosen){
   const firmId=await seedFirm(fixture,{name:item.firmName,assignedUserId:fixture.alpha.admin.userId});
   if(item.fixtureCase){const result=await prepareSyntheticAskFixture(post,command,{workspaceId:fixture.alpha.workspaceId,firmId},item.fixtureCase);prepared.push({item,firmId,...result});continue;}
   if(item.caseId==='dev_06'){
    for(const name of ['North pilot','South pilot'])expect((await post('/opportunities/v2/open',command({firmId,name}))).status).toBe(200);
   }
   const selection={text:item.syntheticText,subtype:'pasted_text',label:`Frozen ${item.caseId}`,direction:'unknown',participants:[],occurredAt:item.eventAt,attachments:[]};
   const preview=await post('/crm/imports/preview',selection);expect(preview.status).toBe(200);
   expect((await post('/crm/imports/commit',command({...selection,personId:null,firmId,importKey:randomUUID(),previewHash:(preview.body as {previewHash:string}).previewHash,parserVersion:'selected-v1'}))).status).toBe(200);
   const imported=selectedImportPageSchema.parse((await post('/crm/imports/read',{firmId,limit:10})).body).imports[0]!;
   const source={workspaceId:imported.source.workspaceId,sourceId:imported.source.sourceId,kind:'selected_note',revision:imported.source.revision,contentHash:imported.source.contentHash,locator:null};
   prepared.push({item,firmId,sources:[{...source,kind:'selected_note' as const}],cleanupSources:[{...source,kind:'selected_note' as const,metadataRevision:imported.metadata.revision}],requestScope:syntheticAskStageScope(scope.stage,firmId,{...source,kind:'selected_note'}),seedObservation:{}});
  }
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',purpose:'answer',expectedRevision:1,approval:approvalDecision}))).body).toMatchObject({status:'accepted'});
  // All originals are committed under disabled extraction settings. Ordinary
  // workers may now process only the four explicit processing requests.
  if(scope.extractionIds.length)expect((await post('/crm/processing/purpose/activate',command({capability:'crm_extraction',expectedRevision:1,approval:approvalDecision}))).body).toMatchObject({status:'accepted'});
  if(historyFixtures){
   try{
    for(const item of parseSyntheticHistoryFixtures(labelsBytes).cases){
     await runSyntheticHistoryJourney({fixture,post,command,item,
      execute:async()=>{await runOnce(db,{registry,owner:'approved-synthetic-history',limit:10});},
      capture:captured=>writeFileSync(resolve(directory,`${captured.id}-${captured.phase}.json`),JSON.stringify({modelVersion:scope.modelVersion,scopeSha256:sha(scopeBytes),...captured},null,2),{mode:0o600,flag:'wx'}),
     });
    }
   }catch(error){if(error instanceof Error&&error.message===SYNTHETIC_HISTORY_UNKNOWN_ACCEPTANCE)phase='unknown_acceptance_stopped';throw error;}
   phase='complete_candidates_human_review_pending';return;
  }
  for(const {item,sources,cleanupSources,requestScope,seedObservation} of prepared){
   const outputs:Record<string,unknown>={caseId:item.caseId,expectedOutcome:item.expectedOutcome,forbiddenOutcome:item.forbiddenOutcome,humanQualityReview:'pending',modelVersion:scope.modelVersion,stage:scope.stage??'legacy_history_investigation',thinking:scope.thinking??'legacy_policy',pricing,inputLimitations:['selected_text_authorship_unverified','label_event_timezone_is_not_canonical_source_metadata; use only separately frozen question context or report unknown'],acquisition:'selected_unverified',seedObservation,evaluatedScope:requestScope};
   if(scope.extractionIds.includes(item.caseId)){
    const source=sources[0];if(!source)throw new Error('synthetic_extraction_original_required');
    expect((await post('/crm/processing/request',command({source}))).status).toBe(200);
    await runOnce(db,{registry,owner:'approved-synthetic-extraction',limit:10});
    outputs['extraction']=(await post('/crm/processing/read',{source})).body;
   }
   let askRequestId:string|undefined;
   if(scope.askIds.includes(item.caseId)){
    const requested=await post('/ask/answers/request',command({question:scope.askQuestions[item.caseId],execution:'agent_v1',...requestScope}));expect(requested.status).toBe(200);
    const requestId=(requested.body as {result:{requestId:string}}).result.requestId;askRequestId=requestId;
    await runOnce(db,{registry,owner:'approved-synthetic-ask',limit:10});
    outputs['ask']=(await post('/ask/answers/read',{requestId,includeExactResultCitations:true})).body;
    outputs['diagnostics']=(await post('/ask/answers/diagnostics',{requestId})).body;
   }
   writeFileSync(resolve(directory,`${item.caseId}.json`),JSON.stringify(outputs,null,2),{mode:0o600,flag:'wx'});
   // An ambiguous attempt keeps its full allocation and ends this batch. Do not
   // dispatch further cases against an unverified failing provider boundary.
   if(['ask','extraction'].some(key=>{const result=outputs[key];return typeof result==='object'&&result!==null&&'state' in result&&result.state==='unknown_acceptance';})){phase='unknown_acceptance_stopped';throw new Error('synthetic_unknown_acceptance_stopped');}
   for(const source of cleanupSources)expect((await post('/crm/imports/delete',command({sourceId:source.sourceId,expectedSourceRevision:source.revision,expectedMetadataRevision:source.metadataRevision}))).status).toBe(200);
   if(scope.scopeVersion===4&&askRequestId){
    const answer=await post('/ask/answers/read',{requestId:askRequestId,includeExactResultCitations:true});expect(answer.status).toBe(200);
    const history=await post('/ask/history/list',{});expect(history.status).toBe(200);
    writeFileSync(resolve(directory,`${item.caseId}-cleanup.json`),JSON.stringify({caseId:item.caseId,deletedSources:cleanupSources.map(source=>({sourceId:source.sourceId,revision:source.revision})),answer:answer.body,history:history.body},null,2),{mode:0o600,flag:'wx'});
    if(cleanupSources.length)expect(answer.body).toMatchObject({question:null,fallback:null,answer:null});
   }
  }
  phase='complete_candidates_human_review_pending';
 }finally{
  writeFileSync(resolve(directory,'run-status.json'),JSON.stringify({phase,scopeSha256:sha(scopeBytes),modelVersion:scope.modelVersion,stage:scope.stage??'legacy_history_investigation',thinking:scope.thinking??'legacy_policy',pricing,budget:budget.snapshot(),qualityAccepted:false,productionActivation:false}),{mode:0o600});
  await fixture.stop();
 }
},900000);
