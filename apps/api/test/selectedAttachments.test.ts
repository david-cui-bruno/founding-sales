import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import type {z} from 'zod';
import type {selectedAttachmentCommitPayloadSchema} from '@fss/contracts';
import {seedContact} from './support/crmSeed.ts';
import {seedFirm} from './support/crmSeed.ts';
import {recordingSuppressionJournal} from '@fss/domain/suppression/journal.ts';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {randomUUID} from 'node:crypto';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {crmExtractJobHandler} from '../../worker/src/handlers/crmExtract.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';

describe('explicit selected attachment analysis',()=>{
 let fixture:AuthFixture;let token:string;
 const post=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
 const command=(body:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...body});
 beforeAll(async()=>{fixture=await createAuthFixture();token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;});
 afterAll(async()=>fixture.stop());
 it('previews exactly selected UTF-8 file coverage before any analysis is requested',async()=>{
  const result=await post('/crm/attachments/preview',{fileName:'repairs.txt',declaredByteLength:28,bytesBase64:'V2UgbmVlZCByZXBhaXIgY29vcmRpbmF0aW9uLg==',completeness:'complete'});
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({state:'supported',fileName:'repairs.txt',byteLength:28,fileHash:'25ee8c81049e3d9309107bf3b7b9b807b1a7ed83121acb6c43b978889d86d3b1',format:'utf8_text',origin:'user_selected_original',completeness:'complete',processing:'not_requested'});
 expect(JSON.stringify(result.body)).not.toContain('We need repair coordination.');
 });
 it('reports unsupported file formats before processing instead of claiming the attachment was read',async()=>{
  const result=await post('/crm/attachments/preview',{fileName:'lease.pdf',declaredByteLength:8,bytesBase64:'JVBERi0xLjc=',completeness:'complete'});
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({state:'unsupported',reason:'unsupported_format',processing:'unavailable',supportedFormats:['utf8_text','utf8_markdown','utf8_csv','utf8_srt','utf8_vtt'],maxBytes:80000,maxCharacters:20000});
 expect(result.body).not.toHaveProperty('fileHash');
 });
 it('refuses a partial selection without presenting complete file coverage',async()=>{
  const result=await post('/crm/attachments/preview',{fileName:'repairs.txt',declaredByteLength:28,bytesBase64:'V2UgbmVlZCByZXBhaXIgY29vcmRpbmF0aW9uLg==',completeness:'partial'});
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({state:'unsupported',reason:'incomplete_selection',processing:'unavailable'});
 expect(result.body).not.toHaveProperty('fileHash');
 });
 it('imports only the explicitly selected file and preserves its exact original revision separately from processing',async()=>{
  const person=await post('/crm/people/create',command({fullName:'File correspondent'}));
  const personId=(person.body as {result:{personId:string}}).result.personId;
  const file={fileName:'repairs.txt',declaredByteLength:28,bytesBase64:'V2UgbmVlZCByZXBhaXIgY29vcmRpbmF0aW9uLg==',completeness:'complete'};
  const preview=await post('/crm/attachments/preview',file);
  const committed=await post('/crm/attachments/commit',command({file,personId,firmId:null,participants:[],occurredAt:null,importKey:'selected-file-import',previewHash:(preview.body as {previewHash:string}).previewHash}));
  expect(committed.status).toBe(200);
  const sourceId=(committed.body as {result:{sourceId:string}}).result.sourceId;
  const read=await post('/crm/attachments/read',{sourceId});
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({file:{state:'selected',fileName:'repairs.txt',byteLength:28,fileHash:'25ee8c81049e3d9309107bf3b7b9b807b1a7ed83121acb6c43b978889d86d3b1',format:'utf8_text',origin:'user_selected_original',sourceRevision:1,metadataRevision:1},source:{sourceId,kind:'selected_note',revision:1,completeness:'selected_excerpt',availability:'available'},processing:{state:'not_requested'}});
 });
 it('keeps selected file analysis unavailable without verified purpose configuration and makes zero model calls',async()=>{
  const person=await post('/crm/people/create',command({fullName:'Pending file analysis'}));
  const personId=(person.body as {result:{personId:string}}).result.personId;
  const file={fileName:'repairs.txt',declaredByteLength:28,bytesBase64:'V2UgbmVlZCByZXBhaXIgY29vcmRpbmF0aW9uLg==',completeness:'complete'};
  const preview=await post('/crm/attachments/preview',file);
  const committed=await post('/crm/attachments/commit',command({file,personId,firmId:null,participants:[],occurredAt:null,importKey:'pending-file-analysis',previewHash:(preview.body as {previewHash:string}).previewHash}));
  const sourceId=(committed.body as {result:{sourceId:string}}).result.sourceId;
  const read=await post('/crm/attachments/read',{sourceId});
  const reference=(read.body as {source:{workspaceId:string;sourceId:string;kind:string;revision:number;contentHash:string;locator:null}}).source;
  const source={workspaceId:reference.workspaceId,sourceId:reference.sourceId,kind:reference.kind,revision:reference.revision,contentHash:reference.contentHash,locator:null};
  const result=await post('/crm/attachments/analyze',command({source,fileHash:'25ee8c81049e3d9309107bf3b7b9b807b1a7ed83121acb6c43b978889d86d3b1'}));
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({result:{sourceId,sourceRevision:1,state:'unavailable',reason:'purpose_not_configured'}});
  let calls=0;const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({adapter:{endpointId:'fixture-attachment',modelVersion:'fixture-model',accessGrantVersion:'fixture-grant',dataHandlingVersion:'fixture-handling',providerKey:'fixture.crm_extraction',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;throw new Error('No model grant');}}}));
  await runOnce(fixture.db,{registry,owner:'attachment-disabled-test',limit:100});
  expect(calls).toBe(0);
  expect((await post('/crm/attachments/read',{sourceId})).body).toMatchObject({processing:{state:'unavailable',claims:[]}});
 });
 it('redacts selected file metadata when its source copy is deleted while reporting unavailable coverage',async()=>{
  const person=await post('/crm/people/create',command({fullName:'Deleted file correspondent'}));
  const personId=(person.body as {result:{personId:string}}).result.personId;
  const file={fileName:'private-repairs.txt',declaredByteLength:28,bytesBase64:'V2UgbmVlZCByZXBhaXIgY29vcmRpbmF0aW9uLg==',completeness:'complete'};
  const preview=await post('/crm/attachments/preview',file);
  const committed=await post('/crm/attachments/commit',command({file,personId,firmId:null,participants:[],occurredAt:null,importKey:'deleted-file-selection',previewHash:(preview.body as {previewHash:string}).previewHash}));
  const sourceId=(committed.body as {result:{sourceId:string}}).result.sourceId;
  expect((await post('/crm/imports/delete',command({sourceId,expectedSourceRevision:1,expectedMetadataRevision:1}))).status).toBe(200);
  const read=await post('/crm/attachments/read',{sourceId});
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({file:{state:'deleted',fileName:null,fileHash:null,byteLength:null},source:{sourceId,revision:2,contentHash:null,availability:'deleted',occurredAt:null},processing:{state:'source_unavailable',reason:'source_deleted'}});
  expect(JSON.stringify(read.body)).not.toContain('private-repairs');
 });
 it('restores only an unavailable file identity and requires fresh selection before analysis',async()=>{
  const person=await post('/crm/people/create',command({fullName:'Restored file correspondent'}));
  const personId=(person.body as {result:{personId:string}}).result.personId;
  const file={fileName:'repairs.txt',declaredByteLength:28,bytesBase64:'V2UgbmVlZCByZXBhaXIgY29vcmRpbmF0aW9uLg==',completeness:'complete'};
  const preview=await post('/crm/attachments/preview',file);
  const committed=await post('/crm/attachments/commit',command({file,personId,firmId:null,participants:[],occurredAt:null,importKey:'restored-file-selection',previewHash:(preview.body as {previewHash:string}).previewHash}));
  const sourceId=(committed.body as {result:{sourceId:string}}).result.sourceId;
  await post('/crm/imports/delete',command({sourceId,expectedSourceRevision:1,expectedMetadataRevision:1}));
  expect((await post('/crm/imports/restore',command({sourceId,expectedSourceRevision:2,expectedMetadataRevision:2}))).status).toBe(200);
  const read=await post('/crm/attachments/read',{sourceId});
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({file:{state:'awaiting_selection',fileName:null,fileHash:null},source:{revision:3,contentHash:null,availability:'awaiting_recapture'}});
 });
 it('reports truncated selected bytes before analysis even if the supplied completeness label says complete',async()=>{
  const result=await post('/crm/attachments/preview',{fileName:'repairs.txt',declaredByteLength:29,bytesBase64:'V2UgbmVlZCByZXBhaXIgY29vcmRpbmF0aW9uLg==',completeness:'complete'});
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({state:'unsupported',reason:'incomplete_selection',processing:'unavailable'});
  expect(result.body).not.toHaveProperty('fileHash');
 });
 it('does not treat an edited source excerpt as the unchanged original selected file',async()=>{
  const person=await post('/crm/people/create',command({fullName:'Edited file correspondent'}));
  const personId=(person.body as {result:{personId:string}}).result.personId;
  const file={fileName:'repairs.txt',declaredByteLength:28,bytesBase64:'V2UgbmVlZCByZXBhaXIgY29vcmRpbmF0aW9uLg==',completeness:'complete'};
  const preview=await post('/crm/attachments/preview',file);
  const committed=await post('/crm/attachments/commit',command({file,personId,firmId:null,participants:[],occurredAt:null,importKey:'edited-file-selection',previewHash:(preview.body as {previewHash:string}).previewHash}));
  const sourceId=(committed.body as {result:{sourceId:string}}).result.sourceId;
  const correction={text:'Edited original excerpt.',subtype:'selected_file',label:'repairs.txt',direction:'unknown',participants:[],occurredAt:null,attachments:[]};
  const correctedPreview=await post('/crm/imports/preview',correction);
  expect((await post('/crm/imports/correct',command({...correction,sourceId,expectedSourceRevision:1,expectedMetadataRevision:1,previewHash:(correctedPreview.body as {previewHash:string}).previewHash,parserVersion:'selected-v1'}))).status).toBe(200);
  const read=await post('/crm/attachments/read',{sourceId});
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({file:{state:'stale',sourceRevision:1,metadataRevision:2},source:{revision:2,availability:'available'}});
  const reference=(read.body as {source:{workspaceId:string;sourceId:string;kind:string;revision:number;contentHash:string}}).source;
  const denied=await post('/crm/attachments/analyze',command({source:{workspaceId:reference.workspaceId,sourceId:reference.sourceId,kind:reference.kind,revision:reference.revision,contentHash:reference.contentHash,locator:null},fileHash:'25ee8c81049e3d9309107bf3b7b9b807b1a7ed83121acb6c43b978889d86d3b1'}));
  expect(denied.status).toBe(409);
  expect(denied.body).toMatchObject({reason:'file_selection_changed'});
 });
 it('reselects restored bytes explicitly at a newer source revision without reviving the old selection',async()=>{
  const person=await post('/crm/people/create',command({fullName:'Reselected file correspondent'}));
  const personId=(person.body as {result:{personId:string}}).result.personId;
  const file={fileName:'repairs.txt',declaredByteLength:28,bytesBase64:'V2UgbmVlZCByZXBhaXIgY29vcmRpbmF0aW9uLg==',completeness:'complete'};
  const preview=await post('/crm/attachments/preview',file);
  const committed=await post('/crm/attachments/commit',command({file,personId,firmId:null,participants:[],occurredAt:null,importKey:'reselected-file-selection',previewHash:(preview.body as {previewHash:string}).previewHash}));
  const sourceId=(committed.body as {result:{sourceId:string}}).result.sourceId;
  await post('/crm/imports/delete',command({sourceId,expectedSourceRevision:1,expectedMetadataRevision:1}));
  await post('/crm/imports/restore',command({sourceId,expectedSourceRevision:2,expectedMetadataRevision:2}));
  const freshFile={...file,fileName:'repairs-v2.txt'};
  const fresh=await post('/crm/attachments/preview',freshFile);
  const result=await post('/crm/attachments/reselect',command({sourceId,expectedSourceRevision:3,expectedMetadataRevision:2,file:freshFile,participants:[],occurredAt:null,previewHash:(fresh.body as {previewHash:string}).previewHash}));
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({result:{sourceId,sourceRevision:4,metadataRevision:3}});
  expect((await post('/crm/attachments/read',{sourceId})).body).toMatchObject({file:{state:'selected',fileName:'repairs-v2.txt',sourceRevision:4,metadataRevision:3},source:{revision:4,availability:'available'},processing:{state:'not_requested'}});
 });
 it('refuses a PDF renamed as text without presenting original-file coverage',async()=>{
  const result=await post('/crm/attachments/preview',{fileName:'lease.txt',declaredByteLength:8,bytesBase64:'JVBERi0xLjc=',completeness:'complete'});
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({state:'unsupported',reason:'unsupported_format',processing:'unavailable'});
  expect(result.body).not.toHaveProperty('fileHash');
 });

 it('reports unreadable UTF-8 bytes without implying successful text acquisition',async()=>{
  const result=await post('/crm/attachments/preview',{fileName:'broken.txt',declaredByteLength:2,bytesBase64:'/wA=',completeness:'complete'});
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({state:'unsupported',reason:'unreadable_text',processing:'unavailable'});
  expect(result.body).not.toHaveProperty('sourceContentHash');
 });

 it('refuses binary control bytes in a file named as text',async()=>{
  const result=await post('/crm/attachments/preview',{fileName:'binary.txt',declaredByteLength:2,bytesBase64:'QQA=',completeness:'complete'});
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({state:'unsupported',reason:'unreadable_text',processing:'unavailable'});
  expect(result.body).not.toHaveProperty('fileHash');
 });

 it('reports the selected text limit rather than presenting oversized acquisition as unavailable identity',async()=>{
  const bytes=Buffer.from('x'.repeat(20001));
  const result=await post('/crm/attachments/preview',{fileName:'long.txt',declaredByteLength:20001,bytesBase64:bytes.toString('base64'),completeness:'complete'});
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({state:'unsupported',reason:'selection_limit_exceeded',processing:'unavailable',maxCharacters:20000});
  expect(result.body).not.toHaveProperty('fileHash');
 });

 it('reports an empty selected file without claiming complete readable content',async()=>{
  const result=await post('/crm/attachments/preview',{fileName:'empty.txt',declaredByteLength:0,bytesBase64:'',completeness:'complete'});
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({state:'unsupported',reason:'empty_selection',processing:'unavailable'});
  expect(result.body).not.toHaveProperty('fileHash');
 });

 it('reports the byte limit before acquiring an oversized complete selection',async()=>{
  const bytes=Buffer.alloc(80001,120);
  const result=await post('/crm/attachments/preview',{fileName:'large.txt',declaredByteLength:80001,bytesBase64:bytes.toString('base64'),completeness:'complete'});
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({state:'unsupported',reason:'selection_limit_exceeded',processing:'unavailable',maxBytes:80000});
 });

 it('keeps unknown analysis charges visible after file deletion and prevents a restored selection from blindly retrying',async()=>{
  const adminToken=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
  const configured=await dispatch({method:'POST',path:'/crm/processing/purpose/save',query:new URLSearchParams(),headers:{authorization:`Bearer ${adminToken}`},body:command({expectedRevision:0,enabled:false,endpointId:'attachment-fixture',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-grant-v1',dataHandlingVersion:'fixture-handling-v1',dailyCeilingCents:100,monthlyCeilingCents:100,inputTokenPriceMicros:2,outputTokenPriceMicros:8})},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  expect(configured.status).toBe(200);
  await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1',[fixture.alpha.workspaceId]);
  try{
   const person=await post('/crm/people/create',command({fullName:'Unknown file acceptance'}));
   const personId=(person.body as {result:{personId:string}}).result.personId;
   const file={fileName:'unknown-charge.txt',declaredByteLength:28,bytesBase64:'V2UgbmVlZCByZXBhaXIgY29vcmRpbmF0aW9uLg==',completeness:'complete'};
   const preview=await post('/crm/attachments/preview',file);
   const imported=await post('/crm/attachments/commit',command({file,personId,firmId:null,participants:[],occurredAt:null,importKey:'unknown-file-charge',previewHash:(preview.body as {previewHash:string}).previewHash}));
   const sourceId=(imported.body as {result:{sourceId:string}}).result.sourceId;
   const lookup=async()=>{const read=await post('/crm/attachments/read',{sourceId});const ref=(read.body as {source:{workspaceId:string;sourceId:string;kind:string;revision:number;contentHash:string;locator:null}}).source;return {workspaceId:ref.workspaceId,sourceId:ref.sourceId,kind:ref.kind,revision:ref.revision,contentHash:ref.contentHash,locator:null};};
   expect((await post('/crm/attachments/analyze',command({source:await lookup(),fileHash:'25ee8c81049e3d9309107bf3b7b9b807b1a7ed83121acb6c43b978889d86d3b1'}))).status).toBe(200);
   let calls=0;const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({adapter:{endpointId:'attachment-fixture',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-grant-v1',dataHandlingVersion:'fixture-handling-v1',providerKey:'fixture.crm_extraction',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;throw new Error('Unknown provider acceptance');}}}));
   await runOnce(fixture.db,{registry,owner:'attachment-unknown-acceptance',limit:100});
   expect(calls).toBe(1);
   expect((await post('/crm/attachments/read',{sourceId})).body).toMatchObject({processing:{state:'unknown_acceptance',financial:{dispatchState:'unknown_acceptance',settledCents:4}}});
   await post('/crm/imports/delete',command({sourceId,expectedSourceRevision:1,expectedMetadataRevision:1}));
   const deleted=await post('/crm/attachments/read',{sourceId});
   expect(deleted.body).toMatchObject({file:{state:'deleted',fileName:null},processingHealth:{availability:'deleted',generations:[{state:'deleted',financial:{dispatchState:'unknown_acceptance',settledCents:4}}]}});
   expect(JSON.stringify(deleted.body)).not.toContain('unknown-charge.txt');
   await post('/crm/imports/restore',command({sourceId,expectedSourceRevision:2,expectedMetadataRevision:2}));
   const fresh=await post('/crm/attachments/preview',file);
   expect((await post('/crm/attachments/reselect',command({sourceId,expectedSourceRevision:3,expectedMetadataRevision:2,file,participants:[],occurredAt:null,previewHash:(fresh.body as {previewHash:string}).previewHash}))).status).toBe(200);
   expect((await post('/crm/attachments/read',{sourceId})).body).toMatchObject({processingHealth:{availability:'available',unknownAcceptance:true,generations:[{financial:{dispatchState:'unknown_acceptance',settledCents:4}}]}});
   await post('/crm/attachments/analyze',command({source:await lookup(),fileHash:'25ee8c81049e3d9309107bf3b7b9b807b1a7ed83121acb6c43b978889d86d3b1'}));
   await runOnce(fixture.db,{registry,owner:'attachment-unknown-acceptance',limit:100});
   expect(calls).toBe(1);
   expect((await post('/crm/attachments/read',{sourceId})).body).toMatchObject({processing:{state:'unknown_acceptance',reason:'prior_acceptance_unknown'}});
  }finally{await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=false WHERE workspace_id=$1',[fixture.alpha.workspaceId]);}
 });

 it('deduplicates identical explicit imports but refuses changed content under the same import identity',async()=>{
  const person=await post('/crm/people/create',command({fullName:'Repeated file selection'}));
  const personId=(person.body as {result:{personId:string}}).result.personId;
  const file={fileName:'repairs.txt',declaredByteLength:28,bytesBase64:'V2UgbmVlZCByZXBhaXIgY29vcmRpbmF0aW9uLg==',completeness:'complete'};
  const preview=await post('/crm/attachments/preview',file);
  const payload={file,personId,firmId:null,participants:[],occurredAt:null,importKey:'repeated-file-selection',previewHash:(preview.body as {previewHash:string}).previewHash};
  const first=await post('/crm/attachments/commit',command(payload));
  const second=await post('/crm/attachments/commit',command(payload));
  expect(first.status).toBe(200);expect(second.status).toBe(200);expect(second.body).toEqual(first.body);
  const changedFile={...file,fileName:'other.txt'};
  const changedPreview=await post('/crm/attachments/preview',changedFile);
  expect((await post('/crm/attachments/commit',command({...payload,file:changedFile,previewHash:(changedPreview.body as {previewHash:string}).previewHash}))).status).toBe(409);
  const sourceId=(first.body as {result:{sourceId:string}}).result.sourceId;
  await post('/crm/imports/delete',command({sourceId,expectedSourceRevision:1,expectedMetadataRevision:1}));
  expect((await post('/crm/attachments/commit',command(payload))).status).toBe(409);
  expect((await post('/crm/attachments/read',{sourceId})).body).toMatchObject({file:{state:'deleted',fileName:null}});
 });

 it('includes selected-file metadata in the approved firm-deletion preview and redacts it atomically',async()=>{
  const firmId=await seedFirm(fixture,{name:'Selected file firm',regionCode:'RI',postalCode:'02903',assignedUserId:fixture.alpha.salesperson.userId});
  const file={fileName:'confidential-firm.txt',declaredByteLength:28,bytesBase64:'V2UgbmVlZCByZXBhaXIgY29vcmRpbmF0aW9uLg==',completeness:'complete'};
  const preview=await post('/crm/attachments/preview',file);
  const imported=await post('/crm/attachments/commit',command({file,personId:null,firmId,participants:[],occurredAt:null,importKey:'firm-file-deletion',previewHash:(preview.body as {previewHash:string}).previewHash}));
  expect(imported.status).toBe(200);
  const sourceId=(imported.body as {result:{sourceId:string}}).result.sourceId;
  const adminToken=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;const journal=recordingSuppressionJournal();
  const deletion=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${adminToken}`},body},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:journal});
  const shown=await deletion('/retention/deletions/preview',command({targetKind:'firm',firmId}));
  expect(shown.status).toBe(200);
  expect(shown.body).toMatchObject({result:{redacts:{crm_selected_file_receipts:1}}});
  const approval=(shown.body as {result:{requestId:string;previewHash:string}}).result;
  const committed=await deletion('/retention/deletions/commit',command({requestId:approval.requestId,previewHash:approval.previewHash}));
  expect(committed.status).toBe(200);
  expect(committed.body).toMatchObject({result:{redacted:{crm_selected_file_receipts:1}}});
  expect((await post('/crm/attachments/read',{sourceId})).body).toMatchObject({file:{state:'deleted',fileName:null,fileHash:null}});
 });

 it('reports a whitespace-only selected file as empty instead of missing identity',async()=>{
  const result=await post('/crm/attachments/preview',{fileName:'blank.txt',declaredByteLength:3,bytesBase64:'IAoJ',completeness:'complete'});
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({state:'unsupported',reason:'empty_selection',processing:'unavailable'});
  expect(result.body).not.toHaveProperty('fileHash');
 });

 it('returns supported selected-file claims only after an explicit authorized analysis request',async()=>{
  const fixture=await createAuthFixture();
  const localToken=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${localToken}`},body},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const adminToken=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
  const purpose=await dispatch({method:'POST',path:'/crm/processing/purpose/save',query:new URLSearchParams(),headers:{authorization:`Bearer ${adminToken}`},body:command({expectedRevision:0,enabled:false,endpointId:'attachment-fixture',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-grant-v1',dataHandlingVersion:'fixture-handling-v1',dailyCeilingCents:100,monthlyCeilingCents:100,inputTokenPriceMicros:2,outputTokenPriceMicros:8})},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  // This controlled adapter fixture grants only the existing extraction purpose.
  expect(purpose.status).toBe(200);
  await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1',[fixture.alpha.workspaceId]);
  try{
   const person=await post('/crm/people/create',command({fullName:'Supported selected file'}));
   const personId=(person.body as {result:{personId:string}}).result.personId;
   const file={fileName:'supported.txt',declaredByteLength:28,bytesBase64:'V2UgbmVlZCByZXBhaXIgY29vcmRpbmF0aW9uLg==',completeness:'complete'};
   const preview=await post('/crm/attachments/preview',file);
   const imported=await post('/crm/attachments/commit',command({file,personId,firmId:null,participants:[],occurredAt:null,importKey:'supported-file-analysis',previewHash:(preview.body as {previewHash:string}).previewHash}));
   expect(imported.status).toBe(200);
   const sourceId=(imported.body as {result:{sourceId:string}}).result.sourceId;
   const page=await post('/crm/attachments/read',{sourceId});
   const ref=(page.body as {source:{workspaceId:string;sourceId:string;kind:string;revision:number;contentHash:string}}).source;
   let calls=0;const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({adapter:{endpointId:'attachment-fixture',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-grant-v1',dataHandlingVersion:'fixture-handling-v1',providerKey:'fixture.crm_extraction',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:30},claims:[{kind:'need',interpretation:'Repair coordination',status:'stated',locator:'text:0:28',quote:'We need repair coordination.'}]};}}}));
   await runOnce(fixture.db,{registry,owner:'file-before-explicit-analysis',limit:100});expect(calls).toBe(0);
   expect((await post('/crm/attachments/analyze',command({source:{workspaceId:ref.workspaceId,sourceId,kind:ref.kind,revision:ref.revision,contentHash:ref.contentHash,locator:null},fileHash:'25ee8c81049e3d9309107bf3b7b9b807b1a7ed83121acb6c43b978889d86d3b1'}))).status).toBe(200);
   await runOnce(fixture.db,{registry,owner:'file-explicit-analysis',limit:100});expect(calls).toBe(1);
   expect((await post('/crm/attachments/read',{sourceId})).body).toMatchObject({file:{state:'selected',origin:'user_selected_original'},source:{speaker:null,occurredAt:null,completeness:'selected_excerpt'},processing:{state:'complete',claims:[{quote:'We need repair coordination.',source:{sourceId,revision:1,speaker:null,occurredAt:null}}],financial:{dispatchState:'settled',settledCents:1}}});
  }finally{await fixture.stop();}
 });

 it('redacts a selected-file result when deletion commits during the model wait',async()=>{
  const fixture=await createAuthFixture();
  const localToken=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${localToken}`},body},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const adminToken=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
  const purpose=await dispatch({method:'POST',path:'/crm/processing/purpose/save',query:new URLSearchParams(),headers:{authorization:`Bearer ${adminToken}`},body:command({expectedRevision:0,enabled:false,endpointId:'attachment-fixture',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-grant-v1',dataHandlingVersion:'fixture-handling-v1',dailyCeilingCents:100,monthlyCeilingCents:100,inputTokenPriceMicros:2,outputTokenPriceMicros:8})},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  // This controlled adapter fixture grants only the existing extraction purpose.
  expect(purpose.status).toBe(200);
  await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1',[fixture.alpha.workspaceId]);
  try{
   const person=await post('/crm/people/create',command({fullName:'Supported selected file'}));
   const personId=(person.body as {result:{personId:string}}).result.personId;
   const file={fileName:'supported.txt',declaredByteLength:28,bytesBase64:'V2UgbmVlZCByZXBhaXIgY29vcmRpbmF0aW9uLg==',completeness:'complete'};
   const preview=await post('/crm/attachments/preview',file);
   const imported=await post('/crm/attachments/commit',command({file,personId,firmId:null,participants:[],occurredAt:null,importKey:'file-delete-during-analysis',previewHash:(preview.body as {previewHash:string}).previewHash}));
   expect(imported.status).toBe(200);
   const sourceId=(imported.body as {result:{sourceId:string}}).result.sourceId;
   const page=await post('/crm/attachments/read',{sourceId});
   const ref=(page.body as {source:{workspaceId:string;sourceId:string;kind:string;revision:number;contentHash:string}}).source;
   let started!:()=>void;let release!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve;});const waiting=new Promise<void>(resolve=>{release=resolve;});
   let calls=0;const registry=new HandlerRegistry();registry.register(crmExtractJobHandler({adapter:{endpointId:'attachment-fixture',modelVersion:'fixture-model-v1',accessGrantVersion:'fixture-grant-v1',dataHandlingVersion:'fixture-handling-v1',providerKey:'fixture.crm_extraction',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;started();await waiting;return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:30},claims:[{kind:'need',interpretation:'Repair coordination',status:'stated',locator:'text:0:28',quote:'We need repair coordination.'}]};}}}));
   await runOnce(fixture.db,{registry,owner:'file-before-explicit-analysis',limit:100});expect(calls).toBe(0);
   expect((await post('/crm/attachments/analyze',command({source:{workspaceId:ref.workspaceId,sourceId,kind:ref.kind,revision:ref.revision,contentHash:ref.contentHash,locator:null},fileHash:'25ee8c81049e3d9309107bf3b7b9b807b1a7ed83121acb6c43b978889d86d3b1'}))).status).toBe(200);
   const pending=runOnce(fixture.db,{registry,owner:'file-explicit-analysis',limit:100});
   await entered;
   try{expect((await post('/crm/imports/delete',command({sourceId,expectedSourceRevision:1,expectedMetadataRevision:1}))).status).toBe(200);}finally{release();}
   await pending;expect(calls).toBe(1);
   const removed=await post('/crm/attachments/read',{sourceId});
   expect(removed.body).toMatchObject({file:{state:'deleted',fileName:null,fileHash:null},source:{availability:'deleted',contentHash:null},processingHealth:{availability:'deleted',generations:[{state:'deleted',claims:[],financial:{dispatchState:'settled',settledCents:1}}]}});
   expect(JSON.stringify(removed.body)).not.toContain('We need repair coordination.');
  }finally{await fixture.stop();}
 });

 it('refuses simultaneous cross-person file replay without acquiring candidate locks before import keys',async()=>{
  const selections:{payload:z.infer<typeof selectedAttachmentCommitPayloadSchema>;sourceId:string}[]=[];
  for(const label of ['first','second']){
   const firmId=await seedFirm(fixture,{name:`${label} file replay firm`,assignedUserId:fixture.alpha.salesperson.userId});
   const personId=await seedContact(fixture,{firmId,fullName:`${label} file replay person`});
   expect((await post('/crm/people/bridge',command({contactIds:[personId]}))).status).toBe(200);
   expect((await post('/crm/people/source/add',command({personId,sourceKey:randomUUID(),excerpt:`${label} endpoint evidence`,occurredAt:'2026-09-15T14:00:00.000Z'}))).status).toBe(200);
   const identity=(await post('/crm/people/read',{personId})).body as {sources:{sourceId:string;revision:number;contentHash:string}[]};
   const evidence=identity.sources[0]!;const endpoint=`${label}@replay.example.test`;
   expect((await post('/crm/endpoints/claim',command({personId,firmId:null,shared:false,kind:'email',value:endpoint,status:'current',startDate:'2026-01-01',endDate:null,evidence:{sourceId:evidence.sourceId,sourceRevision:evidence.revision,contentHash:evidence.contentHash}}))).status).toBe(200);
   const file={fileName:`${label}.txt`,declaredByteLength:28,bytesBase64:'V2UgbmVlZCByZXBhaXIgY29vcmRpbmF0aW9uLg==',completeness:'complete' as const};
   const preview=await post('/crm/attachments/preview',file);
   const payload:z.infer<typeof selectedAttachmentCommitPayloadSchema>={file,personId,firmId:null,participants:[{label,endpoint,provenance:'user_supplied'}],occurredAt:null,importKey:randomUUID(),previewHash:(preview.body as {previewHash:string}).previewHash};
   const committed=await post('/crm/attachments/commit',command(payload));expect(committed.status).toBe(200);
   selections.push({payload,sourceId:(committed.body as {result:{sourceId:string}}).result.sourceId});
  }
  const holder=await fixture.database.appRuntimeSession(),observer=await fixture.database.appRuntimeSession();
  const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  await holder.query('BEGIN');
  for(const selection of selections)await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${fixture.alpha.workspaceId}:${fixture.alpha.salesperson.userId}:import:${createHash('sha256').update(`attachment:${selection.payload.importKey}`).digest('hex')}`]);
  const sessions=await Promise.all([fixture.database.appRuntimeSession(),fixture.database.appRuntimeSession()]);
  const pending=Promise.allSettled(selections.map((selection,index)=>dispatch({method:'POST',path:'/crm/attachments/commit',query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body:command({...selection.payload,personId:selections[1-index]!.payload.personId})},{session:sessions[index]!,auth:{...fixture.deps,db:sessions[index]!},supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false})));
  try{
   let reached=false;
   for(let attempt=0;attempt<200;attempt++){
    const waiting=(await observer.query<{n:number}>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows[0]!.n;
    if(waiting>=2){reached=true;break;}await delay(5);
   }
   expect(reached).toBe(true);
  }finally{await holder.query('COMMIT');}
  for(const result of await pending){expect(result.status,result.status==='rejected'?String(result.reason):'Both commands refuse cleanly').toBe('fulfilled');if(result.status!=='fulfilled')throw result.reason;expect(result.value.status).toBe(409);expect(result.value.body).toMatchObject({reason:'import_identity_conflict'});}
  for(const selection of selections)expect((await post('/crm/attachments/read',{sourceId:selection.sourceId})).body).toMatchObject({file:{state:'selected'},source:{revision:1,availability:'available'}});
 });

});
