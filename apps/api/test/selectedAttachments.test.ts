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
});
