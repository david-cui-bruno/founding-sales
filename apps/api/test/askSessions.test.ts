import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
it('creates a private business conversation and requires explicit approval for scope expansion',async()=>{
 const fixture=await createAuthFixture();try{
 const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
 const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
 const command={commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
 const person=await post('/crm/people/create',{...command,fullName:'Scoped conversational owner'});
 const personId=(person.body as {result:{personId:string}}).result.personId;
 const created=await post('/ask/sessions/create',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,scope:{kind:'person',personId}});
 expect(created.status).toBe(200);
 const identity=(created.body as {result:{sessionId:string;version:number}}).result;
 const read=await post('/ask/sessions/read',{sessionId:identity.sessionId});
 expect(read.status).toBe(200);expect(read.body).toMatchObject({...identity,scope:{kind:'person',personId},turns:[],state:'active'});
 const refused=await post('/ask/sessions/change',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...identity,action:{kind:'scope',scope:{kind:'business'}}});
 expect(refused.status).toBe(409);expect(refused.body).toMatchObject({reason:'scope_expansion_requires_confirmation'});
 const accepted=await post('/ask/sessions/change',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...identity,action:{kind:'scope',scope:{kind:'business'},confirmExpansion:true}});
 expect(accepted.status).toBe(200);
 expect((await post('/ask/sessions/read',{sessionId:identity.sessionId})).body).toMatchObject({version:2,scope:{kind:'business'}});
 const otherToken=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
 expect((await dispatch({method:'POST',path:'/ask/sessions/read',body:{sessionId:identity.sessionId},query:new URLSearchParams(),headers:{authorization:`Bearer ${otherToken}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false})).status).toBe(404);
 }finally{await fixture.stop();}
});
