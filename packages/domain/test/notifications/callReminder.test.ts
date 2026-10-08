import { afterEach, describe, expect, it } from 'vitest';
import { createMailWorld, type MailWorld } from '../mail/support/mailWorld.ts';
import { receiveCalcomEvent } from '../../meetings/calcom.ts';
import { withTransaction } from '../../db/queryable.ts';
import { readNotificationCandidates } from '../../notifications/actions.ts';
import { acknowledgeNotification, claimNotification, observeNotification, readActionableNotifications } from '../../notifications/ledger.ts';
import { readMeetingBrief } from '../../meetings/brief.ts';
import { reassignFirm } from '../../crm/firms.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';

let world: MailWorld | null = null;
afterEach(async () => { await world?.stop(); world = null; });

async function booking(triggerEvent: string, uid: string, createdAt: string, extra: Record<string, unknown> = {}) {
  if (world === null) throw new Error('call reminder fixture missing');
  const body = { triggerEvent, createdAt, payload: {
    uid, startTime: '2026-09-15T03:30:00.000Z', endTime: '2026-09-15T04:00:00.000Z',
    organizer: { email: world.alpha.address }, attendees: [{ email: world.crm.collidingEmail }], ...extra,
  } };
  return await withTransaction(world.database.session, async () => await receiveCalcomEvent(world!.database.session, {
    workspaceId: world!.seeded.alpha.workspaceId, body, rawBody: Buffer.from(JSON.stringify(body)),
  }));
}

describe('the current Cal.com call reminder', () => {
  it('invalidates an earlier reminder when Cal.com replaces the booking at the same time', async () => {
    world = await createMailWorld();
    const now = '2026-09-15T03:15:00.000Z', context = world.userContext(world.seeded.alpha.workspaceId);
    const deviceId = world.seeded.alpha.salesperson.deviceId;
    expect(await booking('BOOKING_CREATED', 'call-original', '2026-09-14T12:00:00.000Z')).toMatchObject({ outcome: 'applied', meetingState: 'booked' });
    const previous = (await readNotificationCandidates(context, { now }))[0]!;
    const claimed = await claimNotification(context, { eventKey: previous.eventKey, deviceId, now });
    if (claimed?.receipt == null) throw new Error('call reminder claim missing');

    expect(await booking('BOOKING_RESCHEDULED', 'call-replacement', '2026-09-14T13:00:00.000Z', { rescheduleUid: 'call-original' }))
      .toMatchObject({ outcome: 'applied', meetingState: 'rescheduled' });
    expect(await acknowledgeNotification(context, { attemptId: claimed.receipt.attemptId, deviceId, now })).toBeNull();
    expect(await claimNotification(context, { eventKey: previous.eventKey, deviceId, now })).toBeNull();
    const current = await readActionableNotifications(context, { deviceId, now });
    expect(current.recoveries).toMatchObject([{ current: false, receipt: { attemptId: claimed.receipt.attemptId } }]);
    expect(current.items).toHaveLength(1);
    expect(current.items[0]?.eventKey).not.toBe(previous.eventKey);
    expect(current.items[0]?.receipt).toBeNull();
    const replacement = current.items[0]!;
    expect(await claimNotification(context, { eventKey: replacement.eventKey, deviceId, now })).toMatchObject({ target: { bookingUid: 'call-replacement' }, receipt: { status: 'attempting' } });
    expect(await claimNotification(context, { eventKey: replacement.eventKey, deviceId, now })).toBeNull();
  });

  it('offers one exact fifteen-minute reminder and keeps its current brief reachable after replay', async () => {
    world = await createMailWorld();
    const context = world.userContext(world.seeded.alpha.workspaceId), deviceId = world.seeded.alpha.salesperson.deviceId;
    const created = await booking('BOOKING_CREATED', 'call-window', '2026-09-14T12:00:00.000Z', { title: 'Introductory call', notes: 'Discuss maintenance coordination' });
    expect(created).toMatchObject({ outcome: 'applied', meetingState: 'booked' });
    expect(await readNotificationCandidates(context, { now: '2026-09-15T03:14:59.999Z' })).toEqual([]);
    const now = '2026-09-15T03:15:00.000Z', candidate = (await readNotificationCandidates(context, { now }))[0]!;
    expect(candidate).toMatchObject({ phase: 'pre_call', dueAt: '2026-09-15T03:30:00.000Z', target: { kind: 'meeting', meetingId: created.meetingId } });
    const first = await claimNotification(context, { eventKey: candidate.eventKey, deviceId, now });
    if (first?.receipt == null) throw new Error('current reminder absent');
    expect(await claimNotification(context, { eventKey: candidate.eventKey, deviceId, now: '2026-09-15T03:20:00.000Z' })).toBeNull();
    const target = await acknowledgeNotification(context, { attemptId: first.receipt.attemptId, deviceId, now });
    expect(target).toEqual(candidate.target);
    if (target?.kind !== 'meeting') throw new Error('current brief target absent');
    expect(await readMeetingBrief(context, target.meetingId)).toMatchObject({ meetingId: created.meetingId, firmId: world.crm.alpha.firmId,
      meeting: { state: 'booked', title: 'Introductory call', startsAt: '2026-09-15T03:30:00.000Z' } });
    expect((await readActionableNotifications(context, { deviceId, now })).items).toMatchObject([{ receipt: { attemptId: first.receipt.attemptId, status: 'acknowledged' } }]);
    expect(await readNotificationCandidates(context, { now: '2026-09-15T03:30:00.001Z' })).toEqual([]);
  });

  it('does not revive a cancelled reminder from an older Cal.com event or a previously read claim', async () => {
    world = await createMailWorld();
    const now = '2026-09-15T03:15:00.000Z', context = world.userContext(world.seeded.alpha.workspaceId), deviceId = world.seeded.alpha.salesperson.deviceId;
    await booking('BOOKING_CREATED', 'call-cancel', '2026-09-14T12:00:00.000Z');
    const stale = (await readNotificationCandidates(context, { now }))[0]!;
    const claimed = await claimNotification(context, { eventKey: stale.eventKey, deviceId, now });
    if (claimed?.receipt == null) throw new Error('call reminder claim missing');
    expect(await booking('BOOKING_CANCELLED', 'call-cancel', '2026-09-14T14:00:00.000Z')).toMatchObject({ outcome: 'applied', meetingState: 'cancelled' });
    expect(await booking('BOOKING_CREATED', 'call-cancel', '2026-09-14T13:00:00.000Z')).toMatchObject({ outcome: 'stale', meetingState: 'cancelled' });
    expect(await claimNotification(context, { eventKey: stale.eventKey, deviceId, now })).toBeNull();
    expect(await acknowledgeNotification(context, { attemptId: claimed.receipt.attemptId, deviceId, now })).toBeNull();
    expect(await readActionableNotifications(context, { deviceId, now })).toMatchObject({ items: [], recoveries: [{ current: false, receipt: { attemptId: claimed.receipt.attemptId } }] });
  });

  it('revokes the former owner reminder and brief when the firm changes hands', async () => {
    world = await createMailWorld();
    const now = '2026-09-15T03:15:00.000Z', context = world.userContext(world.seeded.alpha.workspaceId), deviceId = world.seeded.alpha.salesperson.deviceId;
    await booking('BOOKING_CREATED', 'call-transfer', '2026-09-14T12:00:00.000Z');
    const stale = (await readNotificationCandidates(context, { now }))[0]!;
    const claimed = await claimNotification(context, { eventKey: stale.eventKey, deviceId, now });
    if (claimed?.receipt == null || stale.target.kind !== 'meeting') throw new Error('call reminder claim missing');
    const admin = repositoryContext(workspaceScope(world.seeded.alpha.workspaceId, { kind: 'user', userId: world.seeded.alpha.admin.userId, role: 'admin' }), world.database.session);
    expect(await withTransaction(world.database.session, async () => await reassignFirm(admin, { firmId: world!.crm.alpha.firmId, toUserId: world!.seeded.alpha.admin.userId }))).toMatchObject({ ok: true });
    expect(await acknowledgeNotification(context, { attemptId: claimed.receipt.attemptId, deviceId, now })).toBeNull();
    expect(await claimNotification(context, { eventKey: stale.eventKey, deviceId, now })).toBeNull();
    expect(await readMeetingBrief(context, stale.target.meetingId)).toBeNull();
    expect((await readActionableNotifications(context, { deviceId, now })).recoveries).toMatchObject([{ current: false }]);
  });

  it('preserves a legacy unknown native attempt as deduplication without treating its unversioned target as current authority', async () => {
    world = await createMailWorld();
    const now = '2026-09-15T03:15:00.000Z', context = world.userContext(world.seeded.alpha.workspaceId), deviceId = world.seeded.alpha.salesperson.deviceId;
    await booking('BOOKING_CREATED', 'call-legacy', '2026-09-14T12:00:00.000Z');
    const candidate = (await readNotificationCandidates(context, { now }))[0]!;
    const claimed = await claimNotification(context, { eventKey: candidate.eventKey, deviceId, now });
    if (claimed?.receipt == null) throw new Error('legacy reminder claim missing');
    await observeNotification(context, { attemptId: claimed.receipt.attemptId, deviceId, observation: 'unknown', now });
    // A retained pre-UID schema66 receipt is fixture input; behavior is read only
    // through the public claim/read/acknowledgement boundary below.
    await world.database.session.query(`UPDATE actionable_notification_attempts SET target=target-'bookingUid',event_key=$3
      WHERE workspace_id=$1 AND attempt_id=$2`, [world.seeded.alpha.workspaceId, claimed.receipt.attemptId, `${candidate.actionId}:pre_call:${candidate.dueAt}`]);
    const current = (await readNotificationCandidates(context, { now }))[0]!;
    expect(await claimNotification(context, { eventKey: current.eventKey, deviceId, now })).toBeNull();
    const read = await readActionableNotifications(context, { deviceId, now });
    expect(read.items).toMatchObject([{ receipt: null, target: { bookingUid: 'call-legacy' } }]);
    expect(await acknowledgeNotification(context, { attemptId: claimed.receipt.attemptId, deviceId, now })).toBeNull();
    expect(read.recoveries).toMatchObject([{ current: false, receipt: { attemptId: claimed.receipt.attemptId, status: 'unknown' } }]);
  });
});
