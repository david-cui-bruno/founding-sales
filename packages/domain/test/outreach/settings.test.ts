import {afterEach,expect,it,vi} from 'vitest';
import {existsSync,readFileSync} from 'node:fs';
import * as settings from '../../outreach/settings.ts';
import * as run from '../../outreach/replyRun.ts';
import * as delivery from '../../outreach/replyDelivery.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import type {Queryable,QueryResultRowLike} from '../../db/queryable.ts';
import * as fences from '../../outbound/fence.ts';
import * as incidents from '../../outbound/providerIncidents.ts';
import * as sync from '../../mail/sync.ts';
import * as holds from '../../policy/holds.ts';
import * as humanDelivery from '../../replies/delivery.ts';
import * as meetingDelivery from '../../meetings/followThroughDelivery.ts';
import {reconcileOutboundMessage,type ReconcileDeps} from '../../outbound/reconcile.ts';
const id='10000000-0000-4000-8000-000000000001';
afterEach(()=>vi.restoreAllMocks());
function context(rows:unknown[]=[]){
 const query=vi.fn(async(_text:string,_values?:readonly unknown[])=>({rows,rowCount:rows.length}));
 const db:Queryable={query:async<R extends QueryResultRowLike>(text:string,values?:readonly unknown[])=>{const result=await query(text,values);return {rows:result.rows as R[],rowCount:result.rowCount};}};
 return {ctx:repositoryContext(workspaceScope(id,{kind:'user',userId:id,role:'admin'}),db),query};
}
it('has no automatic incoming configuration, request, inference or preparation command',()=>{
 expect('saveRoutineSettings' in settings).toBe(false);
 expect(existsSync(new URL('../../outreach/replyRequests.ts',import.meta.url))).toBe(false);
 expect('runRoutineReply' in run).toBe(false);
 expect('prepareRoutineReply' in delivery).toBe(false);
});
it('removes obsolete worker adapter and registration rather than keeping a dormant model path',()=>{
 expect(existsSync(new URL('../../../../apps/worker/src/outreach/replyInterpretation.ts',import.meta.url))).toBe(false);
 const bootstrap=readFileSync(new URL('../../../../apps/worker/src/bootstrap/main.ts',import.meta.url),'utf8');
 expect(/outreachReplyHandler|routineReplyInterpretation/u.test(bootstrap)).toBe(false);
 expect(bootstrap).toContain('outreachReplySource()');
});
it('reads historical settings as history, not as authority to enable new incoming work',async()=>{
 const {ctx}=context([{revision:7,routine_replies_enabled:true,reply_sequence_version_id:id,booking_url:'https://cal.com/founder/demo'}]);
 expect(await settings.readRoutineSettings(ctx)).toEqual({revision:7,enabled:false,sequenceVersionId:id,bookingUrl:'https://cal.com/founder/demo'});
});
it('refuses even historical routine permissions before reading mutable sources',async()=>{
 const {ctx,query}=context();
 const permission={scope:'routine_reply'} as Parameters<typeof delivery.verifyRoutinePermission>[1];
 const subject={} as Parameters<typeof delivery.verifyRoutinePermission>[2];
 expect(await delivery.verifyRoutinePermission(ctx,permission,subject)).toBe('automatic_incoming_retired');
 expect(query).not.toHaveBeenCalled();
});
it('does not produce new draft bytes from a previously prepared routine execution',async()=>{
 const {ctx}=context([{request_id:id,execution_id:id}]);
 expect(await delivery.routineDraftForExecution(ctx,id)).toEqual({ok:false,reason:'automatic_incoming_retired'});
});
it('leaves nonroutine executions alone',async()=>{
 const {ctx}=context();
 expect(await delivery.routineDraftForExecution(ctx,id)).toBeNull();
});
it('retains frozen historical threading without reinterpreting old incoming content',async()=>{
 const {ctx,query}=context([{thread_id:'old-thread',reply_to:'old-message@example.test',reference_ids:['original@example.test']}]);
 expect(await delivery.routineReplyThreading(ctx,id)).toEqual({threadId:'old-thread',inReplyTo:'old-message@example.test',references:['original@example.test']});
 expect(query).toHaveBeenCalledTimes(1);
});
it.each([false,true])('reconciles a retained UNKNOWN without invoking fresh-reply gates or resending, found=%s',async(found)=>{
 const {ctx,query}=context();
 const historical={id,mailboxId:id,state:'reconciling',stepExecutionId:id,reconcileAttempts:0,providerMessageIdHeader:'retained@example.test',reconcileDeadlineAt:'2026-10-28T00:00:00Z',subject:'Historical bytes',body:'Historical body',renderedHash:'a'.repeat(64)} as fences.OutboundFenceRow;
 vi.spyOn(fences,'readFence').mockResolvedValue(historical);
 vi.spyOn(incidents,'readProviderIncidents').mockResolvedValue([]);
 vi.spyOn(incidents,'readProviderBinding').mockResolvedValue(null);
 vi.spyOn(sync,'accessForMailbox').mockResolvedValue({ok:true,access:{}} as Awaited<ReturnType<typeof sync.accessForMailbox>>);
 const settled=vi.spyOn(fences,'recordReconciledSent').mockResolvedValue({ok:true,value:{...historical,state:'sent',sentAt:'2026-10-26T00:00:00Z'}});
 const missed=vi.spyOn(fences,'recordReconcileMiss').mockResolvedValue(1);
 vi.spyOn(humanDelivery,'recordHumanReplyDelivery').mockResolvedValue();
 vi.spyOn(meetingDelivery,'recordMeetingDelivery').mockResolvedValue();
 vi.spyOn(holds,'releaseHoldsOfEvent').mockResolvedValue([]);
 const gate=vi.spyOn(delivery,'verifyRoutineReplyFence');
 const sendMessage=vi.fn();
 const searchSentByMessageId=vi.fn(async()=>({ok:true as const,found:found?{messageId:'historical-provider-id',threadId:'historical-thread'}:null}));
 const deps={gmail:{sendMessage,searchSentByMessageId},oauth:{},cipher:{},now:()=>new Date('2026-10-27T00:00:00Z')} as unknown as ReconcileDeps;
 expect((await reconcileOutboundMessage(ctx,deps,{outboundMessageId:id})).outcome).toBe(found?'sent':'still_unknown');
 expect(searchSentByMessageId).toHaveBeenCalledWith({},'retained@example.test');
 expect(sendMessage).not.toHaveBeenCalled();expect(gate).not.toHaveBeenCalled();
 expect(settled).toHaveBeenCalledTimes(found?1:0);expect(missed).toHaveBeenCalledTimes(found?0:1);
 if(found)expect(query.mock.calls.some(([sql,values])=>sql.includes("r.state='ready'")&&sql.includes("f.state='sent'")&&values?.[1]===id)).toBe(true);
 else expect(query).not.toHaveBeenCalled();
 expect(historical).toMatchObject({subject:'Historical bytes',body:'Historical body',renderedHash:'a'.repeat(64),providerMessageIdHeader:'retained@example.test'});
});
