import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {z} from 'zod';
import {firmTaskDtoSchema,askCoverageSchema,askScopeSchema} from '@fss/contracts';
import {dispatch} from '../src/server.ts';
import {readsLegacyAsk} from '../src/routes/askCompat.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm} from './support/crmSeed.ts';
import {seedHistoricalAskAction} from './support/historicalAskAction.ts';

// Exact shapes inspected in installed Callie 1.0.51 app.asar/main/main.js.
// release-stamp.json pins clean d49dda37dfb6d95cb7c5aa077da2f32b2724dc79.
const legacyRecords=z.strictObject({operation:z.literal('records'),selection:z.enum(['none','single','ambiguous','unresolved']),records:z.array(z.strictObject({recordId:z.uuid(),kind:z.enum(['person','firm']),name:z.string(),firmId:z.uuid().nullable()})).max(50),nextAfterId:z.uuid().nullable(),scanComplete:z.boolean(),coverage:askCoverageSchema});
const legacyTasks=z.strictObject({operation:z.literal('tasks'),scope:askScopeSchema,dateBasis:z.literal('task_due_at'),count:z.string().regex(/^(0|[1-9]\d*)$/u),records:z.array(firmTaskDtoSchema).max(50),truncated:z.boolean(),coverage:askCoverageSchema});

it('selects the installed legacy shape from a valid session version only',()=>{
 expect(readsLegacyAsk({clientVersion:'1.0.51'})).toBe(true);
 expect(readsLegacyAsk({clientVersion:'1.0.50'})).toBe(true);
 expect(readsLegacyAsk({clientVersion:'1.0.52'})).toBe(false);
 expect(readsLegacyAsk({clientVersion:CURRENT_CLIENT_VERSION})).toBe(false);
 expect(readsLegacyAsk({clientVersion:'forged'})).toBe(false);
 expect(readsLegacyAsk({})).toBe(false);
});

it('keeps installed record/task parsers working without stripping current search or trusting headers',async()=>{
 const fixture=await createAuthFixture();
 try{
  const grant=await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin);
  const post=(path:string,body:unknown,headers:Record<string,string>={})=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${grant.accessToken}`,...headers}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const command=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
  const firmId=await seedFirm(fixture,{name:'Legacy search compatibility',assignedUserId:fixture.alpha.admin.userId});
  await fixture.db.query("INSERT INTO callbacks(workspace_id,firm_id,assigned_user_id,requested_local_date,source_time_zone,due_at,confirmed_at,confirmed_by_user_id) VALUES($1,$2,$3,'2026-10-20','America/New_York','2026-10-20T14:00:00Z',now(),$3),($1,$2,$3,'2026-10-21','America/New_York','2026-10-21T14:00:00Z',now(),$3)",[fixture.alpha.workspaceId,firmId,fixture.alpha.admin.userId]);
  const text='Ask the maintenance coordinator.';
  const source=await post('/crm/firm-sources/add',command({firmId,sourceKey:'legacy-search',excerpt:text,occurredAt:'2026-10-01T14:00:00Z'}));expect(source.status).toBe(200);
  const sourceId=(source.body as {result:{sourceId:string}}).result.sourceId;
  await seedHistoricalAskAction(fixture,{firmId,sourceId,text,kind:'task',humanText:'Discuss maintenance',owner:{userId:fixture.alpha.admin.userId,role:'admin'}});
  expect((await post('/crm/people/create',command({fullName:'Legacy search person'}))).status).toBe(200);
  const records={operation:'records',kind:'people',query:'Legacy',limit:20};
  const tasks={operation:'tasks',scope:{firmId},limit:20};
  const currentRecords=await post('/ask/read',records,{'x-client-version':'1.0.51'});
  expect(currentRecords.status).toBe(200);
  expect(currentRecords.body).toMatchObject({records:[{name:'Legacy search person',relationships:[],relationshipsComplete:true}]});
  expect(legacyRecords.safeParse(currentRecords.body).success).toBe(false);
  const current=await post('/ask/read',tasks,{'x-client-version':'1.0.51'});
  expect(current.status).toBe(200);
  expect(current.body).toMatchObject({count:'3',countBasis:'exact',taskCoverage:{operationalCount:'2'}});
  expect(legacyTasks.safeParse(current.body).success).toBe(false);
  // Test-only session mutation models the trusted persisted version read by authentication.
  await fixture.db.query('UPDATE sessions SET client_version=$3 WHERE workspace_id=$1 AND device_id=$2',[fixture.alpha.workspaceId,grant.deviceId,'1.0.51']);
  const oldTasks=await post('/ask/read',tasks,{'x-client-version':CURRENT_CLIENT_VERSION});
  expect(oldTasks.status).toBe(200);
  expect(legacyTasks.parse(oldTasks.body)).toMatchObject({count:'2',records:[{kind:'callback'},{kind:'callback'}],truncated:false});
  const oldPage=await post('/ask/read',{...tasks,limit:1});
  expect(oldPage.status).toBe(200);
  expect(legacyTasks.parse(oldPage.body)).toMatchObject({count:'2',records:[{kind:'callback'}],truncated:true});
  const oldRecords=await post('/ask/read',records);
  expect(oldRecords.status).toBe(200);
  expect(legacyRecords.parse(oldRecords.body)).toMatchObject({records:[{name:'Legacy search person'}]});
 }finally{await fixture.stop();}
});
