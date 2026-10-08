import {afterAll,beforeAll,expect,it} from 'vitest';
import {outreachSenderStandingResponseSchema,wireDrift} from '@fss/contracts';
import {dispatch,type ApiRequest} from '../src/server.ts';
import {createAuthFixture,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
let fixture:AuthFixture;
let admin:string,salesperson:string,mailboxId:string;
beforeAll(async()=>{
 fixture=await createAuthFixture();
 admin=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
 salesperson=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
 mailboxId=(await fixture.db.query<{id:string}>(`INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,created_at) VALUES($1,$2,$3,clock_timestamp()-interval '15 days') RETURNING id`,[fixture.alpha.workspaceId,fixture.alpha.salesperson.userId,'standing@example.test'])).rows[0]!.id;
 await fixture.db.query('INSERT INTO mailbox_send_ramp(workspace_id,mailbox_id,healthy_sending_days) VALUES($1,$2,40)',[fixture.alpha.workspaceId,mailboxId]);
});
afterAll(async()=>fixture?.stop());
const post=(path:string,token:string)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body:{}} satisfies ApiRequest,{session:fixture.db,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,auth:fixture.deps});
it('exposes earned and recovery standing only to an admin through a successor read without expanding installed strict sender DTOs',async()=>{
 const read=await post('/outreach/senders/standing',admin);
 expect(read.status).toBe(200);
 expect(wireDrift(outreachSenderStandingResponseSchema,read.body)).toEqual([]);
 expect(read.body).toMatchObject({senders:[{mailboxId,standing:{healthySendingDays:40,earnedCap:50,effectiveCap:5,activityBasis:'mailbox_creation',recovery:{active:true,stageCap:5,qualifyingDays:0},readiness:{ready:false}}}]});
 expect((await post('/outreach/senders/standing',salesperson)).status).toBe(403);
 for(const path of ['/outreach/control','/outreach/control/v2']){
  const old=await post(path,admin);
  expect(old.status).toBe(200);
  const sender=(old.body as {senders:Record<string,unknown>[]}).senders[0]!;
  expect(Object.keys(sender).sort()).toEqual(['address','authorizationRevision','authorized','connected','dailyCap','id','ownerUserId','sendingEnabled']);
 }
});
