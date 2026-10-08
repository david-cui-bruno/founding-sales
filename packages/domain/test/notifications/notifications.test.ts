import { afterEach, describe, expect, it } from 'vitest';
import { createClassifierWorld, type ClassifierWorld } from '../classification/support/classifierWorld.ts';
import { REPLY_CORPUS } from '../corpus/replies/cases.ts';
import { withTransaction } from '../../db/queryable.ts';
import { confirmReplyDisposition } from '../../classification/confirmations.ts';
import { readNotificationCandidates } from '../../notifications/actions.ts';
import { randomUUID } from 'node:crypto';
import { claimNotification, readActionableNotifications, observeNotification, acknowledgeNotification } from '../../notifications/ledger.ts';
import { repositoryContext } from '../../db/workspaceScope.ts';
import { readTodayActions } from '../../today/actions.ts';
import { reassignFirm } from '../../crm/firms.ts';
import { insertOrReviveMailbox, markMailboxDisconnected } from '../../mail/mailboxes.ts';
import { previewDeletion, commitDeletion } from '../../retention/deletion.ts';
import { commitDeparture } from '../../retention/departure.ts';
import { runRetentionBatch } from '../../retention/runs.ts';
import { openHold, releaseHold } from '../../policy/holds.ts';

let world: ClassifierWorld | null = null;
afterEach(async () => { await world?.stop(); world = null; });

describe('actionable notifications', () => {
  it('offers the current reply at night and one reminder at its business-day deadline, using the same Today source identity', async () => {
    world = await createClassifierWorld({ cases: REPLY_CORPUS.filter(c => c.id === 'terse-human-reply') });
    await withTransaction(world.mail.database.session, async () => await confirmReplyDisposition(world!.context(), { messageId: world!.messageIdOf('terse-human-reply'), disposition: 'interested', journal: world!.mail.journal }));
    const actionId = `reply-message:${world.messageIdOf('terse-human-reply')}`;
    const night = await readNotificationCandidates(world.context(), { now: '2026-09-11T03:00:00.000Z' });
    expect(night).toMatchObject([{ actionId, phase: 'attention', target: { kind: 'reply', messageId: world.messageIdOf('terse-human-reply') } }]);
    expect(night).toHaveLength(1);
    const overdue = await readNotificationCandidates(world.context(), { now: '2026-09-11T14:00:00.000Z' });
    expect(overdue).toMatchObject([{ actionId, phase: 'reply_overdue', dueAt: '2026-09-11T14:00:00.000Z' }]);
    expect(overdue).toHaveLength(1);
    expect((await readNotificationCandidates(world.context(), { now: '2026-09-14T22:00:00.000Z' }))[0]?.eventKey).toEqual(overdue[0]?.eventKey);
    expect(overdue[0]?.eventKey).not.toEqual(night[0]?.eventKey);
    expect(JSON.stringify(overdue)).not.toContain('body');
  });
  it('offers one fifteen-minute call occurrence, renews it after rescheduling and stays quiet after cancellation', async () => {
    world = await createClassifierWorld({ cases: [] });
    expect(await readNotificationCandidates(world.context(), { now: '2026-09-15T03:00:00.000Z' })).toEqual([]);
    const meetingId = randomUUID();
    await world.mail.database.session.query("INSERT INTO meetings(workspace_id,id,booking_uid,current_booking_uid,firm_id,state,starts_at,ends_at,last_event_at) VALUES ($1,$2,'notify-call','notify-call',$3,'booked','2026-09-15T03:30:00Z','2026-09-15T04:00:00Z','2026-09-14T12:00:00Z')", [world.mail.seeded.alpha.workspaceId, meetingId, world.mail.crm.alpha.firmId]);
    expect(await readNotificationCandidates(world.context(), { now: '2026-09-15T03:14:59.000Z' })).toEqual([]);
    const before = (await readNotificationCandidates(world.context(), { now: '2026-09-15T03:15:00.000Z' }))[0];
    expect(before).toMatchObject({ actionId: `meeting:${meetingId}`, phase: 'pre_call', target: { meetingId, startsAt: '2026-09-15T03:30:00.000Z' } });
    await world.mail.database.session.query("UPDATE meetings SET state='rescheduled',starts_at='2026-09-15T04:30Z',ends_at='2026-09-15T05:00Z' WHERE workspace_id=$1 AND id=$2", [world.mail.seeded.alpha.workspaceId, meetingId]);
    expect(await readNotificationCandidates(world.context(), { now: '2026-09-15T03:15:00.000Z' })).toEqual([]);
    const after = (await readNotificationCandidates(world.context(), { now: '2026-09-15T04:15:00.000Z' }))[0];
    expect(after?.eventKey).not.toEqual(before?.eventKey);
    expect(after?.target).toMatchObject({ meetingId, startsAt: '2026-09-15T04:30:00.000Z' });
    await world.mail.database.session.query("UPDATE meetings SET state='cancelled' WHERE workspace_id=$1 AND id=$2", [world.mail.seeded.alpha.workspaceId, meetingId]);
    expect(await readNotificationCandidates(world.context(), { now: '2026-09-15T04:15:00.000Z' })).toEqual([]);
  });
  it('durably claims a user-wide event once across concurrent devices and exposes attempting without inventing native delivery', async () => {
    world = await createClassifierWorld({ cases: REPLY_CORPUS.filter(c => c.id === 'terse-human-reply') });
    const now = '2026-09-11T03:00:00.000Z';
    const candidate = (await readNotificationCandidates(world.context(), { now }))[0]!;
    const firstDevice = world.mail.seeded.alpha.salesperson.deviceId;
    const secondDevice = randomUUID();
    await world.mail.database.session.query("INSERT INTO devices(workspace_id,id,user_id,device_label,secret_hash) VALUES($1,$2,$3,'second Mac',$4)", [world.mail.seeded.alpha.workspaceId, secondDevice, world.mail.seeded.alpha.salesperson.userId, 'a'.repeat(64)]);
    const secondContext = repositoryContext(world.context().scope, await world.mail.database.appRuntimeSession());
    const results = await Promise.all([
      claimNotification(world.context(), { eventKey: candidate.eventKey, deviceId: firstDevice, now }),
      claimNotification(secondContext, { eventKey: candidate.eventKey, deviceId: secondDevice, now }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const receipt = (await readActionableNotifications(world.context(), { deviceId: firstDevice, now })).items[0]?.receipt;
    expect(receipt).toMatchObject({ status: 'attempting', attemptedAt: now, nativeShownAt: null, acknowledgedAt: null });
    expect(await claimNotification(world.context(), { eventKey: candidate.eventKey, deviceId: firstDevice, now })).toBeNull();
    expect((await readActionableNotifications(secondContext, { deviceId: secondDevice, now })).items[0]?.receipt).toEqual(receipt);
  });
  it('keeps native show and human acknowledgement separate, leaves overdue work open and refuses stale or foreign context', async () => {
    world = await createClassifierWorld({ cases: REPLY_CORPUS.filter(c => c.id === 'terse-human-reply') });
    await withTransaction(world.mail.database.session, async () => await confirmReplyDisposition(world!.context(), { messageId: world!.messageIdOf('terse-human-reply'), disposition: 'interested', journal: world!.mail.journal }));
    const now = '2026-09-14T22:00:00.000Z', deviceId = world.mail.seeded.alpha.salesperson.deviceId;
    const action = (await readTodayActions(world.context(), { now })).actions[0]!;
    const candidate = (await readNotificationCandidates(world.context(), { now }))[0]!;
    const claimed = await claimNotification(world.context(), { eventKey: candidate.eventKey, deviceId, now });
    if (claimed?.receipt == null) throw new Error('attempt absent');
    const attemptId = claimed.receipt.attemptId;
    expect(await observeNotification(world.context(), { attemptId, deviceId: world.mail.seeded.beta.salesperson.deviceId, observation: 'native_shown', now })).toBe(false);
    expect(await observeNotification(world.context(), { attemptId, deviceId, observation: 'native_shown', now })).toBe(true);
    expect((await readActionableNotifications(world.context(), { deviceId, now })).items[0]?.receipt).toMatchObject({ status: 'native_shown', nativeShownAt: now, acknowledgedAt: null });
    expect(await acknowledgeNotification(world.context(), { attemptId, deviceId, now })).toEqual(action.target);
    expect((await readActionableNotifications(world.context(), { deviceId, now })).items[0]?.receipt).toMatchObject({ status: 'acknowledged', nativeShownAt: now, acknowledgedAt: now });
    expect((await readTodayActions(world.context(), { now })).actions).toContainEqual(action);
    expect(await claimNotification(world.context(), { eventKey: candidate.eventKey, deviceId, now: '2026-09-15T22:00:00.000Z' })).toBeNull();
    await withTransaction(world.mail.database.session, async () => await reassignFirm(world!.adminContext(), { firmId: world!.mail.crm.alpha.firmId, toUserId: world!.mail.seeded.alpha.admin.userId }));
    expect(await acknowledgeNotification(world.context(), { attemptId, deviceId, now })).toBeNull();
    expect((await readActionableNotifications(world.context(), { deviceId, now })).items).toEqual([]);
    expect((await readActionableNotifications(world.context(), { deviceId, now })).recoveries).toMatchObject([{ current: false, receipt: { status: 'acknowledged' } }]);
  });
  it('offers a current owned admin mailbox problem and keeps healthy, intentional and inaccessible work quiet', async () => {
    world = await createClassifierWorld({ cases: [] });
    const now = '2026-09-14T03:00:00.000Z';
    const mailbox = await insertOrReviveMailbox(world.systemContext(), { ownerUserId: world.mail.seeded.alpha.admin.userId, emailAddress: 'admin@example.test', providerAccountId: 'admin-notify', baselineFromAt: '2026-08-01T00:00:00.000Z' });
    expect(await readNotificationCandidates(world.adminContext(), { now })).toEqual([]);
    await markMailboxDisconnected(world.systemContext(), { mailboxId: mailbox.id, status: 'revoked', reason: 'grant revoked' });
    expect(await readNotificationCandidates(world.adminContext(), { now })).toMatchObject([{ phase: 'attention', reason: 'mailbox_disconnected', target: { kind: 'settings', mailboxId: mailbox.id } }]);
    expect(await readNotificationCandidates(world.context(), { now })).toEqual([]);
    await insertOrReviveMailbox(world.systemContext(), { ownerUserId: world.mail.seeded.alpha.admin.userId, emailAddress: 'admin@example.test', providerAccountId: 'admin-notify', baselineFromAt: '2026-08-01T00:00:00.000Z' });
    await markMailboxDisconnected(world.systemContext(), { mailboxId: mailbox.id, status: 'disconnected', reason: 'owner_requested' });
    expect(await readNotificationCandidates(world.adminContext(), { now })).toEqual([]);
  });
  it('retains body-free deduplication through expiry, deletion and restore holds while departure revokes delivery authority', async () => {
    world = await createClassifierWorld({ cases: REPLY_CORPUS.filter(c => c.id === 'terse-human-reply') });
    const now = '2026-09-14T03:00:00.000Z', deviceId = world.mail.seeded.alpha.salesperson.deviceId;
    const candidate = (await readNotificationCandidates(world.context(), { now }))[0]!;
    const claimed = await claimNotification(world.context(), { deviceId, eventKey: candidate.eventKey, now });
    if (claimed?.receipt == null) throw new Error('claim absent');
    await observeNotification(world.context(), { attemptId: claimed.receipt.attemptId, deviceId, observation: 'unknown', now });
    const hold = await openHold(world.systemContext(), { scopeKind: 'workspace', reasonCode: 'restore_in_progress', blockedActionKinds: ['email_send'], sourceEventKind: 'notification.restore.test' });
    await releaseHold(world.systemContext(), hold, 'restore_in_progress');
    expect(await claimNotification(world.context(), { deviceId, eventKey: candidate.eventKey, now })).toBeNull();
    expect((await readActionableNotifications(world.context(), { deviceId, now })).items[0]?.receipt).toMatchObject({ attemptId: claimed.receipt.attemptId, status: 'unknown' });
    await withTransaction(world.mail.database.session, async () => await runRetentionBatch(world!.systemContext(), { dataKind: 'raw_mime', now: '2026-11-09T03:00:00.000Z' }));
    expect((await readActionableNotifications(world.context(), { deviceId, now })).items[0]?.receipt?.attemptId).toBe(claimed.receipt.attemptId);
    const preview = await previewDeletion(world.adminContext(), { targetKind: 'firm', firmId: world.mail.crm.alpha.firmId });
    if (!preview.ok) throw new Error('deletion preview refused');
    expect(await withTransaction(world.mail.database.session, async () => await commitDeletion(world!.adminContext(), { requestId: preview.value.requestId, previewHash: preview.value.previewHash, commandId: 'notification-delete', journal: world!.mail.journal }))).toMatchObject({ ok: true });
    const after = await readActionableNotifications(world.context(), { deviceId, now });
    expect(after.items).toEqual([]);
    expect(after.recoveries).toMatchObject([{ current: false, receipt: { attemptId: claimed.receipt.attemptId, status: 'unknown' } }]);
    expect(JSON.stringify(after)).not.toContain('Northwind');
    expect(JSON.stringify(after)).not.toContain('body');
    expect(await withTransaction(world.mail.database.session, async () => await commitDeparture(world!.adminContext(), { userId: world!.mail.seeded.alpha.salesperson.userId, commandId: 'notification-departure' }))).toMatchObject({ ok: true });
    expect(await claimNotification(world.context(), { deviceId, eventKey: candidate.eventKey, now })).toBeNull();
    await expect(readActionableNotifications(world.context(), { deviceId, now })).rejects.toThrow('notification_device_unavailable');
  });
});
