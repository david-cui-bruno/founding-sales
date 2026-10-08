import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { applyMigrations, readAppliedSchemaVersion } from '../../db/migrationRunner.ts';
import { seedTwoWorkspaces } from './support/fixtures.ts';
import { seedCrm } from './support/crmFixtures.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { withTransaction } from '../../db/queryable.ts';
import { receiveCalcomEvent } from '../../meetings/calcom.ts';
import { readNotificationCandidates } from '../../notifications/actions.ts';
import { acknowledgeNotification, claimNotification, readActionableNotifications } from '../../notifications/ledger.ts';

let database: TestDatabase;
beforeAll(async () => { database = await createTestDatabase({ throughVersion: 67 }); });
afterAll(async () => { await database.drop(); });

it('upgrades67 to68 without replacing legacy notification history, and accepts a new current-booking claim afterward', async () => {
  const seeded = await seedTwoWorkspaces(database.session), crm = await seedCrm(database.session, seeded);
  const context = repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }), database.session);
  const now = '2026-09-15T03:15:00.000Z', deviceId = seeded.alpha.salesperson.deviceId;
  async function book(uid: string) {
    const body = { triggerEvent: 'BOOKING_CREATED', createdAt: '2026-09-14T12:00:00.000Z', payload: {
      uid, startTime: '2026-09-15T03:30:00.000Z', endTime: '2026-09-15T04:00:00.000Z',
      organizer: { email: seeded.alpha.salesperson.email }, attendees: [{ email: crm.collidingEmail }],
    } };
    return await withTransaction(database.session, async () => await receiveCalcomEvent(database.session, { workspaceId: seeded.alpha.workspaceId, body, rawBody: Buffer.from(JSON.stringify(body)) }));
  }
  const original = await book('call-upgrade-legacy');
  if (original.meetingId === null) throw new Error('legacy booking fixture missing');
  const attemptId = randomUUID(), legacyEvent = `meeting:${original.meetingId}:pre_call:2026-09-15T03:30:00.000Z`;
  // This is the exact pre-UID persisted shape. The migration must preserve it.
  await database.session.query(`INSERT INTO actionable_notification_attempts(workspace_id,attempt_id,user_id,device_id,event_key,action_id,phase,target,status,attempted_at,unknown_at)
    VALUES($1,$2,$3,$4,$5,$6,'pre_call',$7::jsonb,'unknown',$8,$8)`,
  [seeded.alpha.workspaceId, attemptId, seeded.alpha.salesperson.userId, deviceId, legacyEvent, `meeting:${original.meetingId}`,
    JSON.stringify({ kind: 'meeting', firmId: crm.alpha.firmId, meetingId: original.meetingId, startsAt: '2026-09-15T03:30:00.000Z' }), now]);

  expect((await applyMigrations(database.session)).map(result => result.version)).toEqual([68]);
  expect(await readAppliedSchemaVersion(database.session)).toBe(68);
  expect(await acknowledgeNotification(context, { attemptId, deviceId, now })).toBeNull();
  const history = await readActionableNotifications(context, { deviceId, now });
  expect(history.recoveries).toMatchObject([{ eventKey: legacyEvent, current: false, receipt: { attemptId, status: 'acknowledged', attemptedAt: now, unknownAt: now } }]);
  const legacyCandidate = (await readNotificationCandidates(context, { now }))[0]!;
  expect(await claimNotification(context, { deviceId, eventKey: legacyCandidate.eventKey, now })).toBeNull();

  await book('call-upgrade-current');
  const current = (await readNotificationCandidates(context, { now })).find(candidate => candidate.target.kind === 'meeting' && candidate.target.bookingUid === 'call-upgrade-current');
  if (current === undefined) throw new Error('current booking candidate missing');
  expect(await claimNotification(context, { deviceId, eventKey: current.eventKey, now })).toMatchObject({ target: { bookingUid: 'call-upgrade-current' }, receipt: { status: 'attempting', nativeShownAt: null } });
  expect(await claimNotification(context, { deviceId, eventKey: current.eventKey, now })).toBeNull();
  expect(await applyMigrations(database.session)).toEqual([]);
});
