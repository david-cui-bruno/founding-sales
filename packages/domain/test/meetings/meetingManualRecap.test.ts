import { fixtureMessage } from '../mail/support/mailWorld.ts';
import { runMailSync } from '../../mail/sync.ts';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { readMessage } from '../../mail/messages.ts';
import { applyDirectSendEffects } from '../../mail/effects.ts';
import { dispatchOutboundMessage } from '../../outbound/send.ts';
import { readMeetingFollowThrough, readMeetingPlan, appendMeetingDraft } from '../../meetings/followThrough.ts';
import { meetingDeliveryHistory, finalizeMeetingFollowThrough } from '../../meetings/followThroughJobs.ts';
import { meetingDispatchFixture } from './support/meetingDispatchFixture.ts';

describe('manual Gmail recap fulfillment', () => {
  let f: Awaited<ReturnType<typeof meetingDispatchFixture>> | undefined;
  afterEach(async () => { await f?.world.stop(); });
  it('fetches the relevant matched outgoing body through the real mail importer', async () => {
    f=await meetingDispatchFixture({steps:3}); const x=f;
    await x.db.query("UPDATE mailboxes SET history_id='1000' WHERE id=$1",[x.world.alpha.mailboxId]);
    x.world.alpha.messages.push(fixtureMessage({id:'manual-recap',historyId:'1800',from:x.world.alpha.address,to:x.address,labelIds:['SENT'],subject:x.draft.subject,body:x.draft.body,internalDateEpochMilliseconds:Date.parse(x.at)}));
    const result=await withTransaction(x.db,()=>runMailSync(x.context,x.world.syncDeps(x.world.alpha),{mailboxId:x.world.alpha.mailboxId}));
    expect(result.directSendsRecorded).toBe(1);
    expect(await readMeetingFollowThrough(x.admin,{meetingId:x.meetingId})).toMatchObject({currentDraft:{state:'sent'}});
    expect(x.world.alpha.gmail.bodyReads).toContain('manual-recap');
  });
  it.each(['exact','different','truncated','extra_recipient'])('uses actual %s mail without a duplicate recap', async kind => {
    const url = 'https://example.test/guide';
    f = await meetingDispatchFixture({ steps: 3, material: url }); const x = f;
    const taskId = (await x.db.query<{ id: string }>(`INSERT INTO meeting_tasks(workspace_id,meeting_id,firm_id,commitment_id,label,owner_user_id,deadline,due_at,evidence)
      VALUES($1,$2,$3,'guide',$4,$5,$6::jsonb,$7,$8::jsonb) RETURNING id`, [x.workspace,x.meetingId,x.firmId,`Send ${url}`,x.world.alpha.workspace.salesperson.userId,JSON.stringify({precision:'date',localDate:x.at.slice(0,10),zone:'Etc/UTC'}),x.at,JSON.stringify([{kind:'debrief',revision:1,quote:`Send ${url}`,startOffset:0,endOffset:5+url.length}])])).rows[0]!.id;
    expect(await withTransaction(x.db, async () => appendMeetingDraft(x.context,(await readMeetingPlan(x.context,x.planId))!,{subject:x.draft.subject,body:x.draft.body,templateVersionId:x.templateVersionId,sourceHash:x.draft.sourceHash,materialReferences:[url],at:new Date(Date.parse(x.at)-40*60_000).toISOString()}))).toMatchObject({ok:true});
    const fence = await x.prepare();
    const messageId = (await x.db.query<{ id: string }>(`INSERT INTO mail_messages(workspace_id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date,header_from,header_to,header_cc,subject,matched)
      VALUES($1,$2,$3,$3,'outgoing',$4,$5,$6::text[],'{}',$7,true) RETURNING id`, [x.workspace,x.world.alpha.mailboxId,randomUUID(),x.at,x.world.alpha.address,kind === 'extra_recipient' ? [x.address,'someone@example.test'] : [x.address],x.draft.subject])).rows[0]!.id;
    await x.db.query('INSERT INTO mail_message_bodies(workspace_id,mail_message_id,body_text,truncated) VALUES($1,$2,$3,$4)', [x.workspace,messageId,kind === 'different' ? 'Another topic.' : x.draft.body,kind === 'truncated']);
    const message = (await readMessage(x.context,messageId))!;
    const candidate = { firmId:x.firmId,contactId:x.contactId,opportunityId:x.opportunityId,rule:'thread' as const,viaClosedOpportunity:false };
    for(let n=0;n<2;n++) await withTransaction(x.db,()=>applyDirectSendEffects(x.context,{message,candidate}));
    if (kind === 'exact') {
      expect(await readMeetingFollowThrough(x.admin,{meetingId:x.meetingId})).toMatchObject({status:'awaiting_reply',currentDraft:{state:'sent'}});
      expect(await meetingDeliveryHistory(x.context,x.planId)).toEqual([{ordinal:1,messageId,sentAt:x.at}]);
      expect((await x.db.query('SELECT ordinal,state FROM step_executions WHERE enrollment_id=(SELECT enrollment_id FROM meeting_follow_through WHERE id=$1) ORDER BY ordinal',[x.planId])).rows).toEqual([{ordinal:1,state:'completed'},{ordinal:2,state:'pending'}]);
    } else {
      expect(await readMeetingFollowThrough(x.admin,{meetingId:x.meetingId})).toMatchObject({status:'needs_review',blockers:expect.arrayContaining(['manual_email_review'])});
      expect(await meetingDeliveryHistory(x.context,x.planId)).toEqual([]);
    }
    await withTransaction(x.db,()=>finalizeMeetingFollowThrough(x.context,{meetingId:x.meetingId,at:x.at}));
    expect((await x.db.query('SELECT status FROM meeting_tasks WHERE id=$1',[taskId])).rows).toEqual([{status:kind === 'exact' ? 'done' : 'open'}]);
    const gmail=x.world.clientWith(x.world.alpha,{});
    await dispatchOutboundMessage(x.context,x.world.sendDeps(x.world.alpha,{gmail,now:()=>new Date(x.at)}),{outboundMessageId:fence.id});
    expect(gmail.sends).toHaveLength(0);
  });
});
