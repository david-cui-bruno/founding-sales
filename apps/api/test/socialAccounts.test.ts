import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
it('replays connection once and never accepts client-supplied scheduling verification',async()=>{
 const f=await createAuthFixture();try{
  let token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
  const call=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
  const input={accountId:randomUUID(),platform:'linkedin',externalId:'fixture-profile',displayName:'Fixture founder',accountKind:'profile',commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
  expect((await call('/social/accounts/connect',{...input,state:'connected',verifiedAt:new Date().toISOString()})).status).toBe(400);
  expect((await call('/social/accounts/connect',input)).body).toMatchObject({result:{accountId:input.accountId,state:'connected'}});
  expect((await call('/social/accounts/connect',input)).body).toMatchObject({replayed:true});
  const disconnected={accountId:input.accountId,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
  token=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;
  expect((await call('/social/accounts/disconnect',disconnected)).status).toBe(409);
  token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
  expect((await call('/social/accounts/disconnect',{...disconnected,commandId:randomUUID()})).body).toMatchObject({result:{state:'disconnected'}});
 }finally{await f.stop();}
});
