import {REQUIRED_SCHEMA} from '@fss/domain/db/schemaRange.ts';
import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {crmProcessingResultSchema,selectedImportPageSchema} from '@fss/contracts';
import {createCrmCapabilityRuntime,type CrmCapabilityStartupConfiguration} from '@fss/domain/crm/capabilityStartup.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {composeCrmCapabilities} from '../../worker/src/bootstrap/crmCapabilities.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm,seedContact} from './support/crmSeed.ts';

// Frozen controlled expectations, authored independently of any provider output:
// a selected outgoing copy is NOT verified sent; a clear quoted promise is a
// suggestion until explicit human review; deletion removes its evidence/Today.
it.each([
 {observedAt:'2026-10-13T17:00:00Z',dueDate:'2026-10-16'},
 {observedAt:'2026-10-17T17:00:00Z',dueDate:'2026-10-20'},
 {observedAt:'2026-11-01T05:30:00Z',dueDate:'2026-11-03'},
])('runs selected input through configured extraction, promise review, Today, correction and deletion at $observedAt',async({observedAt,dueDate})=>{
 const passage=`I will prepare the repair summary by ${dueDate}.`;
 const expectedClaim={kind:'commitment',status:'stated',interpretation:'Promise to prepare the repair summary',locator:`text:0:${passage.length}`,quote:passage};
 const fixture=await createAuthFixture();
 try{
  const db=await fixture.database.appRuntimeSession();
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
  const route={region:'us-east-1' as const,endpointId:'bedrock-runtime.us-east-1.amazonaws.com' as const,modelVersion:'us.anthropic.claude-haiku-4-5-20251001-v1:0' as const,providerKey:'controlled.crm_journey',accessGrantVersion:'controlled-access',dataHandlingVersion:'controlled-handling',fundingVerifiedUntil:'2099-01-01T00:00:00Z'};
  const configuration:CrmCapabilityStartupConfiguration={capture:false,extraction:route};
  const runtime=createCrmCapabilityRuntime(configuration,{implementationCommit:null,imageDigest:null,side:'api',schemaVersion:REQUIRED_SCHEMA,gmailAvailable:false});
  const request=(method:'POST'|'GET',path:string,body:unknown)=>dispatch({method,path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:db,auth:{...fixture.deps,db},supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmCapabilityRuntime:runtime});
  const post=(path:string,body:unknown)=>request('POST',path,body);
  const command=(body:object)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
  const firmId=await seedFirm(fixture,{name:'Controlled source firm',assignedUserId:fixture.alpha.admin.userId});
  const personId=await seedContact(fixture,{firmId,fullName:'Controlled promise owner'});
  expect((await post('/crm/people/bridge',command({contactIds:[personId]}))).status).toBe(200);
  const opened=await post('/opportunities/open',command({firmId}));expect(opened.status).toBe(200);
  const opportunityId=(opened.body as {result:{id:string}}).result.id;
  const selection={text:passage,subtype:'pasted_text',label:'Controlled selected promise',direction:'outgoing',participants:[],occurredAt:observedAt,attachments:[]};
  const preview=await post('/crm/imports/preview',selection);expect(preview.status).toBe(200);
  const committed=await post('/crm/imports/commit',command({...selection,personId,firmId:null,opportunityId,importKey:randomUUID(),previewHash:(preview.body as {previewHash:string}).previewHash,parserVersion:'selected-v1'}));
  expect(committed.status).toBe(200);
  const imported=selectedImportPageSchema.parse((await post('/crm/imports/read',{personId,limit:10})).body).imports[0]!;
  // Only the synthetic original's observation time is fixture data. Keep all
  // processing, review, projection, correction and deletion on their real paths.
  await fixture.db.query('UPDATE crm_selected_sources SET observed_at=$3 WHERE workspace_id=$1 AND id=$2',[fixture.alpha.workspaceId,imported.source.sourceId,observedAt]);
  expect(imported.metadata.directionVerified).toBe(false);
  expect(imported.metadata.opportunityId).toBe(opportunityId);
  const source={workspaceId:imported.source.workspaceId,sourceId:imported.source.sourceId,kind:'selected_note' as const,revision:imported.source.revision,contentHash:imported.source.contentHash,locator:null};
  expect((await post('/crm/processing/purpose/save',command({expectedRevision:0,enabled:false,endpointId:route.endpointId,modelVersion:route.modelVersion,accessGrantVersion:route.accessGrantVersion,dataHandlingVersion:route.dataHandlingVersion,dailyCeilingCents:20,monthlyCeilingCents:100,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).status).toBe(200);
  expect((await post('/crm/processing/purpose/activate',command({capability:'crm_extraction',expectedRevision:1,approval:{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'controlled-only-not-live-provider-proof',limitations:['representative_quality_unverified']}}))).body).toMatchObject({status:'accepted'});
  let calls=0;
  const composed=await composeCrmCapabilities({configuration,runtime:{...runtime,side:'worker'},openSession:async()=>({session:await fixture.database.appRuntimeSession(),close:async()=>{}}),loadSurface:async region=>{expect(region).toBe('us-east-1');return {endpointId:route.endpointId,async converse(input){calls++;expect(input.modelId).toBe(route.modelVersion);expect(input.messages[0]!.content[0]!.text).toBe(passage);return {stopReason:'tool_use',usage:{inputTokens:30,outputTokens:20},output:{message:{role:'assistant',content:[{toolUse:{toolUseId:'controlled-output',name:'emit_crm_extraction',input:{claims:[expectedClaim]}}}]}}};}};}});
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,...composed.handlers});
  expect((await post('/crm/processing/request',command({source}))).status).toBe(200);
  const ran=await runOnce(db,{registry,owner:'controlled-configured-extraction',limit:20});
  expect(ran.failed).toBe(0);
  expect(calls,JSON.stringify((await post('/crm/processing/read',{source})).body)).toBe(1);
  const processed=crmProcessingResultSchema.parse((await post('/crm/processing/read',{source})).body);
  expect(processed).toMatchObject({state:'complete',claims:[{kind:expectedClaim.kind,status:expectedClaim.status,interpretation:expectedClaim.interpretation,quote:passage,context:{opportunityId,firmIds:[firmId]},source:{locator:expectedClaim.locator}}],financial:{dispatchState:'settled',settlementState:'settled'}});
  if(!('generationId' in processed)||!processed.claims[0])throw new Error('Controlled claim missing');
  const claim=processed.claims[0];
  expect((await request('GET','/today/actions/v2',null)).body).toMatchObject({actions:[]});
  const review=await post('/crm/commitments/review',command({source,claimId:claim.claimId,claimRevision:claim.claimRevision,claimHash:claim.claimHash,contextHash:processed.contextHash,expectedDecisionRevision:0,expectedCommitmentRevision:0,classification:'internal_promise',actor:'self',actionLabel:'Prepare the repair summary',due:{kind:'date',date:dueDate,zone:'America/Chicago',expression:`by ${dueDate}`}}));
  expect(review.status).toBe(200);
  await runOnce(db,{registry,owner:'controlled-promise-projector',limit:20});
  expect((await request('GET','/today/actions/v2',null)).body).toMatchObject({actions:[{kind:'promise',reason:'dated_promise'}]});
  expect((await post('/crm/evidence/decide',command({source,claimId:claim.claimId,claimRevision:claim.claimRevision,claimHash:claim.claimHash,contextHash:processed.contextHash,expectedDecisionRevision:0,action:'correct',correctedInterpretation:'Human corrected the interpretation; review required.'}))).status).toBe(200);
  expect((await post('/crm/commitments/read',{scope:{kind:'person',personId},limit:10})).body).toMatchObject({items:[{state:'review_required'}]});
  expect((await post('/crm/imports/delete',command({sourceId:source.sourceId,expectedSourceRevision:source.revision,expectedMetadataRevision:imported.metadata.revision}))).status).toBe(200);
  expect((await request('GET','/today/actions/v2',null)).body).toMatchObject({actions:[]});
  expect((await post('/crm/processing/source/read',source)).status).toBe(404);
  const history=await post('/crm/commitments/read',{scope:{kind:'history'},limit:10});
  expect(JSON.stringify(history.body)).not.toContain('repair summary');
  expect(calls).toBe(1);
 }finally{await fixture.stop();}
});
