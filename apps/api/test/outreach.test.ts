import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
let f:AuthFixture,token:string,mailboxId:string;
const call=(body:unknown,path='/outreach/authorization/save')=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update'});
beforeAll(async()=>{f=await createAuthFixture();token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;mailboxId=(await f.db.query<{id:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'owner@example.test','google-owner','connected') RETURNING id",[f.alpha.workspaceId,f.alpha.admin.userId])).rows[0]!.id;});
afterAll(async()=>f.stop());
it('defaults off, records only an admin declaration, and replays without creating a second revision',async()=>{
 expect((await call({mailboxId},'/outreach/authorization')).body).toMatchObject({allowed:false,revision:null});
 const body={mailboxId,expectedRevision:0,enabled:true,basis:'owner_reported_google_permission',commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
 expect((await call(body)).body).toMatchObject({status:'accepted',result:{revision:1}});
 expect((await call(body)).body).toMatchObject({replayed:true,result:{revision:1}});
 expect((await call({mailboxId},'/outreach/authorization')).body).toMatchObject({allowed:true,revision:1});
 token=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;
 expect((await call({...body,commandId:randomUUID(),expectedRevision:1,enabled:false})).status).toBe(403);
 token=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;
 expect((await call({mailboxId},'/outreach/authorization')).status).toBe(404);
});
it('requires explicit reusable-fact approval and keeps command replay tied to the version',async()=>{
 token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
 const body={kind:'product',text:'Callie integrates with AppFolio.',commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
 const saved=await call(body,'/outreach/answer-blocks/save');expect(saved.status).toBe(200);
 const result=(saved.body as {result:{id:string;version:number}}).result;
 expect((await call({},'/outreach/answer-blocks')).body).toMatchObject({blocks:[{...result,approvedAt:null}]});
 const approval={...result,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
 expect((await call(approval,'/outreach/answer-blocks/approve')).status).toBe(200);
 expect((await call(approval,'/outreach/answer-blocks/approve')).body).toMatchObject({replayed:true,result});
});
it('reads disabled reply policy, saves with replay, and does not lift domain sending',async()=>{
 token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
 const view=await call({},'/outreach/control/v2');expect(view.status).toBe(200);expect(view.body).toMatchObject({settings:{revision:0,enabled:false},senders:[{address:'owner@example.test',sendingEnabled:false}]});
 const body={expectedRevision:0,enabled:false,sequenceVersionId:null,bookingUrl:'https://cal.com/callie/demo',commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
 expect((await call(body,'/outreach/settings/save')).body).toMatchObject({status:'accepted',result:{revision:1}});
 expect((await call(body,'/outreach/settings/save')).body).toMatchObject({replayed:true,result:{revision:1}});
 expect((await call({},'/outreach/control/v2')).body).toMatchObject({settings:{revision:1,enabled:false}});
});

it('shows automatic email admission disabled and unavailable before configuration',async()=>{
 token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
 expect((await call({},'/outreach/control/v2')).body).toMatchObject({emailAdmission:{revision:0,enabled:false,ownerUserId:null,mailboxId:null,sequenceVersionId:null,evaluation:null,ready:false,reasons:['configuration_required']}});
});

it('saves disabled email configuration with replay and rejects stale updates and activation',async()=>{
 const body={expectedRevision:0,enabled:false,ownerUserId:null,mailboxId:null,sequenceVersionId:null,evaluation:null,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
 expect((await call(body,'/outreach/email-admission/save')).body).toMatchObject({status:'accepted',result:{revision:1}});
 expect((await call(body,'/outreach/email-admission/save')).body).toMatchObject({replayed:true,result:{revision:1}});
 expect((await call({...body,commandId:randomUUID()},'/outreach/email-admission/save')).body).toMatchObject({reason:'stale_revision'});
 expect((await call({...body,expectedRevision:1,enabled:true,commandId:randomUUID()},'/outreach/email-admission/save')).body).toMatchObject({reason:'activation_not_available'});
 expect((await call({},'/outreach/control/v2')).body).toMatchObject({emailAdmission:{revision:1,enabled:false},settings:{enabled:false},senders:[{sendingEnabled:false}]});
});

it('refuses partial configuration, a different owner and an unauthorized sender',async()=>{
 const base={expectedRevision:1,enabled:false,ownerUserId:f.alpha.admin.userId,mailboxId,sequenceVersionId:randomUUID(),evaluation:null,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
 expect((await call({...base,sequenceVersionId:null},'/outreach/email-admission/save')).body).toMatchObject({reason:'configuration_incomplete'});
 expect((await call({...base,ownerUserId:f.alpha.salesperson.userId,commandId:randomUUID()},'/outreach/email-admission/save')).body).toMatchObject({reason:'owner_changed'});
 await call({mailboxId,expectedRevision:1,enabled:false,basis:'owner_reported_google_permission',commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
 expect((await call({...base,commandId:randomUUID()},'/outreach/email-admission/save')).body).toMatchObject({reason:'mailbox_not_authorized'});
 await call({mailboxId,expectedRevision:2,enabled:true,basis:'owner_reported_google_permission',commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
});

let emailSequenceId:string;
const command=(value:Record<string,unknown>)=>({...value,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
const resultId=(body:unknown)=>z.object({result:z.object({id:z.string()})}).parse(body).result.id;
it('binds an approved reusable five-email sequence without starting outreach',async()=>{
 const templateId=resultId((await call(command({name:'Neutral fit',subject:'Help with maintenance coordination at {firm_name}',body:'Hi,\n\nI saw {firm_name} manages residential properties. Would a walkthrough help?',footerSignOff:'Best,\nDavid',requiredVariables:['firm_name'],approve:true}),'/templates/create')).body);
 const sequenceId=resultId((await call(command({name:'Verified fit five emails'}),'/sequences/create')).body);
 const draft=await call(command({sequenceId,steps:[0,72,96,144,168].map((hours,i)=>({ordinal:i+1,channel:'email',delay:{unit:'elapsed',hours},templateVersionId:templateId}))}),'/sequences/versions/draft');
 emailSequenceId=z.object({result:z.object({sequenceVersionId:z.string()})}).parse(draft.body).result.sequenceVersionId;
 const base={expectedRevision:1,enabled:false,ownerUserId:f.alpha.admin.userId,mailboxId,sequenceVersionId:emailSequenceId,evaluation:null};
 expect((await call(command(base),'/outreach/email-admission/save')).body).toMatchObject({reason:'approved_email_sequence_required'});
 expect((await call(command({sequenceVersionId:emailSequenceId}),'/sequences/versions/publish')).status).toBe(200);
 expect((await call(command(base),'/outreach/email-admission/save')).body).toMatchObject({status:'accepted',result:{revision:2}});
 expect((await call({},'/outreach/control/v2')).body).toMatchObject({emailAdmission:{revision:2,enabled:false,ownerUserId:f.alpha.admin.userId,mailboxId,sequenceVersionId:emailSequenceId,evaluation:null,ready:false,reasons:['evaluation_required','activation_not_available']},replies:[]});
 expect((await call({},'/enrollments')).body).toMatchObject({enrollments:[]});
});

it('binds evaluation to this configuration and exact policy, prompt and running implementation',async()=>{
 vi.stubEnv('FSS_BUILD_COMMIT','a'.repeat(40));
 try{
  const view=z.object({emailAdmission:z.object({configurationSha256:z.string()})}).parse((await call({},'/outreach/control/v2')).body);
  const evaluation={policyVersion:'outreach-email-fit-v1',promptVersion:'qualification-growth-v6',implementationCommit:'a'.repeat(40),reportSha256:'b'.repeat(64),configurationSha256:view.emailAdmission.configurationSha256,reviewedEligible:2,falseEligible:0};
  const base={expectedRevision:2,enabled:false,ownerUserId:f.alpha.admin.userId,mailboxId,sequenceVersionId:emailSequenceId,evaluation};
  for(const changed of [{promptVersion:'old'},{implementationCommit:'c'.repeat(40)},{configurationSha256:'c'.repeat(64)},{falseEligible:1}]){
   expect((await call(command({...base,evaluation:{...evaluation,...changed}}),'/outreach/email-admission/save')).body).toMatchObject({reason:'evaluation_mismatch'});
  }
  expect((await call(command(base),'/outreach/email-admission/save')).body).toMatchObject({status:'accepted',result:{revision:3}});
  expect((await call({},'/outreach/control/v2')).body).toMatchObject({emailAdmission:{revision:3,enabled:false,evaluation,ready:false,reasons:['activation_not_available']}});
  vi.stubEnv('FSS_BUILD_COMMIT','d'.repeat(40));
  expect((await call({},'/outreach/control/v2')).body).toMatchObject({emailAdmission:{ready:false,reasons:['evaluation_mismatch','activation_not_available']}});
 }finally{vi.unstubAllEnvs();}
});

it('invalidates stored readiness after sender reauthorization and sequence retirement',async()=>{
 await call(command({mailboxId,expectedRevision:3,enabled:false,basis:'owner_reported_google_permission'}));
 expect((await call({},'/outreach/control/v2')).body).toMatchObject({emailAdmission:{revision:3,ready:false,reasons:['mailbox_not_authorized']}});
 await call(command({mailboxId,expectedRevision:4,enabled:true,basis:'owner_reported_google_permission'}));
 expect((await call({},'/outreach/control/v2')).body).toMatchObject({emailAdmission:{revision:3,ready:false,reasons:['mailbox_binding_changed','evaluation_mismatch','activation_not_available']}});
 expect((await call(command({sequenceVersionId:emailSequenceId}),'/sequences/versions/retire')).status).toBe(200);
 expect((await call({},'/outreach/control/v2')).body).toMatchObject({emailAdmission:{ready:false,reasons:['approved_email_sequence_required']}});
});
it('keeps email controls administrator-only and isolated between workspaces',async()=>{
 token=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;
 expect((await call({},'/outreach/control/v2')).status).toBe(403);
 expect((await call(command({expectedRevision:3,enabled:false,ownerUserId:null,mailboxId:null,sequenceVersionId:null,evaluation:null}),'/outreach/email-admission/save')).status).toBe(403);
 token=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;
 expect((await call({},'/outreach/control/v2')).body).toMatchObject({emailAdmission:{revision:0,enabled:false,ownerUserId:null}});
 expect((await call(command({expectedRevision:0,enabled:false,ownerUserId:f.beta.admin.userId,mailboxId,sequenceVersionId:emailSequenceId,evaluation:null}),'/outreach/email-admission/save')).body).toMatchObject({reason:'owner_changed'});
 token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
});

it('preserves the legacy control response for installed strict clients',async()=>{
 const old=await call({},'/outreach/control');
 expect(old.status).toBe(200);
 expect(Object.keys(z.record(z.string(),z.unknown()).parse(old.body)).sort()).toEqual(['blocks','candidates','replies','senders','sequences','settings']);
});
