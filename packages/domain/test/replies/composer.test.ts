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

let world:OutboundWorld;
beforeAll(async()=>{world=await createOutboundWorld();});
afterAll(async()=>world.stop());
async function fixture(){
 const ctx=repositoryContext(workspaceScope(world.alpha.workspace.workspaceId,{kind:'user',userId:world.alpha.workspace.salesperson.userId,role:'salesperson'}),world.database.session);
 const admin=repositoryContext(workspaceScope(ctx.scope.workspaceId,{kind:'user',userId:world.alpha.workspace.admin.userId,role:'admin'}),ctx.db);
 const tx=<T>(work:()=>Promise<T>)=>withTransaction(world.database.session,work);
 const firm=await seedFirm(world,world.alpha,'human-composer');
 const auth=(await ctx.db.query<{revision:number}>('SELECT revision FROM gmail_prospecting_authorizations WHERE workspace_id=$1 AND mailbox_id=$2',[ctx.scope.workspaceId,world.alpha.mailboxId])).rows[0];
 await tx(()=>setProspectingAuthorization(admin,{mailboxId:world.alpha.mailboxId,expectedRevision:auth?.revision??0,enabled:true,basis:'owner_reported_google_permission'}));
 const threadId=randomUUID();
 const message=await tx(()=>recordMessage(ctx,{mailboxId:world.alpha.mailboxId,metadata:{providerMessageId:randomUUID(),providerThreadId:threadId,rfcMessageId:`${threadId}@example.test`,direction:'incoming',internalDate:new Date().toISOString(),headerFrom:firm.address,headerTo:[world.alpha.address],headerCc:[],subject:'Can you help?',referenceMessageIds:[],inReplyTo:null,autoSubmitted:null,listId:null,labelIds:[],attachments:[]}}));
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
