import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionQueryable } from '../../db/queryable.ts';
import { withTransaction } from '../../db/queryable.ts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { receiveCalcomEvent } from '../../meetings/calcom.ts';
import { lockSendGateForStopFact } from '../../policy/sendGate.ts';
import { commitDeletion, previewDeletion } from '../../retention/deletion.ts';
import { updateSetting } from '../../settings/store.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * The send gate as the serialization point for two Cal.com races (slice M1, review
 * fold 2), each with a second real connection:
 *
 *   * a deletion takes the gate before it measures, so a booking that commits while the
 *     deletion runs is either measured (and tombstoned) or refuses the stale preview — it
 *     is never deleted without a tombstone (finding 3 (ii));
 *   * a write of `calendar_integration` takes the workspace's gate, so disabling a
 *     workspace waits for a reconcile of it that holds the gate (finding 4).
 */

const settle = async (milliseconds: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
};

/** Whether a promise is still pending after a pause long enough for a free lock. */
async function stillWaiting(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await settle(300);
  return !done;
}

describe('the send gate serializes Cal.com with deletion and with the switch', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let other: SessionQueryable;
  const workspaceId = (): string => seeded.alpha.workspaceId;
  const admin = (session: SessionQueryable): RepositoryContext =>
    repositoryContext(workspaceScope(workspaceId(), { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }), session);

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    other = await database.appRuntimeSession();
  });

  afterAll(async () => {
    await database.drop();
  });

  it('never deletes a meeting booked during the deletion without tombstoning its attendee', async () => {
    const attendee = 'late.booker@gate-law.example';
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO firms (workspace_id, name, website, assigned_user_id) VALUES ($1, 'Gate Law', 'https://gate-law.example', $2) RETURNING id`,
      [workspaceId(), seeded.alpha.salesperson.userId],
    );
    const firmId = rows[0]?.id ?? '';
    const preview = await withTransaction(database.session, async () => await previewDeletion(admin(database.session), { targetKind: 'firm', firmId }));

    // The booking is mid-transaction on another connection, holding the gate.
    const body = {
      triggerEvent: 'BOOKING_CREATED',
      createdAt: '2026-09-30T12:00:00.000Z',
      payload: { uid: 'gatebooking1', startTime: '2026-10-06T15:00:00.000Z', endTime: '2026-10-06T15:30:00.000Z', attendees: [{ email: attendee }] },
    };
    await other.query('BEGIN');
    const booked = await receiveCalcomEvent(other, { workspaceId: workspaceId(), rawBody: Buffer.from(JSON.stringify(body)), body });
    expect(booked).toMatchObject({ outcome: 'applied' });

    const deletion = withTransaction(database.session, async () =>
      await commitDeletion(admin(database.session), {
        requestId: preview.value?.requestId ?? '',
        previewHash: preview.value?.previewHash ?? '',
        commandId: 'gate-deletion-1',
        journal: recordingSuppressionJournal(),
      }),
    );
    expect(await stillWaiting(deletion)).toBe(true);
    await other.query('COMMIT');
    const outcome = await deletion;

    const { rows: meetings } = await database.session.query<{ count: string }>(
      "SELECT count(*) AS count FROM meetings WHERE workspace_id = $1 AND booking_uid = 'gatebooking1'",
      [workspaceId()],
    );
    const tombstoned = async (): Promise<boolean> => {
      const { rows: found } = await database.session.query(
        "SELECT 1 FROM suppression_events WHERE workspace_id = $1 AND canonical_key = $2 AND source = 'deletion_tombstone'",
        [workspaceId(), attendee],
      );
      return found.length > 0;
    };
    // The deletion measured after the booking committed: its preview no longer holds.
    expect(outcome).toEqual({ ok: false, reason: 'preview_stale' });
    expect(Number(meetings[0]?.count)).toBe(1);

    // Previewed again, it takes the meeting and tombstones the person who booked.
    const again = await withTransaction(database.session, async () => await previewDeletion(admin(database.session), { targetKind: 'firm', firmId }));
    const committed = await withTransaction(database.session, async () =>
      await commitDeletion(admin(database.session), {
        requestId: again.value?.requestId ?? '',
        previewHash: again.value?.previewHash ?? '',
        commandId: 'gate-deletion-2',
        journal: recordingSuppressionJournal(),
      }),
    );
    expect(committed.ok).toBe(true);
    expect(await tombstoned()).toBe(true);
  });

  it('makes turning the Cal.com switch off wait for a reconcile of that workspace holding the gate', async () => {
    // The reconcile's transaction, holding the workspace's send gate.
    await database.session.query('BEGIN');
    await lockSendGateForStopFact(repositoryContext(workspaceScope(workspaceId(), { kind: 'system', component: 'worker' }), database.session));

    const disable = withTransaction(other, async () =>
      await updateSetting(admin(other), { settingKey: 'calendar_integration', value: { integration: 'off' } }),
    );
    expect(await stillWaiting(disable)).toBe(true);
    await database.session.query('COMMIT');
    expect(await disable).toMatchObject({ ok: true });
  });
});
