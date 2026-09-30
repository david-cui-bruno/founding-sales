import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { emitCrmDomainEvent } from '../../crm/events.ts';
import { changeStage, setManualControlMode } from '../../crm/pipeline.ts';
import { logCallOutcome } from '../../dial/calls.ts';
import { enrollContact } from '../../sequences/enrollments.ts';
import { grantFollowUpPermission } from '../../sequences/followUpPermissions.ts';
import { consumeTerminalStops } from '../../sequences/terminalStops.ts';
import { firstStageId, seedCrm } from '../db/support/crmFixtures.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * Scoped terminal stops (migration 0026; P0-2 of the send-path v2 plan review).
 *
 * A terminal-stop event records, when it is emitted, the enrollments it owes a stop to
 * (`crm_domain_events.owed_enrollment_ids`), and the drain stops those and no others.
 * The case that made this necessary is the first one: an interested call puts the firm
 * in manual mode, and the same command then enrolls the sequence the person agreed to.
 * Before 0026 the drain, a minute later, stopped every enrollment live at the firm *at
 * drain time* — the agreed sequence included.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let firmCounter = 0;

const contextFor = (db: SessionQueryable = database.session): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: seeded.alpha.salesperson.userId,
      role: 'salesperson',
    }),
    db,
  );
const worker = (): RepositoryContext =>
  repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), database.session);

/** One command in one real transaction, as `runCommand` runs it in production. */
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

async function one<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[]): Promise<Row> {
  const { rows } = await database.session.query<Row>(sql, values);
  const row = rows[0];
  if (row === undefined) throw new Error(`no row: ${sql.slice(0, 60)}`);
  return row;
}

interface Firm {
  readonly firmId: string;
  readonly contactId: string;
  readonly opportunityId: string;
}

async function makeFirm(): Promise<Firm> {
  firmCounter += 1;
  const { id: firmId } = await one<{ id: string }>(
    `INSERT INTO firms (workspace_id, name, assigned_user_id, region_code, postal_code,
                        time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
     VALUES ($1, $2, $3, 'RI', '02903', 'America/New_York', 'medium', 'state_default', 'firm-zone.1')
     RETURNING id`,
    [seeded.alpha.workspaceId, `Scoped Stops Holdings ${String(firmCounter)}`, seeded.alpha.salesperson.userId],
  );
  const contactId = await addContact(firmId, `Robin Scoped ${String(firmCounter)}`);
  const stageId = await firstStageId(database.session, seeded.alpha.workspaceId);
  const { id: opportunityId } = await one<{ id: string }>(
    'INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at) VALUES ($1, $2, $3, now()) RETURNING id',
    [seeded.alpha.workspaceId, firmId, stageId],
  );
  return { firmId, contactId, opportunityId };
}

async function addContact(firmId: string, name: string): Promise<string> {
  const { id } = await one<{ id: string }>(
    'INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id',
    [seeded.alpha.workspaceId, firmId, name],
  );
  return id;
}

/** A published two-step call version, far enough out that nothing becomes due. */
async function publishedVersion(): Promise<string> {
  const { id: sequenceId } = await one<{ id: string }>(
    'INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id',
    [seeded.alpha.workspaceId, `Scoped stops ${randomUUID().slice(0, 8)}`, seeded.alpha.admin.userId],
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

/** A follow-up enrollment on the strength of a recorded call that agreed to the version. */
async function enrolFollowUp(context: RepositoryContext, firm: Firm, contactId: string, versionId: string): Promise<string> {
  const { rows } = await context.db.query<{ id: string }>(
    `INSERT INTO call_logs
       (workspace_id, firm_id, contact_id, opportunity_id, outcome, step_effect, occurred_at,
        actor_user_id, agreed_follow_up, agreed_sequence_version_id)
     VALUES ($1, $2, $3, $4, 'interested', 'none', now() - interval '1 second', $5, 'agreed_sequence', $6)
     RETURNING id`,
    [seeded.alpha.workspaceId, firm.firmId, contactId, firm.opportunityId, seeded.alpha.salesperson.userId, versionId],
  );
  const granted = await grantFollowUpPermission(context, {
    firmId: firm.firmId,
    contactId,
    callLogId: rows[0]?.id ?? '',
    grantedByUserId: seeded.alpha.salesperson.userId,
  });
  if (!granted.ok) throw new Error(`grant refused: ${granted.reason}`);
  return await enrol(context, firm, contactId, versionId, granted.value.id);
}

async function enrol(
  context: RepositoryContext,
  firm: Firm,
  contactId: string,
  versionId: string,
  permissionId: string,
): Promise<string> {
  const enrolled = await enrollContact(context, {
    sequenceVersionId: versionId,
    originKind: 'follow_up',
    permissionId,
    opportunityId: firm.opportunityId,
    firmId: firm.firmId,
    contactId,
  });
  if (!enrolled.ok) throw new Error(`enrollment refused: ${enrolled.reason}`);
  return enrolled.value.enrollmentId;
}

async function enrollment(id: string): Promise<{ state: string; end_reason: string | null }> {
  return await one('SELECT state, end_reason FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2', [
    seeded.alpha.workspaceId,
    id,
  ]);
}

async function executionsOf(enrollmentId: string): Promise<{ ordinal: number; state: string }[]> {
  const { rows } = await database.session.query<{ ordinal: number; state: string }>(
    'SELECT ordinal, state FROM step_executions WHERE workspace_id = $1 AND enrollment_id = $2 ORDER BY ordinal',
    [seeded.alpha.workspaceId, enrollmentId],
  );
  return rows.map(row => ({ ordinal: Number(row.ordinal), state: row.state }));
}

/** Drain everything the workspace owes, as the one-minute pass does. */
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

describe('a terminal stop stops what it owed when it was emitted, and nothing created after', () => {
  it('log interested → grant → enrol → drain: the agreed sequence keeps its first step', async () => {
    const firm = await makeFirm();
    const earlierVersion = await publishedVersion();
    const agreedVersion = await publishedVersion();
    await drain();
    // A sequence already running at the firm, which the conversation must stop.
    const earlier = await inTransaction(
      async context => await enrolFollowUp(context, firm, firm.contactId, earlierVersion),
    );

    // The command S3 builds: the interested call (manual mode, engaged-call stop, the
    // grant from the agreement on the log) and the enrollment of the agreed sequence, in
    // one transaction.
    const agreed = await inTransaction(async context => {
      const logged = await logCallOutcome(context, {
        firmId: firm.firmId,
        contactId: firm.contactId,
        outcome: 'interested',
        followUpPermission: { scope: 'agreed_sequence', sequenceVersionId: agreedVersion },
      });
      if (!logged.ok) throw new Error(`call refused: ${logged.reason}`);
      expect(logged.value.setManual).toBe(true);
      const permissionId = logged.value.followUpPermissionId;
      if (permissionId === null) throw new Error(`no permission: ${JSON.stringify(logged.value.followUps)}`);
      return await enrol(context, firm, firm.contactId, agreedVersion, permissionId);
    });

    // The marker names the earlier enrollment, and only it.
    const event = await one<{ owed_enrollment_ids: string[] | null }>(
      `SELECT owed_enrollment_ids FROM crm_domain_events
        WHERE workspace_id = $1 AND firm_id = $2 AND event_kind = 'opportunity.manual_mode'`,
      [seeded.alpha.workspaceId, firm.firmId],
    );
    expect(event.owed_enrollment_ids).toEqual([earlier]);

    await drain();

    expect(await enrollment(earlier)).toEqual({ state: 'stopped', end_reason: 'engaged_call' });
    expect(await enrollment(agreed)).toEqual({ state: 'active', end_reason: null });
    expect(await executionsOf(agreed)).toEqual([{ ordinal: 1, state: 'pending' }]);
  });

  it('owes an enrollment committed just before the emission, even one racing it (the send gate)', async () => {
    // Two transactions at once. A enrolls and holds the exclusive send gate
    // (`enrollContact` takes it first); B sets the firm manual and must take the same gate
    // before `emitCrmDomainEvent` computes what it owes. B waits, A commits, and B's
    // marker names A's enrollment: nothing committed before the emission escapes it.
    const firm = await makeFirm();
    const version = await publishedVersion();
    await drain();
    const first = await database.appRuntimeSession();
    const second = await database.appRuntimeSession();
    await first.query('BEGIN');
    const racing = await enrolFollowUp(contextFor(first), firm, firm.contactId, version);

    await second.query('BEGIN');
    const { rows: pid } = await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const manual = setManualControlMode(contextFor(second), {
      opportunityId: firm.opportunityId,
      reason: 'confirmed human reply',
      origin: 'human_reply',
    });
    try {
      // B is observably waiting on the gate before A commits, so this is the race and
      // not two transactions that happened to run one after the other.
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
        const { rows } = await database.session.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_locks
            WHERE pid = $1 AND locktype = 'advisory' AND NOT granted`,
          [pid[0]?.pid],
        );
        waiting = rows[0]?.count === '1';
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await first.query('COMMIT');
      const changed = await manual;
      expect(changed.ok).toBe(true);
      await second.query('COMMIT');
    } finally {
      // A failed assertion must not leave either transaction holding the gate for the
      // cases after this one. Both are no-ops once the COMMITs above ran.
      await first.query('ROLLBACK').catch(() => undefined);
      await manual.catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
    }

    const event = await one<{ owed_enrollment_ids: string[] | null }>(
      `SELECT owed_enrollment_ids FROM crm_domain_events
        WHERE workspace_id = $1 AND firm_id = $2 AND event_kind = 'opportunity.manual_mode'`,
      [seeded.alpha.workspaceId, firm.firmId],
    );
    expect(event.owed_enrollment_ids).toEqual([racing]);
    await drain();
    expect(await enrollment(racing)).toEqual({ state: 'stopped', end_reason: 'human_reply' });
  });

  it('a stop committed after the drain passed a later one is still read: instants follow the gate, not BEGIN', async () => {
    // Review of PR 335, round 2, P1. A begins first, so its transaction-start `now()` is
    // the earliest instant here, but takes the gate last. B emits and commits a stop, the
    // drain runs past it, then A emits and commits. Stamped with `now()`, A's event would
    // sort before B's and behind the cursor for ever.
    const early = await makeFirm();
    const late = await makeFirm();
    const version = await publishedVersion();
    const owedByA = await inTransaction(async context => await enrolFollowUp(context, early, early.contactId, version));
    await drain();

    const a = await database.appRuntimeSession();
    await a.query('BEGIN');
    await a.query('SELECT now()');
    await new Promise(resolve => setTimeout(resolve, 20));
    try {
      await inTransaction(async context => {
        const changed = await setManualControlMode(context, {
          opportunityId: late.opportunityId,
          reason: 'B, committed first',
          origin: 'human_reply',
        });
        expect(changed.ok).toBe(true);
      });
      await drain();
      const changed = await setManualControlMode(contextFor(a), {
        opportunityId: early.opportunityId,
        reason: 'A, begun first and committed last',
        origin: 'human_reply',
      });
      expect(changed.ok).toBe(true);
      await a.query('COMMIT');
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
    }
    await drain();
    expect(await enrollment(owedByA)).toEqual({ state: 'stopped', end_reason: 'human_reply' });
  });

  it('still stops, at the drain, an owed enrollment the command itself did not stop', async () => {
    // The event is the source of truth for the stop: an owed enrollment that is live when
    // the drain runs is stopped by the drain, with the event's reason.
    const firm = await makeFirm();
    const version = await publishedVersion();
    const owed = await inTransaction(async context => await enrolFollowUp(context, firm, firm.contactId, version));
    await drain();
    await database.session.query(
      `INSERT INTO crm_domain_events
         (workspace_id, event_kind, firm_id, opportunity_id, dedupe_key, actor_kind, detail, owed_enrollment_ids)
       VALUES ($1, 'opportunity.manual_mode', $2, $3, $4, 'system', '{"origin":"human_reply"}', ARRAY[$5::uuid])`,
      [seeded.alpha.workspaceId, firm.firmId, firm.opportunityId, `scoped-${randomUUID()}`, owed],
    );
    // Created after the event: not owed.
    const later = await inTransaction(
      async context => await enrolFollowUp(context, firm, await addContact(firm.firmId, 'Later Person'), version),
    );
    await drain();
    expect(await enrollment(owed)).toEqual({ state: 'stopped', end_reason: 'human_reply' });
    expect(await enrollment(later)).toEqual({ state: 'active', end_reason: null });
  });

  it('refuses a new stop event that records no set (the NOT VALID CHECK)', async () => {
    const firm = await makeFirm();
    await expect(
      database.session.query(
        `INSERT INTO crm_domain_events (workspace_id, event_kind, firm_id, opportunity_id, dedupe_key, actor_kind)
         VALUES ($1, 'opportunity.manual_mode', $2, $3, $4, 'system')`,
        [seeded.alpha.workspaceId, firm.firmId, firm.opportunityId, `unmarked-${randomUUID()}`],
      ),
    ).rejects.toMatchObject({ constraint: 'crm_domain_events_stop_carries_marker' });
  });

  it('a direct emitter waits on the gate: an enrollment racing emitCrmDomainEvent is owed', async () => {
    // No caller-side lock at all: `emitCrmDomainEvent` called on its own, in a
    // transaction that holds nothing, while another transaction has enrolled and still
    // holds the exclusive send gate. Only the gate `emitCrmDomainEvent` takes itself makes
    // the emission wait for that enrollment to commit (review of PR 335, P2-b).
    const firm = await makeFirm();
    const version = await publishedVersion();
    await drain();
    const first = await database.appRuntimeSession();
    const second = await database.appRuntimeSession();
    await first.query('BEGIN');
    const racing = await enrolFollowUp(contextFor(first), firm, firm.contactId, version);
    await second.query('BEGIN');
    const { rows: pid } = await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const dedupeKey = `direct-${randomUUID()}`;
    const emitted = emitCrmDomainEvent(contextFor(second), {
      kind: 'opportunity.manual_mode',
      firmId: firm.firmId,
      opportunityId: firm.opportunityId,
      dedupeKey,
      detail: { origin: 'human_reply' },
    });
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 50 && !waiting; attempt += 1) {
        const { rows } = await database.session.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted`,
          [pid[0]?.pid],
        );
        waiting = rows[0]?.count === '1';
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
      await first.query('COMMIT');
      await emitted;
      await second.query('COMMIT');
      expect(waiting).toBe(true);
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await emitted.catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
    }
    const event = await one<{ owed_enrollment_ids: string[] | null }>(
      'SELECT owed_enrollment_ids FROM crm_domain_events WHERE workspace_id = $1 AND dedupe_key = $2',
      [seeded.alpha.workspaceId, dedupeKey],
    );
    expect(event.owed_enrollment_ids).toEqual([racing]);
    await drain();
    expect(await enrollment(racing)).toEqual({ state: 'stopped', end_reason: 'human_reply' });
  });

  it('a close owes the opportunity’s live enrollments at emission', async () => {
    const firm = await makeFirm();
    const version = await publishedVersion();
    const running = await inTransaction(async context => await enrolFollowUp(context, firm, firm.contactId, version));
    await drain();
    const closed = await inTransaction(
      async context =>
        await changeStage(context, {
          opportunityId: firm.opportunityId,
          toStageKey: 'lost',
          reason: 'Scoped-stop fixture',
        }),
    );
    expect(closed.ok).toBe(true);
    const event = await one<{ owed_enrollment_ids: string[] | null }>(
      `SELECT owed_enrollment_ids FROM crm_domain_events
        WHERE workspace_id = $1 AND opportunity_id = $2 AND event_kind = 'opportunity.terminal_stop'`,
      [seeded.alpha.workspaceId, firm.opportunityId],
    );
    expect(event.owed_enrollment_ids).toEqual([running]);
    await drain();
    expect(await enrollment(running)).toEqual({ state: 'stopped', end_reason: 'stage_lost' });
  });

  it('writes no marker on a kind that stops nothing', async () => {
    const firm = await makeFirm();
    await expect(
      database.session.query(
        `INSERT INTO crm_domain_events (workspace_id, event_kind, firm_id, dedupe_key, actor_kind, owed_enrollment_ids)
         VALUES ($1, 'firm.reassigned', $2, $3, 'system', '{}')`,
        [seeded.alpha.workspaceId, firm.firmId, `reassigned-${randomUUID()}`],
      ),
    ).rejects.toMatchObject({ constraint: 'crm_domain_events_owed_only_on_stops' });
  });
});
