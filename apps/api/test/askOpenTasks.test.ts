import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm} from './support/crmSeed.ts';
import {seedHistoricalAskAction} from './support/historicalAskAction.ts';

it('keeps existing human tasks searchable and completable without answering or models',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const command=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
  const firmId=await seedFirm(fixture,{name:'Retained manual work',assignedUserId:fixture.alpha.admin.userId});
  const text='Discuss the maintenance coordinator.';
  const source=await post('/crm/firm-sources/add',command({firmId,sourceKey:'retained-manual',excerpt:text,occurredAt:'2026-10-01T14:00:00Z'}));expect(source.status).toBe(200);
  const sourceId=(source.body as {result:{sourceId:string}}).result.sourceId;
  const {actionId}=await seedHistoricalAskAction(fixture,{firmId,sourceId,text,kind:'task',humanText:'Review coordinator workflow',owner:{userId:fixture.alpha.admin.userId,role:'admin'}});
  const tasks=()=>post('/ask/read',{operation:'tasks',scope:{firmId},limit:20});
  expect((await tasks()).body).toMatchObject({operation:'tasks',count:'1',records:[{key:`ask_task:${actionId}`,label:'Review coordinator workflow',status:'open'}]});
  expect((await post('/ask/actions/change',command({actionId,expectedVersion:1,action:'complete_task'}))).body).toMatchObject({result:{actionId,status:'done',version:2}});
  expect((await tasks()).body).toMatchObject({count:'0',records:[]});
  expect((await post('/ask/actions/read',{scope:{kind:'history'}})).body).toMatchObject({items:[{actionId,status:'done',label:'Review coordinator workflow',supportState:'current'}]});
 }finally{await fixture.stop();}
});
