import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { receiveCalcomEvent } from '../../meetings/calcom.ts';
import { enrollContact } from '../../sequences/enrollments.ts';
import { grantFollowUpPermission } from '../../sequences/followUpPermissions.ts';
import { consumeTerminalStops } from '../../sequences/terminalStops.ts';
import { firstStageId, seedCrm } from '../db/support/crmFixtures.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * A booking stops prospecting and nothing else, including after the terminal-stop drain
 * (call-to-booking slice W, review fold 1, finding 3).
 *
 * The case the review named: the follow-up permission was recorded first, the
 * opportunity was opened afterwards (so it is automated when the booking arrives) and
 * carries a follow-up enrollment, and a colleague is in prospecting. Before the fix the
 * booking's manual-mode signal owed a stop to every live enrollment at the firm, and the
 * drain a minute later stopped the agreed follow-up too.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;

const contextFor = (db: SessionQueryable = database.session): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }),
    db,
  );
const worker = (): RepositoryContext =>
  repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), database.session);

async function one<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[]): Promise<Row> {
  const { rows } = await database.session.query<Row>(sql, values);
  const row = rows[0];
  if (row === undefined) throw new Error(`no row: ${sql.slice(0, 60)}`);
  return row;
}

async function inTransaction<T>(work: (context: RepositoryContext) => Promise<T>): Promise<T> {
  const session = await database.appRuntimeSession();
  await session.query('BEGIN');
  try {
    const value = await work(contextFor(session));
    await session.query('COMMIT');
    return value;
  } catch (error) {
    await session.query('ROLLBACK');
    throw error;
  }
}

async function publishedVersion(): Promise<string> {
  const { id: sequenceId } = await one<{ id: string }>(
    'INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id',
    [seeded.alpha.workspaceId, `Booking stops ${randomUUID().slice(0, 8)}`, seeded.alpha.admin.userId],
  );
  const { id: versionId } = await one<{ id: string }>(
    'INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 1) RETURNING id',
    [seeded.alpha.workspaceId, sequenceId],
  );
  for (const ordinal of [1, 2]) {
    await database.session.query(
      `INSERT INTO sequence_steps (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, on_no_answer)
       VALUES ($1, $2, $3, 'call_task', 'business_days', $4, 'advance')`,
      [seeded.alpha.workspaceId, versionId, ordinal, ordinal * 2],
    );
  }
  await database.session.query(
    `UPDATE sequence_versions SET state = 'published', published_at = now(), published_by_user_id = $3
      WHERE workspace_id = $1 AND id = $2`,
    [seeded.alpha.workspaceId, versionId, seeded.alpha.admin.userId],
  );
  return versionId;
}

async function enrollment(id: string): Promise<{ state: string; end_reason: string | null }> {
  return await one('SELECT state, end_reason FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2', [
    seeded.alpha.workspaceId,
    id,
  ]);
}

async function drain(): Promise<void> {
  for (let pass = 0; pass < 20; pass += 1) {
    const report = await consumeTerminalStops(worker(), { limit: 50 });
    if (report.eventsConsumed === 0) return;
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  await seedCrm(database.session, seeded);
});

afterAll(async () => {
  await database.drop();
});

describe('a booking and the enrollments at the firm', () => {
  it('stops the prospecting colleague and keeps the agreed follow-up, after the drain too', async () => {
    const { id: firmId } = await one<{ id: string }>(
      `INSERT INTO firms (workspace_id, name, website, assigned_user_id, region_code, postal_code,
                          time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
       VALUES ($1, 'Harbor Booking LLP', 'https://harbor-booking.example/', $2, 'RI', '02903',
               'America/New_York', 'medium', 'state_default', 'firm-zone.1')
       RETURNING id`,
      [seeded.alpha.workspaceId, seeded.alpha.salesperson.userId],
    );
    const contact = async (name: string): Promise<string> =>
      (
        await one<{ id: string }>('INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id', [
          seeded.alpha.workspaceId,
          firmId,
          name,
        ])
      ).id;
    const agreedContact = await contact('Robin Agreed');
    const colleague = await contact('Sam Colleague');
    const followUpVersion = await publishedVersion();
    const prospectingVersion = await publishedVersion();
    await drain();

    // 1. The permission, from a call logged before any opportunity existed.
    const permissionId = await inTransaction(async context => {
      const { rows } = await context.db.query<{ id: string }>(
        `INSERT INTO call_logs
           (workspace_id, firm_id, contact_id, outcome, step_effect, occurred_at,
            actor_user_id, agreed_follow_up, agreed_sequence_version_id)
         VALUES ($1, $2, $3, 'interested', 'none', now() - interval '1 second', $4, 'agreed_sequence', $5)
         RETURNING id`,
        [seeded.alpha.workspaceId, firmId, agreedContact, seeded.alpha.salesperson.userId, followUpVersion],
      );
      const granted = await grantFollowUpPermission(context, {
        firmId,
        contactId: agreedContact,
        callLogId: rows[0]?.id ?? '',
        grantedByUserId: seeded.alpha.salesperson.userId,
      });
      if (!granted.ok) throw new Error(`grant refused: ${granted.reason}`);
      return granted.value.id;
    });

    // 2. The opportunity, opened afterwards: automated.
    const stageId = await firstStageId(database.session, seeded.alpha.workspaceId);
    const { id: opportunityId } = await one<{ id: string }>(
      'INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at) VALUES ($1, $2, $3, now()) RETURNING id',
      [seeded.alpha.workspaceId, firmId, stageId],
    );

    // 3. The follow-up enrollment on it, and a colleague in prospecting.
    const followUp = await inTransaction(async context => {
      const enrolled = await enrollContact(context, {
        sequenceVersionId: followUpVersion,
        originKind: 'follow_up',
        permissionId,
        opportunityId,
        firmId,
        contactId: agreedContact,
      });
      if (!enrolled.ok) throw new Error(`follow-up refused: ${enrolled.reason}`);
      return enrolled.value.enrollmentId;
    });
    const prospecting = await inTransaction(async context => {
      const enrolled = await enrollContact(context, {
        sequenceVersionId: prospectingVersion,
        originKind: 'prospecting',
        opportunityId,
        firmId,
        contactId: colleague,
      });
      if (!enrolled.ok) throw new Error(`prospecting refused: ${enrolled.reason}`);
      return enrolled.value.enrollmentId;
    });

    // 4. The booking, matched by the firm's domain.
    const body = {
      triggerEvent: 'BOOKING_CREATED',
      createdAt: '2026-09-30T15:00:00.000Z',
      payload: {
        uid: 'harbor-booking-1',
        startTime: '2026-10-06T15:00:00.000Z',
        endTime: '2026-10-06T15:30:00.000Z',
        organizer: { email: 'david@usecallie.example' },
        attendees: [{ email: 'robin@harbor-booking.example', name: 'Robin Agreed' }],
      },
    };
    const receipt = await inTransaction(async context =>
      await receiveCalcomEvent(context.db, {
        workspaceId: seeded.alpha.workspaceId,
        rawBody: Buffer.from(JSON.stringify(body)),
        body,
      }),
    );
    expect(receipt).toMatchObject({ outcome: 'applied', meetingState: 'booked' });
    const opportunity = await one<{ control_mode: string; control_mode_origin: string }>(
      'SELECT control_mode, control_mode_origin FROM opportunities WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, opportunityId],
    );
    expect(opportunity).toEqual({ control_mode: 'manual', control_mode_origin: 'engaged_call' });

    // 5. The drain, as the one-minute pass runs it.
    await drain();

    expect(await enrollment(prospecting)).toMatchObject({ state: 'stopped' });
    expect(await enrollment(followUp)).toEqual({ state: 'active', end_reason: null });
    const { rows: owed } = await database.session.query<{ owed_enrollment_ids: string[] }>(
      `SELECT owed_enrollment_ids FROM crm_domain_events
        WHERE workspace_id = $1 AND firm_id = $2 AND event_kind = 'opportunity.manual_mode'`,
      [seeded.alpha.workspaceId, firmId],
    );
    for (const row of owed) expect(row.owed_enrollment_ids).not.toContain(followUp);
  });
});
