import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createOutboundWorld,type OutboundWorld} from '../outbound/support/outboundWorld.ts';
import {scanSentFolder,type SentFolderMessage} from '../../outbound/sentFolder.ts';
import {seedFirm} from '../outbound/support/dispatchFixtures.ts';
import {recordMessage,storeMessageBody,listMessagesForOpportunity,readMessageBody} from '../../mail/messages.ts';
import {recordMatches} from '../../mail/matching.ts';
import {recoverSentFolderMessage} from '../../restore/index.ts';
import {prepareHumanReplyFence,readFence} from '../../outbound/fence.ts';
import {dispatchOutboundMessage} from '../../outbound/send.ts';
import {withTransaction} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {authorizationForMailbox,setProspectingAuthorization} from '../../outreach/authorization.ts';
import {readReplyDraftContext} from '../../replies/composer.ts';
import {requestHumanReplySend,readHumanReplySend} from '../../replies/dispatch.ts';
import {makeStepExecution} from '../../db/testing/stepExecutions.ts';
import {readStepExecution} from '../../sequences/rows.ts';

let world:OutboundWorld;
beforeAll(async()=>{world=await createOutboundWorld();});
afterAll(async()=>world.stop());

async function restoredHumanSource(){
 const ctx=world.systemContext(world.alpha.workspace.workspaceId),firm=await seedFirm(world,world.alpha,'restored-human');
 const incoming=await recordMessage(ctx,{mailboxId:world.alpha.mailboxId,metadata:{providerMessageId:randomUUID(),providerThreadId:randomUUID(),rfcMessageId:`${randomUUID()}@example.test`,direction:'incoming',internalDate:'2026-09-24T13:00:00Z',headerFrom:firm.address,headerTo:[world.alpha.address],headerCc:[],subject:'A question',referenceMessageIds:[],inReplyTo:null,autoSubmitted:null,listId:null,labelIds:[],attachments:[]}});
 await recordMatches(ctx,{messageId:incoming.message.id,candidates:[{firmId:firm.firmId,contactId:firm.contactId,opportunityId:firm.opportunityId,rule:'participant',viaClosedOpportunity:false}]});
 await storeMessageBody(ctx,{messageId:incoming.message.id,text:'A retained incoming question.',truncated:false});
 const fenceId=randomUUID(),message={providerMessageId:randomUUID(),providerThreadId:incoming.message.providerThreadId,rfcMessageId:`<fss.reply.${incoming.message.id}.${fenceId}@example.test>`,fenceId,humanReplySourceId:incoming.message.id,recipientAddress:firm.address,subject:'A question',sentAt:'2026-09-24T14:00:00Z',humanReplyEnvelope:{from:world.alpha.address,to:[firm.address],cc:[],inReplyTo:incoming.message.rfcMessageId,referenceIds:[incoming.message.rfcMessageId!]}};
 return {ctx,firm,source:incoming.message,message,mailbox:{id:world.alpha.mailboxId,ownerUserId:world.alpha.workspace.salesperson.userId}};
}

it('the public Sent-folder scan retains a human reply source identity separately from legacy step markers',async()=>{
 const sourceId='11111111-1111-4111-8111-111111111111',fenceId='22222222-2222-4222-8222-222222222222';
 const gmail=world.clientWith(world.alpha,{sentMessages:[{
  id:'human-sent-one',threadId:'original-conversation',internalDateEpochMilliseconds:Date.parse('2026-09-24T14:00:00Z'),labelIds:['SENT'],historyId:'1000',
  headers:{'Message-ID':`<fss.reply.${sourceId}.${fenceId}@example.test>`,To:'prospect@example.test',Subject:'A question'},
 }]});
 const scan=await scanSentFolder(world.systemContext(world.alpha.workspace.workspaceId),{gmail,oauth:world.syncDeps(world.alpha).oauth,cipher:world.cipher},{mailboxId:world.alpha.mailboxId,since:'2026-09-24T13:59:00Z',until:'2026-09-24T14:01:00Z'});
 expect(scan).toMatchObject({outcome:'scanned',listed:1,messages:[{fenceId,humanReplySourceId:sourceId,providerThreadId:'original-conversation'}]});
});

it('recovery proves an answered human conversation without restoring prose or admitting a replacement send',async()=>{
 const f=await restoredHumanSource(),member=world.alpha.workspace.salesperson;
 const human=repositoryContext(workspaceScope(f.ctx.scope.workspaceId,{kind:'user',userId:member.userId,role:'salesperson'}),f.ctx.db),admin=repositoryContext(workspaceScope(f.ctx.scope.workspaceId,{kind:'user',userId:world.alpha.workspace.admin.userId,role:'admin'}),f.ctx.db);
 const authorization=await authorizationForMailbox(admin,world.alpha.mailboxId);
 await withTransaction(f.ctx.db,()=>setProspectingAuthorization(admin,{mailboxId:world.alpha.mailboxId,expectedRevision:authorization.revision??0,enabled:true,basis:'owner_reported_google_permission'}));
 expect(await readReplyDraftContext(human,{messageId:f.source.id,factRefs:[]})).toMatchObject({ok:true});
 await withTransaction(f.ctx.db,()=>recoverSentFolderMessage(f.ctx,{mailbox:f.mailbox,message:f.message}));
 expect(await readReplyDraftContext(human,{messageId:f.source.id,factRefs:[]})).toEqual({ok:false,reason:'answered_manually'});
 const outgoing=(await listMessagesForOpportunity(f.ctx,{opportunityId:f.firm.opportunityId})).find(message=>message.providerMessageId===f.message.providerMessageId);if(!outgoing)throw new Error('Confirmed metadata is missing');
 expect(outgoing.metadataOnly).toBe(true);expect(await readMessageBody(f.ctx,outgoing.id)).toBeNull();
 const sessionId=randomUUID();
 await f.ctx.db.query("INSERT INTO sessions(workspace_id,id,user_id,device_id,access_token_hash,expires_at,reauthenticate_after) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '30 days')",[f.ctx.scope.workspaceId,sessionId,member.userId,member.deviceId,'a'.repeat(64)]);
 const input={messageId:f.source.id,commandId:randomUUID(),clientVersion:'1.0.49',text:'A replacement must not leave.',sourceRevision:'a'.repeat(64),draftRevision:'b'.repeat(64),factRefs:[],envelope:{to:[f.firm.address],cc:[]}};
 expect(await withTransaction(f.ctx.db,()=>requestHumanReplySend(human,input,{sessionId,deviceId:member.deviceId}))).toMatchObject({ok:true,value:{state:'sent',outboundMessageId:f.message.fenceId}});
 expect(await readHumanReplySend(human,{messageId:f.source.id})).toMatchObject({ok:true,value:{state:'sent',providerMessageId:f.message.providerMessageId}});
 expect(world.alpha.gmail.sends).toHaveLength(0);
});

for(const missing of ['source','single To','owner','verified CC'] as const)it(`a lost human reply without ${missing} remains unattached instead of being guessed onto a sequence`,async()=>{
 const f=await restoredHumanSource();
 let message:SentFolderMessage={...f.message,humanReplyEnvelope:{...f.message.humanReplyEnvelope}};
 if(missing==='source'){const sourceId=randomUUID();message={...message,rfcMessageId:`<fss.reply.${sourceId}.${message.fenceId}@example.test>`,humanReplySourceId:sourceId};}
 if(missing==='single To')message={...message,recipientAddress:null,humanReplyEnvelope:{...f.message.humanReplyEnvelope,to:[f.firm.address,'second@example.test']}};
 if(missing==='verified CC')message={...message,humanReplyEnvelope:{...f.message.humanReplyEnvelope,cc:['unverified@example.test']}};
 const mailbox=missing==='owner'?{...f.mailbox,ownerUserId:world.alpha.workspace.admin.userId}:f.mailbox;
 expect(await withTransaction(f.ctx.db,()=>recoverSentFolderMessage(f.ctx,{mailbox,message}))).toMatchObject({outcome:'unattached',reason:'human_reply_unresolved',enrollmentIds:[]});
 expect(await readFence(f.ctx,f.message.fenceId)).toBeNull();
 expect(world.alpha.gmail.sends).toHaveLength(0);
});

it('a source-bound human tombstone never consumes a pending sequence step at another firm sharing the address',async()=>{
 const f=await restoredHumanSource();
 const stepId=await makeStepExecution(world.database.session,{workspaceId:f.ctx.scope.workspaceId,firmId:world.crm.alpha.firmId,opportunityId:world.crm.alpha.opportunityId,userId:world.alpha.workspace.salesperson.userId,templateVersionId:world.alpha.templateVersionId,zone:'Etc/UTC'});
 const step=await readStepExecution(f.ctx,stepId);if(!step)throw new Error('The pending step is missing');
 await f.ctx.db.query("INSERT INTO email_addresses(workspace_id,firm_id,contact_id,address,source,retrieved_at,association_confidence,technical_validation,eligibility,eligibility_policy_version) VALUES($1,$2,$3,$4,'reply',now(),0.9,'passed','usable','fixture')",[f.ctx.scope.workspaceId,world.crm.alpha.firmId,step.contactId,f.firm.address]);
 expect(await withTransaction(f.ctx.db,()=>recoverSentFolderMessage(f.ctx,{mailbox:f.mailbox,message:f.message}))).toMatchObject({outcome:'tombstoned',stepExecutionId:null,enrollmentId:null,stepCompleted:false});
 expect(await readStepExecution(f.ctx,stepId)).toMatchObject({state:'pending'});
 expect(await readFence(f.ctx,f.message.fenceId)).toMatchObject({firmId:f.firm.firmId,draftId:f.source.id});
});

it('restores a lost human fence on its original question and never submits that confirmed reply again',async()=>{
 const f=await restoredHumanSource();
 const recovered=await withTransaction(f.ctx.db,()=>recoverSentFolderMessage(f.ctx,{mailbox:f.mailbox,message:f.message}));
 expect(recovered).toMatchObject({outcome:'tombstoned',outboundMessageId:f.message.fenceId,stepExecutionId:null,enrollmentId:null,stepCompleted:false});
 expect(await readFence(f.ctx,f.message.fenceId)).toMatchObject({state:'sent',originKind:'draft',draftId:f.source.id,stepExecutionId:null,enrollmentId:null,providerMessageId:f.message.providerMessageId});
 expect(await withTransaction(f.ctx.db,()=>recoverSentFolderMessage(f.ctx,{mailbox:f.mailbox,message:f.message}))).toMatchObject({outcome:'present',outboundMessageId:f.message.fenceId,state:'sent'});
 expect(await dispatchOutboundMessage(f.ctx,world.sendDeps(world.alpha),{outboundMessageId:f.message.fenceId})).toMatchObject({outcome:'already_terminal'});
 expect(world.alpha.gmail.sends).toHaveLength(0);
});

it('preparing the restored source reads its original sent tombstone instead of creating another draft fence',async()=>{
 const f=await restoredHumanSource();
 await withTransaction(f.ctx.db,()=>recoverSentFolderMessage(f.ctx,{mailbox:f.mailbox,message:f.message}));
 expect(await prepareHumanReplyFence(f.ctx,{draftId:f.source.id,mailboxId:f.mailbox.id,firmId:f.firm.firmId,contactId:f.firm.contactId,opportunityId:f.firm.opportunityId,address:f.firm.address,routeId:f.firm.routeId,routeVersion:1,subject:'A question',body:'Another human answer.\n\n',sourceZone:'Etc/UTC'})).toEqual({ok:true,value:{outboundMessageId:f.message.fenceId,created:false}});
 expect(world.alpha.gmail.sends).toHaveLength(0);
});

it('the real human preparation writes the source-bound marker before any provider submission',async()=>{
 const f=await restoredHumanSource();
 const prepared=await prepareHumanReplyFence(f.ctx,{draftId:f.source.id,mailboxId:f.mailbox.id,firmId:f.firm.firmId,contactId:f.firm.contactId,opportunityId:f.firm.opportunityId,address:f.firm.address,routeId:f.firm.routeId,routeVersion:1,subject:'A question',body:'An exact human answer.\n\n',sourceZone:'Etc/UTC'});
 if(!prepared.ok)throw new Error(prepared.reason);
 expect(await readFence(f.ctx,prepared.value.outboundMessageId)).toMatchObject({providerMessageIdHeader:`<fss.reply.${f.source.id}.${prepared.value.outboundMessageId}@example.test>`});
 expect(world.alpha.gmail.sends).toHaveLength(0);
});
