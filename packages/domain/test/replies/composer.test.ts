import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createOutboundWorld,type OutboundWorld} from '../outbound/support/outboundWorld.ts';
import {seedFirm} from '../outbound/support/dispatchFixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {recordMessage,storeMessageBody} from '../../mail/messages.ts';
import {recordMatches} from '../../mail/matching.ts';
import {setProspectingAuthorization} from '../../outreach/authorization.ts';
import {saveAnswerBlock,approveAnswerBlock} from '../../outreach/facts.ts';
import {readReplyDraftContext} from '../../replies/composer.ts';
import {applyDirectSendEffects} from '../../mail/effects.ts';
import {recordSuppression} from '../../suppression/events.ts';
import {recordingSuppressionJournal} from '../../suppression/journal.ts';
import {generateReplyDraft,type HumanReplyDraftPort} from '../../replies/composerGeneration.ts';
import {openHold} from '../../policy/holds.ts';
import {humanReplyDraftInterpretation} from '../../replies/composerModel.ts';

let world:OutboundWorld;
beforeAll(async()=>{world=await createOutboundWorld();});
afterAll(async()=>world.stop());
async function fixture(cc:string[]=[]){
 const ctx=repositoryContext(workspaceScope(world.alpha.workspace.workspaceId,{kind:'user',userId:world.alpha.workspace.salesperson.userId,role:'salesperson'}),world.database.session);
 const admin=repositoryContext(workspaceScope(ctx.scope.workspaceId,{kind:'user',userId:world.alpha.workspace.admin.userId,role:'admin'}),ctx.db);
 const tx=<T>(work:()=>Promise<T>)=>withTransaction(world.database.session,work);
 const firm=await seedFirm(world,world.alpha,'human-composer');
 const auth=(await ctx.db.query<{revision:number}>('SELECT revision FROM gmail_prospecting_authorizations WHERE workspace_id=$1 AND mailbox_id=$2',[ctx.scope.workspaceId,world.alpha.mailboxId])).rows[0];
 await tx(()=>setProspectingAuthorization(admin,{mailboxId:world.alpha.mailboxId,expectedRevision:auth?.revision??0,enabled:true,basis:'owner_reported_google_permission'}));
 const threadId=randomUUID();
 const message=await tx(()=>recordMessage(ctx,{mailboxId:world.alpha.mailboxId,metadata:{providerMessageId:randomUUID(),providerThreadId:threadId,rfcMessageId:`${threadId}@example.test`,direction:'incoming',internalDate:new Date().toISOString(),headerFrom:firm.address,headerTo:[world.alpha.address],headerCc:cc,subject:'Can you help?',referenceMessageIds:[],inReplyTo:null,autoSubmitted:null,listId:null,labelIds:[],attachments:[]}}));
 await tx(()=>recordMatches(ctx,{messageId:message.message.id,candidates:[{firmId:firm.firmId,contactId:firm.contactId,opportunityId:firm.opportunityId,rule:'participant',viaClosedOpportunity:false}]}));
 await tx(()=>storeMessageBody(ctx,{messageId:message.message.id,text:'Could you explain what Callie does? Pricing is still open for discussion.',truncated:false}));
 const saved=await tx(()=>saveAnswerBlock(admin,{kind:'product',text:'Callie helps existing property teams coordinate maintenance requests.'}));
 if(!saved.ok)throw new Error(saved.reason);
 await tx(()=>approveAnswerBlock(admin,{id:saved.value.id,version:1}));
 return {ctx,admin,tx,firm,messageId:message.message.id,threadId,ref:{id:saved.value.id,version:1}};
}

it('prepares a human draft context with exact approved facts and visible envelope while routine replies are off',async()=>{
 const f=await fixture();
 const context=await readReplyDraftContext(f.ctx,{messageId:f.messageId,factRefs:[f.ref]});
 expect(context).toMatchObject({ok:true,value:{messageId:f.messageId,firmId:f.firm.firmId,contactId:f.firm.contactId,authorUserId:world.alpha.workspace.salesperson.userId,mailboxId:world.alpha.mailboxId,authorAddress:world.alpha.address,providerThreadId:f.threadId,inReplyTo:`${f.threadId}@example.test`,envelope:{to:[f.firm.address],cc:[]},observedTo:[world.alpha.address],observedCc:[],replyToMetadata:'unavailable',facts:[{...f.ref,text:'Callie helps existing property teams coordinate maintenance requests.'}]}});
});

it('marks a verified manual answer in the same thread stale instead of generating another answer',async()=>{
 const f=await fixture();
 const outgoing=await f.tx(()=>recordMessage(f.ctx,{mailboxId:world.alpha.mailboxId,metadata:{providerMessageId:randomUUID(),providerThreadId:f.threadId,rfcMessageId:`${randomUUID()}@example.test`,direction:'outgoing',internalDate:new Date(Date.now()+1000).toISOString(),headerFrom:world.alpha.address,headerTo:[f.firm.address],headerCc:[],subject:'Answer',referenceMessageIds:[],inReplyTo:null,autoSubmitted:null,listId:null,labelIds:['SENT'],attachments:[]}}));
 await f.tx(()=>applyDirectSendEffects(f.ctx,{message:outgoing.message,candidate:{firmId:f.firm.firmId,contactId:f.firm.contactId,opportunityId:f.firm.opportunityId,rule:'participant',viaClosedOpportunity:false}}));
 expect(await readReplyDraftContext(f.ctx,{messageId:f.messageId,factRefs:[f.ref]})).toEqual({ok:false,reason:'answered_manually'});
});

it('refuses a current opt-out instead of offering a source-authorized draft',async()=>{
 const f=await fixture();
 await f.tx(()=>recordSuppression(f.ctx,{scope:'firm',firmId:f.firm.firmId,source:'prospect_opt_out',channel:'email',commandId:randomUUID(),journal:recordingSuppressionJournal()}));
 expect(await readReplyDraftContext(f.ctx,{messageId:f.messageId,factRefs:[f.ref]})).toEqual({ok:false,reason:'conversation_stopped'});
});

it('a recipient-handle opt-out also refuses preparation',async()=>{
 const f=await fixture();
 const stop=await f.tx(()=>recordSuppression(f.ctx,{scope:'handle',value:f.firm.address,firmId:f.firm.firmId,source:'prospect_opt_out',channel:'email',commandId:randomUUID(),journal:recordingSuppressionJournal()}));if(!stop.ok)throw new Error(stop.reason);
 expect(await readReplyDraftContext(f.ctx,{messageId:f.messageId,factRefs:[f.ref]})).toEqual({ok:false,reason:'conversation_stopped'});
});

it('generates a reviewed plain-text suggestion once without sending an email',async()=>{
 const f=await fixture(),source=await readReplyDraftContext(f.ctx,{messageId:f.messageId,factRefs:[f.ref]});if(!source.ok)throw new Error(source.reason);
 let paidCalls=0;
 const port:HumanReplyDraftPort={providerKey:'aws_bedrock.outreach_reply',countInputTokens:async()=>100,compose:async()=>{paidCalls++;return {raw:JSON.stringify({text:'Callie helps existing property teams coordinate maintenance requests. Pricing is not defined yet.',factRefs:[f.ref],unsupportedClaims:['Pricing needs a human answer.']}),costCents:1,costEstimated:false};}};
 const input={commandId:randomUUID(),clientVersion:'1.0.0',messageId:f.messageId,sourceRevision:source.value.sourceRevision,factRefs:[f.ref],envelope:source.value.envelope};
 const generated=await generateReplyDraft(f.ctx,input,port);
 expect(generated).toMatchObject({ok:true,value:{text:'Callie helps existing property teams coordinate maintenance requests. Pricing is not defined yet.',sourceRevision:source.value.sourceRevision,factRefs:[f.ref],reviewRequired:true,reviewNotes:expect.arrayContaining(['Pricing needs a human answer.'])}});
 expect(await generateReplyDraft(f.ctx,input,port)).toEqual({ok:false,reason:'generation_already_attempted'});
 expect(paidCalls).toBe(1);expect(world.alpha.gmail.sends).toHaveLength(0);
});

it('discards a model suggestion when a new sending hold changes the conversation authority during generation',async()=>{
 const f=await fixture(),source=await readReplyDraftContext(f.ctx,{messageId:f.messageId,factRefs:[f.ref]});if(!source.ok)throw new Error(source.reason);
 const port:HumanReplyDraftPort={providerKey:'aws_bedrock.outreach_reply',countInputTokens:async()=>100,compose:async()=>{
  await f.tx(()=>openHold(f.admin,{scopeKind:'firm',scopeKey:f.firm.firmId,reasonCode:'scoped_pause',blockedActionKinds:['email_send'],sourceEventKind:'fixture'}));
  return {raw:JSON.stringify({text:'Callie helps coordinate maintenance requests.',factRefs:[f.ref],unsupportedClaims:[]}),costCents:1,costEstimated:false};
 }};
 expect(await generateReplyDraft(f.ctx,{commandId:randomUUID(),clientVersion:'1.0.0',messageId:f.messageId,sourceRevision:source.value.sourceRevision,factRefs:[f.ref],envelope:source.value.envelope},port)).toEqual({ok:false,reason:'source_changed'});
});

it('uses the bounded approved model transport to prepare plain text rather than routine reply selection',async()=>{
 const f=await fixture(),source=await readReplyDraftContext(f.ctx,{messageId:f.messageId,factRefs:[f.ref]});if(!source.ok)throw new Error(source.reason);
 const port=humanReplyDraftInterpretation({kind:'bedrock',countTokens:async()=>100,create:async request=>{
  expect(request.max_tokens).toBe(1024);
  return {stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({text:'Callie helps existing property teams coordinate maintenance requests.',factRefs:[f.ref],unsupportedClaims:[]})}],usage:{input_tokens:100,output_tokens:40}};
 }});
 expect(await generateReplyDraft(f.ctx,{commandId:randomUUID(),clientVersion:'1.0.0',messageId:f.messageId,sourceRevision:source.value.sourceRevision,factRefs:[f.ref],envelope:source.value.envelope},port)).toMatchObject({ok:true,value:{reviewRequired:true,text:'Callie helps existing property teams coordinate maintenance requests.'}});
 expect(world.alpha.gmail.sends).toHaveLength(0);
});

it('does not turn an invented price and commitment into a suggested answer',async()=>{
 const f=await fixture(),source=await readReplyDraftContext(f.ctx,{messageId:f.messageId,factRefs:[f.ref]});if(!source.ok)throw new Error(source.reason);
 const port:HumanReplyDraftPort={providerKey:'aws_bedrock.outreach_reply',countInputTokens:async()=>100,compose:async()=>({raw:JSON.stringify({text:'It costs $99 per month and we will launch tomorrow.',factRefs:[f.ref],unsupportedClaims:[]}),costCents:1,costEstimated:false})};
 expect(await generateReplyDraft(f.ctx,{commandId:randomUUID(),clientVersion:'1.0.0',messageId:f.messageId,sourceRevision:source.value.sourceRevision,factRefs:[f.ref],envelope:source.value.envelope},port)).toEqual({ok:false,reason:'generation_unsupported_claim'});
});

it('a historical author address in CC never becomes an allowed prospect recipient',async()=>{
 const former='former.owner@example.test',f=await fixture([former]);
 await f.ctx.db.query('INSERT INTO mailbox_accounts(workspace_id,mailbox_id,email_address,active_from,active_until,generation_from) VALUES($1,$2,$3,now()-interval \'10 days\',now()-interval \'1 day\',1)',[f.ctx.scope.workspaceId,world.alpha.mailboxId,former]);
 await f.ctx.db.query("INSERT INTO email_addresses(workspace_id,firm_id,contact_id,address,source,retrieved_at,association_confidence,technical_validation,eligibility,eligibility_policy_version) VALUES($1,$2,$3,$4,'reply',now(),0.9,'passed','usable','fixture')",[f.ctx.scope.workspaceId,f.firm.firmId,f.firm.contactId,former]);
 const current=await readReplyDraftContext(f.ctx,{messageId:f.messageId,factRefs:[f.ref]});if(!current.ok)throw new Error(current.reason);
 expect(current.value.recipientOptions).not.toContainEqual({address:former,contactId:f.firm.contactId});
});
