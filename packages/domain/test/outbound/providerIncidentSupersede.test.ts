import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {accessForMailbox} from '../../mail/sync.ts';
import {completeGmailGrant,signGrantState} from '../../mail/oauth.ts';
import {staticSecretProvider} from '../../mail/secretProvider.ts';
import {readProviderBinding,readProviderIncidents,recordProviderIncident,supersedeStaleTokenRefreshIncidents,type ProviderIncidentSource} from '../../outbound/providerIncidents.ts';
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
 describe('a reconnect that commits between access entry and the binding read',()=>{
  /** Runs `accessForMailbox` whose entry clock (its first read) predates a reconnect that commits just before the first binding read; the token refresh then fails on the NEW grant and the clock has moved on. */
  async function raceReconnect(seedOld:boolean){
   const box=world.alpha,ctx=world.systemContext(box.workspace.workspaceId),entry=new Date();
   if(seedOld){await world.database.session.query('UPDATE mailboxes SET connected_at=$2 WHERE id=$1',[box.mailboxId,new Date(entry.getTime()-120_000)]);
    await recordProviderIncident(ctx,{mailboxId:box.mailboxId,sourceKind:'token_refresh',sourceId:box.mailboxId,classification:'transient',reason:'rate_limited',binding:(await readProviderBinding(ctx,box.mailboxId))!,now:new Date(entry.getTime()-60_000)});}
   let reconnected=false;
   const racing={...ctx,db:{...ctx.db,query:async(sql:string,params?:unknown[])=>{
    if(!reconnected&&sql.includes('jsonb_build_array(m.generation')){reconnected=true;
     const key=randomBytes(32),state=signGrantState(key,{workspaceId:box.workspace.workspaceId,userId:box.workspace.salesperson.userId,expiresAtEpochSeconds:Math.floor(entry.getTime()/1000)+600});
     expect(await completeGmailGrant(world.userContext(box.workspace.workspaceId),{gmail:box.gmail,config:world.config,secrets:staticSecretProvider({gmail_oauth_client_secret:world.sendDeps(box).oauth.clientSecret}),cipher:world.cipher,stateSigningKey:key,now:()=>new Date()},{state,code:'fixture-reconnect'})).toMatchObject({ok:true});}
    return ctx.db.query(sql,params);
   }}} as typeof ctx;
   const gmail={...box.gmail,refreshAccessToken:async()=>({ok:false as const,reason:'rate_limited' as const})};
   let reads=0;const result=await accessForMailbox(racing,{gmail,oauth:world.sendDeps(box).oauth,cipher:world.cipher,now:()=>reads++===0?entry:new Date()},box.mailboxId);
   expect(reconnected).toBe(true);
   const rows=(await world.database.session.query<{observed_at:Date;connected_at:Date;resolved_at:Date|null;released_at:Date|null}>('SELECT i.observed_at,m.connected_at,i.resolved_at,h.released_at FROM mailbox_provider_incidents i JOIN mailboxes m ON m.workspace_id=i.workspace_id AND m.id=i.mailbox_id JOIN active_holds h ON h.workspace_id=i.workspace_id AND h.id=i.hold_id WHERE i.mailbox_id=$1',[box.mailboxId])).rows;
   return {box,ctx,result,rows};
  }
  it('stamps a refresh failure on the new grant at or after that grant, so nothing supersedes it',async()=>{
   const {box,ctx,result,rows}=await raceReconnect(false);
   expect(result).toEqual({ok:false,reason:'provider_incident'});
   expect(rows).toHaveLength(1);expect(rows[0]!.observed_at.getTime()).toBeGreaterThanOrEqual(rows[0]!.connected_at.getTime());
   expect(rows[0]).toMatchObject({resolved_at:null,released_at:null});
   await supersedeStaleTokenRefreshIncidents(ctx,box.mailboxId,new Date(Date.now()+60_000));
   expect((await readProviderIncidents(ctx,box.mailboxId)).map(i=>i.sourceKind)).toEqual(['token_refresh']);
   expect(await accessForMailbox(ctx,{gmail:box.gmail,oauth:world.sendDeps(box).oauth,cipher:world.cipher,now:()=>new Date(Date.now()+60_000)},box.mailboxId)).toEqual({ok:false,reason:'provider_incident'});
  });
  it('still supersedes the genuinely pre-grant incident while the new-grant failure stays open',async()=>{
   const {box,ctx,result,rows}=await raceReconnect(true);
   expect(result).toEqual({ok:false,reason:'provider_incident'});
   expect(rows).toHaveLength(2);
   const open=rows.filter(r=>r.resolved_at===null),closed=rows.filter(r=>r.resolved_at!==null);
   expect(open).toHaveLength(1);expect(closed).toHaveLength(1);
   expect(open[0]!.observed_at.getTime()).toBeGreaterThanOrEqual(open[0]!.connected_at.getTime());expect(open[0]!.released_at).toBeNull();
   expect(closed[0]!.observed_at.getTime()).toBeLessThan(closed[0]!.connected_at.getTime());expect(closed[0]!.released_at).not.toBeNull();
   expect((await readProviderIncidents(ctx,box.mailboxId)).map(i=>i.sourceKind)).toEqual(['token_refresh']);
  });
 });
});
