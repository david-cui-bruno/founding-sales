import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
let fixture:AuthFixture,token:string;
beforeAll(async()=>{fixture=await createAuthFixture();token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;});
afterAll(async()=>fixture?.stop());
const call=(path:string,body:unknown,authorized=true)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:authorized?{authorization:`Bearer ${token}`}:{},body},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
it('mounts a bounded authenticated composer that cannot accept an injected author or obsolete generation client',async()=>{
 const messageId=randomUUID();
 expect((await call('/replies/composer/context',{messageId},false)).status).toBe(401);
 expect((await call('/replies/composer/context',{messageId,authorUserId:fixture.alpha.admin.userId})).status).toBe(400);
 expect((await call('/replies/composer/context',{messageId})).body).toEqual({ok:false,reason:'message_unavailable'});
 expect((await call('/replies/composer/generate',{messageId,sourceRevision:'a'.repeat(64),factRefs:[],envelope:{to:['recipient@example.test'],cc:[]},commandId:randomUUID(),clientVersion:'0.0.1'})).status).toBe(426);
});

it('mounts human preview, durable send status and explicit send behind authentication and current-client command validation',async()=>{
 const messageId=randomUUID(),preview={messageId,text:'A human answer.',factRefs:[],envelope:{to:['recipient@example.test'],cc:[]}};
 for(const path of ['/replies/composer/preview','/replies/composer/send-status','/replies/composer/send'])expect((await call(path,preview,false)).status).toBe(401);
 expect((await call('/replies/composer/send-status',{messageId})).body).toEqual({ok:false,reason:'no_send_attempt'});
 expect((await call('/replies/composer/send',{...preview,commandId:randomUUID(),clientVersion:'0.0.1',sourceRevision:'a'.repeat(64),draftRevision:'b'.repeat(64)})).status).toBe(426);
});
