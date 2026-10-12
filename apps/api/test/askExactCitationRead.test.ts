import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';

it('negotiates richer citation reads without changing ordinary not-found and owner checks',async()=>{
 const fixture=await createAuthFixture();
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  expect((await post('/ask/answers/read',{requestId:randomUUID(),includeExactResultCitations:true})).status).toBe(404);
  expect((await post('/ask/sessions/read',{sessionId:randomUUID(),includeExactResultCitations:true})).status).toBe(404);
  expect((await post('/ask/sessions/list',{limit:20,includeExactResultCitations:true})).body).toEqual({sessions:[],truncated:false});
  expect((await post('/ask/answers/read',{requestId:randomUUID(),includeExactResultCitations:'yes'})).status).toBe(400);
 }finally{await fixture.stop();}
});
