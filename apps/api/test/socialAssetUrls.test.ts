import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {uuid} from '@fss/contracts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
import type {SocialMediaStore} from '../src/social/mediaStore.ts';
it.each(['upload','download'] as const)('direct %s URL issuance retains revocation locks and refuses auth expiry during signer wait',async mode=>{
 const f=await createAuthFixture(),runtime=await f.database.appRuntimeSession(),revoker=await f.database.appRuntimeSession();
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let revocation:Promise<unknown>|undefined;
 try{
  const grant=await issueSessionFor(f,f.alpha,f.alpha.admin),auth={...f.deps,db:runtime};
  const sign=async()=>{entered.resolve();await release.promise;return {url:'https://fixture.invalid/withheld-private-url',headers:{},expiresAt:new Date(Date.now()+600000).toISOString()};};
  const store:SocialMediaStore={presignPut:sign,presignGet:sign,read:async()=>{throw Error('unused');},put:async()=>{throw Error('unused');},head:async()=>{throw Error('unused');},delete:async()=>{throw Error('unused');}};
  const call=(path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${grant.accessToken}`},body},{session:runtime,auth,socialMedia:store,supportedClientVersions:auth.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
  const registered=await call('/social/assets/register',{sha256:'a'.repeat(64),bytes:100,mime:'image/png',origin:{kind:'upload',sourceUrl:null,usageNote:null},commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
  expect(registered.status).toBe(200);const ids=z.object({result:z.strictObject({assetId:uuid,uploadId:uuid})}).parse(registered.body).result;
  if(mode==='download'){
   await f.db.query("UPDATE social_asset_objects SET state='ready',sanitized=true WHERE workspace_id=$1 AND asset_id=$2 AND version=2",[f.alpha.workspaceId,ids.assetId]);
   await f.db.query("UPDATE social_assets SET state='ready',current_version=2 WHERE workspace_id=$1 AND id=$2",[f.alpha.workspaceId,ids.assetId]);
  }
  const input=mode==='upload'?ids:{assetId:ids.assetId,version:2},pending=call(`/social/assets/${mode}-url`,input);
  await entered.promise;
  const pid=(await revoker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  revocation=revoker.query("UPDATE devices SET status='revoked',revoked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[f.alpha.workspaceId,grant.deviceId]);
  // Independent revocation cannot commit across the transaction's retained device
  // fence while object/signing work is in flight. Expiry can still win that wait.
  await expect.poll(async()=>Boolean((await f.db.query<{blocked:boolean}>('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0]?.blocked)).toBe(true);
  f.advance(f.deps.config.sessions.accessSessionSeconds*1000+1);release.resolve();
  const answer=await pending;expect(answer.status).toBe(401);expect(answer.body).toEqual({error:'unauthenticated'});
  await revocation;
  expect((await call(`/social/assets/${mode}-url`,input)).status).toBe(401);
 }finally{release.resolve();await revocation;await f.stop();}
});
