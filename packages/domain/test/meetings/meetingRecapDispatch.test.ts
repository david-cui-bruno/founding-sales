import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { editMeetingRecap, readMeetingFollowThrough } from '../../meetings/followThrough.ts';
import { meetingDraftForExecution, verifyMeetingFence, recordMeetingDelivery } from '../../meetings/followThroughDelivery.ts';
import { saveMeetingNotes } from '../../meetings/notes.ts';
import { dispatchOutboundMessage } from '../../outbound/send.ts';
import { readFence } from '../../outbound/fence.ts';
import { reconcileOutboundMessage } from '../../outbound/reconcile.ts';
import { pausingAtTokenRefresh } from '../outbound/support/dispatchFixtures.ts';
import { recordSuppression } from '../../suppression/events.ts';
import { openHold } from '../../policy/holds.ts';
import { meetingDispatchFixture } from './support/meetingDispatchFixture.ts';

describe('recaps use the real provider boundary', () => {
  let f: Awaited<ReturnType<typeof meetingDispatchFixture>>;
  beforeEach(async () => { f = await meetingDispatchFixture(); });
  afterEach(async () => { await f?.world.stop(); });
  async function edit(action: 'begin_edit' | 'cancel') {
    const view = (await readMeetingFollowThrough(f.admin, { meetingId: f.meetingId }))!;
    return await withTransaction(f.db, () => editMeetingRecap(f.admin, { planId: f.planId, expectedPlanVersion: view.version, expectedDraftVersion: view.currentDraft!.version, action }, f.at));
  }
  it('sends exactly the current reviewed draft once; only delivery updates its state', async () => {
    const draft = await meetingDraftForExecution(f.context, { executionId: f.executionId, at: f.at }); expect(draft.ok).toBe(true);
    const fence = await f.prepare();
    expect(fence.renderedHash).toBe(f.draft.renderedHash);
    expect((await readMeetingFollowThrough(f.admin, { meetingId: f.meetingId }))!.currentDraft!.state).toBe('ready');
    const gmail = f.world.clientWith(f.world.alpha, {});
    const deps = f.world.sendDeps(f.world.alpha, { gmail, now: () => new Date(f.at) });
    expect(await dispatchOutboundMessage(f.context, deps, { outboundMessageId: fence.id })).toMatchObject({ outcome: 'sent' });
    expect(gmail.sends).toHaveLength(1);
    expect(gmail.sends[0]).toMatchObject({ subject: f.draft.subject, body: f.draft.body });
    expect((await readMeetingFollowThrough(f.admin, { meetingId: f.meetingId }))!.currentDraft!.state).toBe('sent');
    await recordMeetingDelivery(f.context, { executionId: f.executionId, messageId: fence.id, sentAt: f.at });
    await dispatchOutboundMessage(f.context, deps, { outboundMessageId: fence.id });
    expect(gmail.sends).toHaveLength(1);
  });
  it.each(['edit', 'cancel', 'notes', 'reassignment', 'pause', 'stop', 'reply'] as const)('%s committed during OAuth wins before claim', async change => {
    const fence = await f.prepare(), gmail = f.world.clientWith(f.world.alpha, {});
    const paused = pausingAtTokenRefresh(gmail, async () => {
      if (change === 'edit' || change === 'cancel') expect((await edit(change === 'edit' ? 'begin_edit' : 'cancel')).ok).toBe(true);
      if (change === 'notes') await withTransaction(f.db, () => saveMeetingNotes(f.admin, { meetingId: f.meetingId, expectedRevision: 1, debrief: 'Corrected notes.', sufficient: true, speakerMappings: [], itemOverrides: [] }));
      if (change === 'reassignment') await f.db.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1', [f.firmId, f.world.alpha.workspace.admin.userId]);
      if (change === 'pause') await f.db.query('UPDATE sending_domains SET automated_sending_enabled=false,automated_sending_enabled_at=NULL WHERE workspace_id=$1', [f.workspace]);
      if (change === 'stop') expect(await withTransaction(f.db, () => recordSuppression(f.admin, { scope: 'firm', firmId: f.firmId, source: 'prospect_opt_out', channel: 'all', journal: f.world.journal }))).toMatchObject({ ok: true });
      if (change === 'reply') await withTransaction(f.db, () => openHold(f.context, { scopeKind: 'opportunity', scopeKey: f.opportunityId, reasonCode: 'uncertain_reply', blockedActionKinds: ['email_send','enrollment_advance'], sourceEventKind: 'mail_message', recoveryAction: 'confirm_reply' }));
    });
    const result = await dispatchOutboundMessage(f.context, f.world.sendDeps(f.world.alpha, { gmail: paused.client, now: () => new Date(f.at) }), { outboundMessageId: fence.id });
    expect(paused.refreshes()).toBe(1);
    expect(result.outcome).not.toBe('sent'); expect(gmail.sends).toHaveLength(0);
  });
  it('a changed draft waits thirty minutes and replaces the unsubmitted fence bytes', async () => {
    const fence = await f.prepare(); await edit('begin_edit');
    const view = (await readMeetingFollowThrough(f.admin, { meetingId: f.meetingId }))!;
    const saved = await withTransaction(f.db, () => editMeetingRecap(f.admin, { planId: f.planId, expectedPlanVersion: view.version, expectedDraftVersion: view.currentDraft!.version, action: 'save', subject: 'Corrected next steps', body: 'Thanks. Here are the corrected details.\n\nSigned off' }, f.at));
    expect(saved.ok).toBe(true);
    expect(await verifyMeetingFence(f.context, { fenceId: fence.id, at: f.at })).toMatchObject({ ok: false });
    const later = new Date(Date.parse(f.at) + 31 * 60_000).toISOString();
    expect(await meetingDraftForExecution(f.context, { executionId: f.executionId, at: later })).toMatchObject({ ok: true, value: { subject: 'Corrected next steps', draftVersion: 2 } });
    expect(await verifyMeetingFence(f.context, { fenceId: fence.id, at: later })).toMatchObject({ ok: true });
    expect((await readFence(f.context, fence.id))!.subject).toBe('Corrected next steps');
  });
  it('an ambiguous provider result prevents editing and resend until reconciliation proves delivery', async () => {
    const fence = await f.prepare();
    const gmail = f.world.clientWith(f.world.alpha, { sendBehaviour: 'indeterminate_but_delivered' });
    const deps = f.world.sendDeps(f.world.alpha, { gmail, now: () => new Date(f.at) });
    expect(await dispatchOutboundMessage(f.context, deps, { outboundMessageId: fence.id })).toMatchObject({ outcome: 'reconciling' });
    expect(await edit('begin_edit')).toMatchObject({ ok: false, reason: 'delivery_in_progress' });
    await dispatchOutboundMessage(f.context, deps, { outboundMessageId: fence.id });
    expect(gmail.sends).toHaveLength(1);
    const found = gmail;
    expect(await reconcileOutboundMessage(f.context, f.world.reconcileDeps(f.world.alpha, { gmail: found }), { outboundMessageId: fence.id })).toMatchObject({ outcome: 'sent' });
    expect((await readMeetingFollowThrough(f.admin, { meetingId: f.meetingId }))!.currentDraft!.state).toBe('sent');
  });
});
