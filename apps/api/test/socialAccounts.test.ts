import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
import {postgresPublisherCredentials} from '@fss/social-publisher';
it('keeps metadata registration incapable of proving connectivity and replay cannot revoke subsequently verified credentials',async()=>{
 const f=await createAuthFixture();try{
  let token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
  const call=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
  const input={accountId:randomUUID(),platform:'linkedin',externalId:'fixture-profile-native-id',displayName:'Fixture founder',accountKind:'profile',commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
  expect((await call('/social/accounts/connect',{...input,state:'connected',verifiedAt:new Date().toISOString()})).status).toBe(400);
  expect((await call('/social/accounts/connect',input)).body).toMatchObject({result:{accountId:input.accountId}});
  expect((await f.db.query('SELECT encrypted_state FROM social_publisher_credentials WHERE workspace_id=$1 AND account_id=$2',[f.alpha.workspaceId,input.accountId])).rows).toEqual([]);
  const credentials=postgresPublisherCredentials(f.db,Buffer.alloc(32,23));
  const binding=await credentials.save({workspaceId:f.alpha.workspaceId,ownerUserId:f.alpha.admin.userId},input.accountId,{externalId:input.externalId,displayName:input.displayName,organizationId:'a'.repeat(24),channelId:'b'.repeat(24)},'controlled-private-api-key',async()=>{});
  await credentials.heartbeat('worker');
  expect(await credentials.read(binding)).not.toBeNull();
  expect((await call('/social/accounts/connect',input)).body).toMatchObject({replayed:true});
  expect(await credentials.read(binding)).not.toBeNull();
  const disconnected={accountId:input.accountId,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
  token=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;
  expect((await call('/social/accounts/disconnect',disconnected)).status).toBe(409);
  expect(await credentials.read(binding)).not.toBeNull();
  token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
  expect((await call('/social/accounts/disconnect',{...disconnected,commandId:randomUUID()})).body).toMatchObject({result:{state:'disconnected'}});
  expect(await credentials.read(binding)).toBeNull();
  expect((await f.db.query('SELECT encrypted_state,state FROM social_publisher_credentials WHERE workspace_id=$1 AND account_id=$2',[f.alpha.workspaceId,input.accountId])).rows).toEqual([{encrypted_state:null,state:'disconnected'}]);
 }finally{await f.stop();}
});
