import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {accessForMailbox} from '../../mail/sync.ts';
import {completeGmailGrant,signGrantState} from '../../mail/oauth.ts';
import {staticSecretProvider} from '../../mail/secretProvider.ts';
import {readProviderBinding,readProviderIncidents,recordProviderIncident,type ProviderIncidentSource} from '../../outbound/providerIncidents.ts';
import {createOutboundWorld,type OutboundWorld} from './support/outboundWorld.ts';

describe('a fresh grant supersedes token_refresh incidents observed before it',()=>{
 let world:OutboundWorld;
 beforeEach(async()=>{world=await createOutboundWorld();});
 afterEach(async()=>{await world.stop();});
 const grantAt=new Date('2026-09-23T10:00:00Z');
 async function incident(sourceKind:ProviderIncidentSource,observedMs:number){
  const box=world.alpha,ctx=world.systemContext(box.workspace.workspaceId);
  await world.database.session.query('UPDATE mailboxes SET connected_at=$2 WHERE id=$1',[box.mailboxId,grantAt]);
  await recordProviderIncident(ctx,{mailboxId:box.mailboxId,sourceKind,sourceId:sourceKind==='token_refresh'?box.mailboxId:'other-source',classification:'transient',reason:'rate_limited',binding:(await readProviderBinding(ctx,box.mailboxId))!,now:new Date(grantAt.getTime()+observedMs)});
  return {box,ctx,row:async()=>(await world.database.session.query<{resolved_at:Date|null;resolution:string|null;released_at:Date|null}>('SELECT i.resolved_at,i.resolution,h.released_at FROM mailbox_provider_incidents i JOIN active_holds h ON h.workspace_id=i.workspace_id AND h.id=i.hold_id WHERE i.mailbox_id=$1',[box.mailboxId])).rows[0]!};
 }
 const access=(f:{box:OutboundWorld['alpha'];ctx:ReturnType<OutboundWorld['systemContext']>})=>accessForMailbox(f.ctx,{gmail:f.box.gmail,oauth:world.sendDeps(f.box).oauth,cipher:world.cipher,now:()=>new Date(grantAt.getTime()+120_000)},f.box.mailboxId);
 it('resolves it lazily, releases its provider_refusal hold, and sync access proceeds',async()=>{
  const f=await incident('token_refresh',-60_000);
  expect(await readProviderIncidents(f.ctx,f.box.mailboxId,grantAt)).toMatchObject([{sourceKind:'token_refresh',state:'action_required'}]);
  expect((await f.row()).released_at).toBeNull();
  expect(await access(f)).toMatchObject({ok:true});
  expect(await f.row()).toMatchObject({resolution:'human_revalidated',resolved_at:expect.any(Date),released_at:expect.any(Date)});
  expect(await readProviderIncidents(f.ctx,f.box.mailboxId,grantAt)).toEqual([]);
  expect(await access(f)).toMatchObject({ok:true});
 });
 it('keeps blocking an incident observed after the grant',async()=>{
  const f=await incident('token_refresh',60_000);
  expect(await access(f)).toEqual({ok:false,reason:'provider_incident'});
  expect(await f.row()).toMatchObject({resolved_at:null,released_at:null});
 });
 it('keeps blocking a non-token_refresh incident observed before the grant',async()=>{
  const f=await incident('mail_read',-60_000);
  expect(await access(f)).toEqual({ok:false,reason:'provider_incident'});
  expect(await f.row()).toMatchObject({resolved_at:null,released_at:null});
 });
 it('is resolved by the reconnect itself, leaving other sources blocked',async()=>{
  const f=await incident('token_refresh',-60_000),{box}=f;
  await recordProviderIncident(f.ctx,{mailboxId:box.mailboxId,sourceKind:'mail_read',sourceId:'other-source',classification:'transient',reason:'rate_limited',binding:(await readProviderBinding(f.ctx,box.mailboxId))!,now:new Date(Date.now()-60_000)});
  const key=randomBytes(32),now=new Date();
  const state=signGrantState(key,{workspaceId:box.workspace.workspaceId,userId:box.workspace.salesperson.userId,expiresAtEpochSeconds:Math.floor(now.getTime()/1000)+600});
  expect(await completeGmailGrant(world.userContext(box.workspace.workspaceId),{gmail:box.gmail,config:world.config,secrets:staticSecretProvider({gmail_oauth_client_secret:world.sendDeps(box).oauth.clientSecret}),cipher:world.cipher,stateSigningKey:key,now:()=>now},{state,code:'fixture-reconnect'})).toMatchObject({ok:true});
  expect((await world.database.session.query('SELECT i.source_kind,i.resolution,h.released_at IS NOT NULL AS released FROM mailbox_provider_incidents i JOIN active_holds h ON h.workspace_id=i.workspace_id AND h.id=i.hold_id WHERE i.mailbox_id=$1 ORDER BY i.source_kind',[box.mailboxId])).rows).toEqual([{source_kind:'mail_read',resolution:null,released:false},{source_kind:'token_refresh',resolution:'human_revalidated',released:true}]);
 });
});
