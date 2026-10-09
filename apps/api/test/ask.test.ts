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
