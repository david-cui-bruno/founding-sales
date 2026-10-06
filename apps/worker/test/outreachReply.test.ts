import {it,expect} from 'vitest';
import {routineReplyInterpretation} from '../src/outreach/replyInterpretation.ts';
import type {AnthropicMessagesTransport} from '@fss/domain/classification/anthropicClient.ts';
const input={messageText:'Can I see a demo?',contextText:'',blocks:[],human:true,matched:true,autoSubmitted:null};
it('uses Bedrock only and passes the full request through counting and dispatch',async()=>{
 const requests:unknown[]=[];
 const transport:AnthropicMessagesTransport={kind:'bedrock',countTokens:async request=>{requests.push(request);return 123;},create:async request=>{requests.push(request);return {stop_reason:'end_turn',content:[{type:'text',text:'{"kind":"review","reason":"no approved link"}'}],usage:{input_tokens:123,output_tokens:20}};}};
 const port=routineReplyInterpretation(transport);
 expect(await port.countInputTokens(input)).toBe(123);
 expect(await port.interpret(input)).toMatchObject({costEstimated:false});
 expect(requests[1]).toEqual(requests[0]);expect(requests[0]).toMatchObject({model:'claude-haiku-4-5',max_tokens:1024});
 const cash=routineReplyInterpretation({...transport,kind:'anthropic'});
 await expect(cash.countInputTokens(input)).rejects.toThrow('credit_route_unavailable');
 await expect(cash.interpret(input)).rejects.toThrow('credit_route_unavailable');
 expect(requests).toHaveLength(2);
});
it('does not accept truncated output, and treats missing usage as ambiguous spend',async()=>{
 const port=routineReplyInterpretation({kind:'bedrock',countTokens:async()=>1,create:async()=>({stop_reason:'max_tokens',content:[{type:'text',text:'partial'}]})});
 expect(await port.interpret(input)).toEqual({raw:'',costCents:0,costEstimated:true});
});
it('checkpoints more than one page of refused sources so an older valid question gets a job',async()=>{
 const {createOutboundWorld}=await import('@fss/domain/test/outbound/support/outboundWorld.ts');
 const {routineReplyFixture}=await import('@fss/domain/test/outreach/routineFixture.ts');
 const {recordMessage,storeMessageBody}=await import('@fss/domain/mail/messages.ts');
 const {recordMatches}=await import('@fss/domain/mail/matching.ts');
 const {withTransaction}=await import('@fss/domain/db/queryable.ts');
 const {outreachReplySource}=await import('../src/handlers/outreach.ts');
 const {randomUUID}=await import('node:crypto');
 const world=await createOutboundWorld();
 try{
  const f=await routineReplyFixture(world),db=f.ctx.db,w=f.ctx.scope.workspaceId;
  await db.query('DELETE FROM outreach_reply_deliveries WHERE request_id=$1',[f.requestId]);
  await db.query('DELETE FROM outreach_reply_requests WHERE id=$1',[f.requestId]);
  for(let i=0;i<26;i++){
   const m=await withTransaction(db,()=>recordMessage(f.ctx,{mailboxId:world.alpha.mailboxId,metadata:{providerMessageId:randomUUID(),providerThreadId:randomUUID(),rfcMessageId:`${randomUUID()}@example.test`,direction:'incoming',internalDate:new Date(Date.now()+1000+i).toISOString(),headerFrom:f.firm.address,headerTo:[world.alpha.address],headerCc:[],subject:'Automatic reply',referenceMessageIds:[],inReplyTo:null,autoSubmitted:'auto-replied',listId:null,labelIds:[],attachments:[]}}));
   await withTransaction(db,async()=>{await recordMatches(f.ctx,{messageId:m.message.id,candidates:[{firmId:f.firm.firmId,contactId:f.firm.contactId,opportunityId:null,outreachPlanId:f.plan,rule:'participant',viaClosedOpportunity:false}]});await storeMessageBody(f.ctx,{messageId:m.message.id,text:'Automatic reply',truncated:false});});
  }
  const source=outreachReplySource();
  for(let i=0;i<2;i++)await withTransaction(db,()=>source.find(db,new Date(Date.now()+3000+i).toISOString()));
  expect((await db.query('SELECT state FROM outreach_reply_requests WHERE workspace_id=$1 AND original_message_id=$2',[w,f.messageId])).rows).toEqual([{state:'queued'}]);
  expect((await db.query("SELECT count(*)::int AS n FROM outreach_reply_requests WHERE workspace_id=$1 AND state IN ('no_reply','review')",[w])).rows).toEqual([{n:26}]);
 }finally{await world.stop();}
});
