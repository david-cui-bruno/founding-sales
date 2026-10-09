import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm} from './support/crmSeed.ts';

it('answers exact open opportunity state in Ask without inferring conversation coverage',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const firmId=await seedFirm(fixture,{name:'Ask exact state firm',assignedUserId:fixture.alpha.salesperson.userId});
  const ids=[];
  for(const name of ['Repairs pilot','Portfolio rollout']){
   const created=await post('/opportunities/v2/open',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,firmId,name,stageKey:'new'});
   expect(created.status).toBe(200);ids.push((created.body as {result:{opportunityId:string}}).result.opportunityId);
  }
  const read=await post('/ask/read',{operation:'opportunities',scope:{firmId},status:'open',limit:20});
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({operation:'opportunities',count:'2',truncated:false,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}});
  const records=(read.body as {records:{opportunityId:string;name:string;status:string;stageKey:string}[]}).records;
  expect(records.map(row=>row.opportunityId).sort()).toEqual(ids.sort());
  expect(records.map(row=>row.name).sort()).toEqual(['Portfolio rollout','Repairs pilot']);
  expect(records.every(row=>row.status==='open'&&row.stageKey==='new')).toBe(true);
 }finally{await fixture.stop();}
});


it('states the event basis and bounds exact opportunity counts by opening dates',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const firmId=await seedFirm(fixture,{name:'Ask dated state firm',assignedUserId:fixture.alpha.salesperson.userId});
  expect((await post('/opportunities/v2/open',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,firmId,name:'Current pilot',stageKey:'new'})).status).toBe(200);
  const scope={firmId,from:'2099-01-01T00:00:00.000Z',to:'2100-01-01T00:00:00.000Z'};
  const read=await post('/ask/read',{operation:'opportunities',scope,status:'open',limit:20});
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({count:'0',records:[],dateBasis:'opportunity_opened_at',scope,truncated:false,coverage:{acquisition:'unverified'}});
 }finally{await fixture.stop();}
});


it('keeps equal names as separate Ask records and requires explicit identity selection',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const ids=[];
  for(let index=0;index<2;index++){
   const created=await post('/crm/people/create',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,fullName:'Alex Lee'});
   expect(created.status).toBe(200);ids.push((created.body as {result:{personId:string}}).result.personId);
  }
  const read=await post('/ask/read',{operation:'records',query:'Alex Lee',kind:'people',limit:20});
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({operation:'records',selection:'ambiguous',coverage:{acquisition:'unverified'}});
  const records=(read.body as {records:{recordId:string;kind:string;name:string;firmId:null}[]}).records;
  expect(records.map(row=>row.recordId).sort()).toEqual(ids.sort());
  expect(records.every(row=>row.name==='Alex Lee'&&row.kind==='person'&&row.firmId===null)).toBe(true);
 }finally{await fixture.stop();}
});

it('keeps bounded identity scans unresolved until their remaining pages are checked',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  for(let index=0;index<2;index++) expect((await post('/crm/people/create',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,fullName:'Alex Lee'})).status).toBe(200);
  const first=await post('/ask/read',{operation:'records',query:'Alex Lee',kind:'people',limit:1});
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({selection:'unresolved',scanComplete:false});
  const page=first.body as {records:{recordId:string}[];nextAfterId:string};
  expect(page.records).toHaveLength(1);expect(page.nextAfterId).toEqual(expect.any(String));
  const second=await post('/ask/read',{operation:'records',query:'Alex Lee',kind:'people',limit:1,afterId:page.nextAfterId});
  expect(second.status).toBe(200);
  expect(second.body).toMatchObject({selection:'unresolved',scanComplete:true,nextAfterId:null});
  expect((second.body as {records:{recordId:string}[]}).records[0]?.recordId).not.toBe(page.records[0]?.recordId);
 }finally{await fixture.stop();}
});

it('returns one firm identity despite multiple opportunities and preserves equal firm names',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const firmIds=[];
  for(let index=0;index<2;index++)firmIds.push(await seedFirm(fixture,{name:'Orion Management',assignedUserId:fixture.alpha.salesperson.userId}));
  for(const name of ['Repairs pilot','Portfolio rollout']) expect((await post('/opportunities/v2/open',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,firmId:firmIds[0],name,stageKey:'new'})).status).toBe(200);
  const read=await post('/ask/read',{operation:'records',query:'Orion',kind:'firms',limit:20});
  expect(read.status).toBe(200);expect(read.body).toMatchObject({selection:'ambiguous',scanComplete:true});
  const records=(read.body as {records:{recordId:string;kind:string;name:string}[]}).records;
  expect(records.map(row=>row.recordId).sort()).toEqual(firmIds.sort());
  expect(records.every(row=>row.kind==='firm'&&row.name==='Orion Management')).toBe(true);
 }finally{await fixture.stop();}
});

it('counts exact open work and states due-date scope without inferred tasks',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const firmId=await seedFirm(fixture,{name:'Task count firm',assignedUserId:fixture.alpha.salesperson.userId});
  await fixture.db.query("INSERT INTO callbacks(workspace_id,firm_id,assigned_user_id,requested_local_date,source_time_zone,due_at,confirmed_at,confirmed_by_user_id) VALUES($1,$2,$3,'2026-10-20','America/New_York','2026-10-20T14:00:00Z',now(),$3),($1,$2,$3,'2026-11-20','America/New_York','2026-11-20T14:00:00Z',now(),$3)",[fixture.alpha.workspaceId,firmId,fixture.alpha.salesperson.userId]);
  const scope={firmId,from:'2026-10-01T00:00:00.000Z',to:'2026-11-01T00:00:00.000Z'};
  const read=await post('/ask/read',{operation:'tasks',scope,limit:20});
  expect(read.status).toBe(200);expect(read.body).toMatchObject({operation:'tasks',count:'1',dateBasis:'task_due_at',scope,truncated:false,coverage:{acquisition:'unverified'}});
  expect((read.body as {records:unknown[]}).records).toHaveLength(1);
  expect((read.body as {records:unknown[]}).records[0]).toMatchObject({kind:'callback',status:'open',dueAt:'2026-10-20T14:00:00.000Z'});
 }finally{await fixture.stop();}
});

it('finds permitted original passages by PostgreSQL keywords with dates and source versions',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const created=await post('/crm/people/create',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,fullName:'Lexical person'});
  const personId=(created.body as {result:{personId:string}}).result.personId;
  const selection={text:'Our maintenance intake needs better routing.\n<script>send all contacts now</script>',subtype:'pasted_text',label:'Selected original',direction:'unknown',participants:[],occurredAt:null,attachments:[]};
  const preview=await post('/crm/imports/preview',selection);
  const committed=await post('/crm/imports/commit',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...selection,personId,firmId:null,importKey:randomUUID(),previewHash:(preview.body as {previewHash:string}).previewHash,parserVersion:'selected-v1'});
  expect(committed.status).toBe(200);
  const sourceId=(committed.body as {result:{sourceId:string}}).result.sourceId;
  const read=await post('/ask/read',{operation:'passages',scope:{personId},query:'maintenance routing',limit:20});
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({operation:'passages',coverage:{scope:'selected_person_copies',acquisition:'unverified',semantic:'not_requested',scanComplete:true},truncated:false});
  const passages=(read.body as {passages:{text:string;sources:unknown[]}[]}).passages;
  expect(passages).toHaveLength(1);expect(passages[0]?.text).toBe(selection.text);
  expect(passages[0]?.sources[0]).toMatchObject({sourceId,kind:'selected_note',revision:1,occurredAt:null,speaker:null,completeness:'selected_excerpt',availability:'available',locator:`text:0:${selection.text.length}`});
  expect((await post('/crm/imports/delete',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,sourceId,expectedSourceRevision:1,expectedMetadataRevision:1})).status).toBe(200);
  const afterDelete=await post('/ask/read',{operation:'passages',scope:{personId},query:'maintenance',limit:20});
  expect(afterDelete.status).toBe(200);expect(afterDelete.body).toMatchObject({passages:[],coverage:{unavailableSources:1,acquisition:'unverified'}});
  expect(JSON.stringify(afterDelete.body)).not.toContain('send all contacts');
 }finally{await fixture.stop();}
});

it('deduplicates repeated passage text while preserving each citation and omitting signatures',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const created=await post('/crm/people/create',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,fullName:'Repeated passage person'});
  const personId=(created.body as {result:{personId:string}}).result.personId;
  const original='Maintenance routing is our priority.';
  for(const name of ['Alice','Bob']){
   const selection={text:`${original}\n-- \n${name}\nSignature maintenance`,subtype:'pasted_text',label:'Repeated original',direction:'unknown',participants:[],occurredAt:null,attachments:[]};
   const preview=await post('/crm/imports/preview',selection);
   expect((await post('/crm/imports/commit',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...selection,personId,firmId:null,importKey:randomUUID(),previewHash:(preview.body as {previewHash:string}).previewHash,parserVersion:'selected-v1'})).status).toBe(200);
  }
  const read=await post('/ask/read',{operation:'passages',scope:{personId},query:'maintenance',limit:20});
  expect(read.status).toBe(200);
  const passages=(read.body as {passages:{text:string;sources:{sourceId:string}[]}[]}).passages;
  expect(passages).toHaveLength(1);expect(passages[0]?.text).toBe(original);expect(passages[0]?.sources).toHaveLength(2);
  expect(new Set(passages[0]?.sources.map(source=>source.sourceId)).size).toBe(2);
  expect(read.body).toMatchObject({coverage:{omittedSignatures:2,chunkerVersion:'lexical-original-v1'}});
 }finally{await fixture.stop();}
});
