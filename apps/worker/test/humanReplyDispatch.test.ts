import {expect,it} from 'vitest';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../src/bootstrap/main.ts';
import {randomUUID} from 'node:crypto';
import {createOutboundWorld} from '../../../packages/domain/test/outbound/support/outboundWorld.ts';
import {seedFirm} from '../../../packages/domain/test/outbound/support/dispatchFixtures.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {setProspectingAuthorization} from '@fss/domain/outreach/authorization.ts';
import {recordMessage,storeMessageBody} from '@fss/domain/mail/messages.ts';
import {recordMatches} from '@fss/domain/mail/matching.ts';
import {previewHumanReply,requestHumanReplySend,readHumanReplySend} from '@fss/domain/replies/dispatch.ts';
import {claimJobs} from '@fss/domain/jobs/jobStore.ts';

it('registers only explicit queued human dispatch with outbound-fence protection and no autonomous source',()=>{
 const registry=registerHandlers(new HandlerRegistry(),{} as Parameters<typeof registerHandlers>[1]);
 expect(registry.get('reply.human_send')).toMatchObject({kind:'reply.human_send',protection:'outbound_fence'});
});

it('the real explicit job uses existing sender composition once and a replay reports the original confirmed attempt',async()=>{
 const world=await createOutboundWorld();
 try{
  const box=world.alpha,workspaceId=box.workspace.workspaceId,member=box.workspace.salesperson,sessionId=randomUUID();
  const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'user',userId:member.userId,role:'salesperson'}),world.database.session),admin=repositoryContext(workspaceScope(workspaceId,{kind:'user',userId:box.workspace.admin.userId,role:'admin'}),ctx.db);
  const firm=await seedFirm(world,box,'worker-human');
  await ctx.db.query("UPDATE firms SET time_zone='Etc/UTC',time_zone_confidence='high',time_zone_source='recorded',time_zone_rule_version='fixture' WHERE workspace_id=$1 AND id=$2",[workspaceId,firm.firmId]);
  await withTransaction(ctx.db,()=>setProspectingAuthorization(admin,{mailboxId:box.mailboxId,expectedRevision:0,enabled:true,basis:'owner_reported_google_permission'}));
  await ctx.db.query("INSERT INTO sessions(workspace_id,id,user_id,device_id,access_token_hash,expires_at,reauthenticate_after) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '30 days')",[workspaceId,sessionId,member.userId,member.deviceId,'d'.repeat(64)]);
  const providerId=randomUUID(),message=await recordMessage(ctx,{mailboxId:box.mailboxId,metadata:{providerMessageId:providerId,providerThreadId:providerId,rfcMessageId:`${providerId}@example.test`,direction:'incoming',internalDate:new Date(Date.now()-1000).toISOString(),headerFrom:firm.address,headerTo:[box.address],headerCc:[],subject:'Question',referenceMessageIds:[],inReplyTo:null,autoSubmitted:null,listId:null,labelIds:[],attachments:[]}});
  await recordMatches(ctx,{messageId:message.message.id,candidates:[{firmId:firm.firmId,contactId:firm.contactId,opportunityId:firm.opportunityId,rule:'participant',viaClosedOpportunity:false}]});await storeMessageBody(ctx,{messageId:message.message.id,text:'A question.',truncated:false});
  const input={messageId:message.message.id,text:'A human answer.',factRefs:[],envelope:{to:[firm.address],cc:[]}},preview=await previewHumanReply(ctx,input);if(!preview.ok)throw new Error(preview.reason);
  const queued=await withTransaction(ctx.db,()=>requestHumanReplySend(ctx,{...input,commandId:randomUUID(),clientVersion:'1.0.49',sourceRevision:preview.value.sourceRevision,draftRevision:preview.value.draftRevision},{sessionId,deviceId:member.deviceId}));if(!queued.ok)throw new Error(queued.reason);
  const [job]=await claimJobs(ctx.db,{kinds:['reply.human_send'],limit:1,owner:'test-worker',leaseSeconds:180});if(!job)throw new Error('No explicit job');
  const handler=registerHandlers(new HandlerRegistry(),{send:world.sendDeps(box)} as Parameters<typeof registerHandlers>[1]).get('reply.human_send')!;
  const run={scope:world.systemContext(workspaceId).scope,session:world.database.session,job};
  await handler.handle(run);await handler.handle(run);
  expect(box.gmail.sends).toHaveLength(1);
  expect(await readHumanReplySend(ctx,input)).toMatchObject({ok:true,value:{state:'sent',outboundMessageId:queued.value.outboundMessageId,providerMessageId:expect.any(String)}});
 }finally{await world.stop();}
});
