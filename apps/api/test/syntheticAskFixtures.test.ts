import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {parseSyntheticAskFixtures} from './support/syntheticAskFixtures.ts';
const bytes=readFileSync(new URL('../../../tools/ask-evaluation/fixtures/ask-contract-v4.json',import.meta.url));
it('rejects a changed case identity or unsupported seed stage before fixture commands run',()=>{
 const fixture=parseSyntheticAskFixtures(bytes);
 expect(fixture.cases.map(item=>item.id)).toEqual(['crm2_01','crm2_02','crm2_03','crm2_04','crm2_05','crm2_06','crm2_07','crm2_08']);
 const changed=JSON.parse(bytes.toString()); changed.cases[4].seeds.opportunities[0].stage='proposal';
 expect(()=>parseSyntheticAskFixtures(JSON.stringify(changed))).toThrow();
});

import {randomUUID} from 'node:crypto';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm} from './support/crmSeed.ts';
import {prepareSyntheticAskFixture} from './support/syntheticAskFixtures.ts';
it('prepares all eight cases through public commands without native mail authority or model-facing graders',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const command=(body:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...body});
  const prepared=[];
  for(const item of parseSyntheticAskFixtures(bytes).cases){
   const firmId=await seedFirm(fixture,{name:item.firmName,assignedUserId:fixture.alpha.salesperson.userId});
   const result=await prepareSyntheticAskFixture(post,command,{workspaceId:fixture.alpha.workspaceId,firmId},item);prepared.push(result);
   expect(JSON.stringify(result.requestScope)).not.toContain('expected');
   expect(JSON.stringify(result.requestScope)).not.toContain('forbidden');
   expect(result.sources).toHaveLength(item.initialScope==='selected'?1:0);
   for(const source of result.cleanupSources){
    const {metadataRevision,...lookup}=source; void metadataRevision;
    const read=await post('/crm/processing/source/read',lookup);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({source:{kind:'selected_note',completeness:'selected_excerpt'}});
    const imports=await post('/crm/imports/read',{firmId,limit:100});
    expect(imports.body).toMatchObject({imports:expect.arrayContaining([expect.objectContaining({metadata:expect.objectContaining({directionVerified:false})})])});
   }
  }
  expect(prepared[0]!.seedObservation['opportunities']).toMatchObject({count:'4',records:expect.arrayContaining([expect.objectContaining({status:'lost'}),expect.objectContaining({name:'Alder North',status:'open'})])});
  expect((prepared[0]!.seedObservation['opportunities'] as {records:{status:string}[]}).records.filter(record=>record.status==='open')).toHaveLength(3);
  expect(prepared[1]!.seedObservation['tasks']).toMatchObject({count:'2',records:expect.arrayContaining([expect.objectContaining({label:'Check dimensions',dueAt:'2026-10-05T04:00:00.000Z'}),expect.objectContaining({label:'Prepare options',dueAt:'2026-10-06T04:00:00.000Z'})])});
  expect(prepared[1]!.cleanupSources).toHaveLength(1);
  expect(prepared[1]!.requestScope.agentScope).toMatchObject({kind:'firm',to:'2026-10-07T04:00:00Z'});
  for(const index of [4,5])expect(prepared[index]!.seedObservation['opportunities']).toMatchObject({records:expect.arrayContaining([expect.objectContaining({name:'East pilot',stageKey:'qualified',status:'open'}),expect.objectContaining({name:'West pilot',stageKey:'new',status:'open'})])});
  expect(prepared[1]!.seedObservation['taskActions']).toMatchObject({items:expect.arrayContaining([expect.objectContaining({label:'Completed check',status:'done'}),expect.objectContaining({label:'Undated check',due:null})])});
 }finally{await fixture.stop();}
},90000);
