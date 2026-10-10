import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
it('exposes authenticated readiness and refuses unknown runtime without enabling admission',async()=>{
 const f=await createAuthFixture();try{
 const token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
 const call=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
 const readiness=await call('/outreach/email-admission/readiness',{});
 expect(readiness.status).toBe(200);expect(readiness.body).toMatchObject({enabled:false,ready:false,reasons:expect.arrayContaining(['runtime_identity_unknown'])});
 const command={expectedControlRevision:0,expectedReadinessSha256:'0'.repeat(64),receiptId:randomUUID(),commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
 const answer=await call('/outreach/email-admission/activate',command);expect(answer.status).toBe(409);
 expect((await call('/outreach/email-admission/activate',command)).body).toMatchObject({replayed:true});
 expect((await call('/outreach/email-admission/readiness',{runtime:{implementationCommit:'a'.repeat(40)}})).status).toBe(400);
 expect((await f.db.query('SELECT 1 FROM outreach_email_admission_settings WHERE enabled')).rows).toHaveLength(0);
 }finally{await f.stop();}
});
