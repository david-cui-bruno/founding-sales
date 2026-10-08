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
