import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {dispatchOutboundMessage} from '../../outbound/send.ts';
import {reconcileOutboundMessage} from '../../outbound/reconcile.ts';
import {readFence} from '../../outbound/fence.ts';
import {createOutboundWorld,OPEN_INSTANT,type OutboundWorld} from './support/outboundWorld.ts';

describe('provider incident recovery through outbound callers',()=>{
 let world:OutboundWorld;
 beforeEach(async()=>{world=await createOutboundWorld();});
 afterEach(async()=>{await world.stop();});
 it('persists a Sent-read cooldown and observes the original send after its deadline without resubmission',async()=>{
  const ctx=world.systemContext(world.alpha.workspace.workspaceId);
  const gmail=world.clientWith(world.alpha,{sendBehaviour:'indeterminate_but_delivered'});
  const id=await world.prepare(world.alpha);
  await dispatchOutboundMessage(ctx,world.sendDeps(world.alpha,{gmail}),{outboundMessageId:id});
  const retryAt='2026-09-23T09:05:00.000Z';
  let searches=0;
  const limited={...gmail,searchSentByMessageId:async()=>{searches++;return {ok:false as const,reason:'rate_limited' as const,retryAt};}};
  const first=await reconcileOutboundMessage(ctx,world.reconcileDeps(world.alpha,{gmail:limited,now:()=>new Date(OPEN_INSTANT)}),{outboundMessageId:id});
  expect(first).toMatchObject({outcome:'rate_limited',retryAt});
  const restarted=world.systemContext(world.alpha.workspace.workspaceId);
  const waiting=await reconcileOutboundMessage(restarted,world.reconcileDeps(world.alpha,{gmail:limited,now:()=>new Date('2026-09-23T09:04:59.999Z')}),{outboundMessageId:id});
  expect(waiting).toMatchObject({outcome:'cooldown',retryAt});
  expect(searches).toBe(1);
  expect((await readFence(ctx,id))?.state).toBe('reconciling');
  expect(await reconcileOutboundMessage(restarted,world.reconcileDeps(world.alpha,{gmail,now:()=>new Date(retryAt)}),{outboundMessageId:id})).toMatchObject({outcome:'sent'});
  expect(gmail.sends).toHaveLength(1);
 });
});
