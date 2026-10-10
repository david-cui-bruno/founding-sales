import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
it('reviews proposals without live changes, replays only the same command and isolates private workspace history',async()=>{
 const f=await createAuthFixture();try{
 let token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
 const call=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
 const before=await call('/sourcing/targeting',{});
 const input={expectedRevision:0,status:'accepted',content:{change:{kind:'discovery_query',basePolicyVersion:'targeting-v1',queryId:'providence-simple-v3',query:'residential property management Providence'},interval:{from:'2026-10-01T00:00:00Z',to:'2026-10-09T00:00:00Z',asOf:'2026-10-09T00:00:00Z'},rationale:'Test a bounded query',counterexamples:['Small sample'],uncertainty:'Unknown denominator',successMeasures:['Retained unique URLs']},commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
 const saved=await call('/sourcing/experiments/save',input);expect(saved.status).toBe(200);expect((await call('/sourcing/experiments/save',input)).body).toMatchObject({replayed:true});
 const id=(saved.body as {result:{id:string}}).result.id;
 expect((await call('/sourcing/experiments',{})).body).toMatchObject([{id,status:'accepted',revision:1}]);
 expect((await call('/sourcing/targeting',{})).body).toEqual(before.body);
 expect((await call('/sourcing/experiments/save',{...input,id,expectedRevision:0,commandId:randomUUID()})).status).toBe(409);
 token=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;
 expect((await call('/sourcing/experiments',{})).body).toEqual([]);
 expect((await call('/sourcing/experiments/erase',{id,expectedRevision:1,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION})).status).toBe(409);
 }finally{await f.stop();}
});
