import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {routeReplyComposer} from '../src/routes/replyComposer.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
let f:AuthFixture,token:string;
beforeAll(async()=>{f=await createAuthFixture();token=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;});
afterAll(async()=>f.stop());
const call=(path:string,body:unknown,authorized=true)=>routeReplyComposer({method:'POST',path,query:new URLSearchParams(),headers:authorized?{authorization:`Bearer ${token}`}:{},body},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update',suppressionJournal:{append:async()=>{}}},null);
it('requires a current authenticated session and strict context input without leaking body data',async()=>{
 expect((await call('/replies/composer/context',{messageId:randomUUID()},false))?.status).toBe(401);
 expect((await call('/replies/composer/context',{messageId:randomUUID(),authorUserId:f.alpha.admin.userId}))?.status).toBe(400);
 expect((await call('/replies/composer/context',{messageId:randomUUID()}))?.body).toEqual({ok:false,reason:'message_unavailable'});
});
it('refuses obsolete generation clients before any paid attempt',async()=>{
 const input={messageId:randomUUID(),sourceRevision:'a'.repeat(64),factRefs:[],envelope:{to:['prospect@example.test'],cc:[]},commandId:randomUUID(),clientVersion:'0.0.1'};
 expect((await call('/replies/composer/generate',input))?.body).toMatchObject({status:'refused',reason:'client_upgrade_required'});
 expect((await call('/replies/composer/generate',{...input,clientVersion:CURRENT_CLIENT_VERSION}))?.body).toMatchObject({status:'refused',reason:'message_unavailable'});
});
