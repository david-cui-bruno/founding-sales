import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createClassifierWorld, type ClassifierWorld } from '../classification/support/classifierWorld.ts';
import { REPLY_CORPUS } from '../corpus/replies/cases.ts';
import { withTransaction } from '../../db/queryable.ts';
import { confirmReplyDisposition } from '../../classification/confirmations.ts';
import { readTodayActions } from '../../today/actions.ts';
import { readActionableNotifications, claimNotification, observeNotification, acknowledgeNotification } from '../../notifications/ledger.ts';
import { recordHolidayCalendar } from '../../sequences/calendars.ts';
import { updateSetting } from '../../settings/store.ts';
import { repositoryContext } from '../../db/workspaceScope.ts';
import { fixtureMessage } from '../mail/support/mailWorld.ts';
import { readMessage } from '../../mail/messages.ts';
import { runMailSync } from '../../mail/sync.ts';

let world: ClassifierWorld | null = null;
afterEach(async () => { await world?.stop(); world = null; });

async function substantiveReply(receivedAt: string): Promise<ClassifierWorld> {
  const created = await createClassifierWorld({ cases: REPLY_CORPUS.filter(c => c.id === 'terse-human-reply') });
  world = created;
  await withTransaction(created.mail.database.session, async () => await confirmReplyDisposition(created.context(), {
    messageId: created.messageIdOf('terse-human-reply'), disposition: 'interested', journal: created.mail.journal,
  }));
  // The existing mail fixture supplies a received reply; only its arrival clock varies.
  await created.mail.database.session.query('UPDATE mail_messages SET internal_date=$3 WHERE workspace_id=$1 AND id=$2',
    [created.mail.seeded.alpha.workspaceId, created.messageIdOf('terse-human-reply'), receivedAt]);
  return created;
}

describe('one-business-day reply reminder', () => {
  it('makes a Saturday reply overdue on Monday at its workspace local arrival time', async () => {
    const fixture = await substantiveReply('2026-09-12T14:00:00.000Z'); // Saturday at 10 a.m. New York.
    const deviceId = fixture.mail.seeded.alpha.salesperson.deviceId;
    const before = await readTodayActions(fixture.context(), { now: '2026-09-14T13:59:59.999Z' });
    expect(before.actions).toMatchObject([{ dueAt: '2026-09-14T14:00:00.000Z', state: 'open' }]);
    const atDeadline = await readActionableNotifications(fixture.context(), { deviceId, now: '2026-09-14T14:00:00.000Z' });
    expect(atDeadline.items).toMatchObject([{ state: 'overdue', phase: 'reply_overdue', dueAt: '2026-09-14T14:00:00.000Z' }]);
  });

  it('does not offer the overdue reminder even one millisecond before the received-clock deadline', async () => {
    const fixture = await substantiveReply('2026-09-10T14:00:00.875Z');
    const deviceId = fixture.mail.seeded.alpha.salesperson.deviceId;
    const before = await readActionableNotifications(fixture.context(), { deviceId, now: '2026-09-11T14:00:00.874Z' });
    expect(before.items).toMatchObject([{ state: 'open', phase: 'attention', dueAt: '2026-09-11T14:00:00.875Z' }]);
    const atDeadline = await readActionableNotifications(fixture.context(), { deviceId, now: '2026-09-11T14:00:00.875Z' });
    expect(atDeadline.items).toMatchObject([{ state: 'overdue', phase: 'reply_overdue' }]);
  });

  it.each([
    { label: 'Friday', receivedAt: '2026-09-11T14:00:00.000Z', dueAt: '2026-09-14T14:00:00.000Z', holidays: [] },
    { label: 'Sunday', receivedAt: '2026-09-13T14:00:00.000Z', dueAt: '2026-09-14T14:00:00.000Z', holidays: [] },
    { label: 'holiday arrival', receivedAt: '2026-09-07T14:00:00.000Z', dueAt: '2026-09-08T14:00:00.000Z', holidays: ['2026-09-07'] },
    { label: 'Friday before a Monday holiday', receivedAt: '2026-09-04T14:00:00.000Z', dueAt: '2026-09-08T14:00:00.000Z', holidays: ['2026-09-07'] },
    { label: 'spring DST weekend', receivedAt: '2026-03-06T15:00:00.000Z', dueAt: '2026-03-09T14:00:00.000Z', holidays: [] },
    { label: 'autumn DST weekend', receivedAt: '2026-10-30T14:00:00.000Z', dueAt: '2026-11-02T15:00:00.000Z', holidays: [] },
  ])('uses the workspace weekday/calendar clock after $label', async ({ receivedAt, dueAt, holidays }) => {
    const fixture = await substantiveReply(receivedAt);
    if (holidays.length > 0) {
      expect(await withTransaction(fixture.mail.database.session, async () => await recordHolidayCalendar(fixture.adminContext(), {
        version: 'reply-reminder-test.1', dates: holidays,
      }))).toMatchObject({ ok: true });
    }
    const deadline = await readTodayActions(fixture.context(), { now: dueAt });
    expect(deadline).toMatchObject({ businessTimeZone: 'America/New_York', actions: [{ dueAt, state: 'overdue' }] });
    const before = await readActionableNotifications(fixture.context(), { deviceId: fixture.mail.seeded.alpha.salesperson.deviceId,
      now: new Date(Date.parse(dueAt) - 1).toISOString() });
    expect(before.items).toMatchObject([{ dueAt, phase: 'attention', state: 'open' }]);
  });

  it('uses the configured workspace zone rather than a firm or fixed UTC weekday', async () => {
    const fixture = await substantiveReply('2026-09-11T02:00:00.000Z'); // Thursday at 10 p.m. New York, Friday at 02:00 UTC.
    expect((await readTodayActions(fixture.context(), { now: '2026-09-11T03:00:00.000Z' })).actions)
      .toMatchObject([{ dueAt: '2026-09-12T02:00:00.000Z' }]);
    expect(await withTransaction(fixture.mail.database.session, async () => await updateSetting(fixture.adminContext(), {
      settingKey: 'business_time_zone', value: { timeZone: 'Etc/UTC' }, changeNote: 'fixture workspace clock',
    }))).toMatchObject({ ok: true });
    expect(await readTodayActions(fixture.context(), { now: '2026-09-11T03:00:00.000Z' }))
      .toMatchObject({ businessTimeZone: 'Etc/UTC', actions: [{ dueAt: '2026-09-14T02:00:00.000Z' }] });
  });

  it('preserves one unknown overdue attempt across devices and restarts while overdue work remains visible', async () => {
    const fixture = await substantiveReply('2026-09-10T14:00:00.000Z');
    const now = '2026-09-14T22:00:00.000Z', firstDevice = fixture.mail.seeded.alpha.salesperson.deviceId;
    const secondDevice = randomUUID();
    await fixture.mail.database.session.query("INSERT INTO devices(workspace_id,id,user_id,device_label,secret_hash) VALUES($1,$2,$3,'second fixture Mac',$4)",
      [fixture.mail.seeded.alpha.workspaceId, secondDevice, fixture.mail.seeded.alpha.salesperson.userId, 'a'.repeat(64)]);
    const secondContext = repositoryContext(fixture.context().scope, await fixture.mail.database.appRuntimeSession());
    const candidate = (await readActionableNotifications(fixture.context(), { deviceId: firstDevice, now })).items[0]!;
    expect(candidate).toMatchObject({ phase: 'reply_overdue', receipt: null }); // Offline has no native receipt.
    const claims = await Promise.all([
      claimNotification(fixture.context(), { deviceId: firstDevice, eventKey: candidate.eventKey, now }),
      claimNotification(secondContext, { deviceId: secondDevice, eventKey: candidate.eventKey, now }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claimed = claims.find(Boolean);
    if (claimed?.receipt == null) throw new Error('overdue attempt absent');
    const claimContext = claimed.receipt.deviceId === firstDevice ? fixture.context() : secondContext;
    expect(await observeNotification(claimContext, { deviceId: claimed.receipt.deviceId, attemptId: claimed.receipt.attemptId,
      observation: 'unknown', now })).toBe(true);
    const restarted = repositoryContext(fixture.context().scope, await fixture.mail.database.appRuntimeSession());
    const afterRestart = await readActionableNotifications(restarted, { deviceId: firstDevice, now: '2026-09-16T22:00:00.000Z' });
    expect(afterRestart.items).toMatchObject([{ phase: 'reply_overdue', state: 'overdue', eventKey: candidate.eventKey,
      receipt: { attemptId: claimed.receipt.attemptId, status: 'unknown', nativeShownAt: null, acknowledgedAt: null } }]);
    expect(await claimNotification(restarted, { deviceId: firstDevice, eventKey: candidate.eventKey, now: '2026-09-16T22:00:00.000Z' })).toBeNull();
    expect(await acknowledgeNotification(restarted, { deviceId: firstDevice, attemptId: claimed.receipt.attemptId,
      now: '2026-09-16T22:00:00.000Z' })).toEqual(candidate.target);
    expect((await readTodayActions(restarted, { now: '2026-09-16T22:00:00.000Z' })).actions)
      .toMatchObject([{ state: 'overdue', actionId: candidate.actionId }]);
  });

  it.each(['manual Gmail answer', 'newer not-interested confirmation', 'newer incoming reply'])('suppresses the old overdue reminder after %s', async label => {
    const fixture = await substantiveReply('2026-09-10T14:00:00.000Z');
    const now = '2026-09-14T22:00:00.000Z', deviceId = fixture.mail.seeded.alpha.salesperson.deviceId;
    const candidate = (await readActionableNotifications(fixture.context(), { deviceId, now })).items[0]!;
    const claim = await claimNotification(fixture.context(), { deviceId, eventKey: candidate.eventKey, now });
    if (claim?.receipt == null) throw new Error('overdue attempt absent');
    const original = await readMessage(fixture.context(), fixture.messageIdOf('terse-human-reply'));
    if (original?.headerFrom == null) throw new Error('source reply absent');
    const outgoing = label === 'manual Gmail answer';
    fixture.mail.alpha.messages.push(fixtureMessage({ id: `reply-reminder-${outgoing ? 'answer' : 'newer'}`, historyId: '2001',
      threadId: original.providerThreadId, from: outgoing ? fixture.mail.alpha.address : original.headerFrom,
      to: outgoing ? original.headerFrom : fixture.mail.alpha.address,
      internalDateEpochMilliseconds: Date.parse('2026-09-11T15:00:00.000Z'),
      labelIds: outgoing ? ['SENT'] : ['INBOX'], body: outgoing ? 'Thanks. Here is the answer you asked for.' : 'One more question before we book our call.' }));
    await runMailSync(fixture.systemContext(), fixture.mail.syncDeps(fixture.mail.alpha), { mailboxId: original.mailboxId });
    if (label === 'newer not-interested confirmation') {
      const newer = (await readTodayActions(fixture.context(), { now })).actions[0];
      if (newer?.target.kind !== 'reply') throw new Error('newer reply absent');
      const messageId = newer.target.messageId;
      expect(await withTransaction(fixture.mail.database.session, async () => await confirmReplyDisposition(fixture.context(), {
        messageId, disposition: 'not_interested', journal: fixture.mail.journal,
      }))).toMatchObject({ ok: true });
    }
    const current = await readActionableNotifications(fixture.context(), { deviceId, now });
    expect(current.items.some(item => item.eventKey === candidate.eventKey)).toBe(false);
    expect(current.recoveries).toMatchObject([{ eventKey: candidate.eventKey, current: false,
      receipt: { attemptId: claim.receipt.attemptId, status: 'attempting', nativeShownAt: null } }]);
    expect(await claimNotification(fixture.context(), { deviceId, eventKey: candidate.eventKey, now })).toBeNull();
    expect(await acknowledgeNotification(fixture.context(), { deviceId, attemptId: claim.receipt.attemptId, now })).toBeNull();
    if (label !== 'newer incoming reply') expect(current.items).toEqual([]);
  });
});
