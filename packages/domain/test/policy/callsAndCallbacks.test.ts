import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeStepExecution } from '../../db/testing/stepExecutions.ts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { readOpenOpportunity } from '../../crm/pipeline.ts';
import { retireRoute } from '../../crm/routes.ts';
import { createCallback, scheduleCallbackForCall } from '../../dial/callbacks.ts';
import { logCallOutcome } from '../../dial/calls.ts';
import { authorizeDialCommand, consumeDialTicket } from '../../dial/tickets.ts';
import { databaseNow } from '../../policy/clock.ts';
import { listApplicableHolds, openHold } from '../../policy/holds.ts';
import { openPause, releasePause } from '../../policy/pauses.ts';
import { revokeStatePosture } from '../../policy/postures.ts';
import { enrollContact } from '../../sequences/enrollments.ts';
import { localInstant } from '../../src/rules/localClock.ts';
import { recordSuppression } from '../../suppression/events.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { buildTodaySnapshot } from '../../today/build.ts';
import { readTodayFirm } from '../../today/dto.ts';
import { businessDateOf, listTodayItems, upsertTodayItem } from '../../today/snapshots.ts';
import { releaseTodayPause, snoozeTodayItem } from '../../today/snooze.ts';
import { callbackTimeNeededItemKey } from '../../today/types.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { firstStageId, seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedPolicy, type SeededPolicy } from '../db/support/policyFixtures.ts';
import { seedSequences, type SeededSequences } from '../sequences/support/sequenceFixtures.ts';

/**
 * Calls and callbacks, against a real PostgreSQL 16.
 *
 * One `describe` per item of the 25 September 2026 audit this lane fixes, each written
 * as the defect it closes:
 *
 *  * C04 — a logged call applies the frozen step's successor or retry, bound through
 *    the Today task, and an engaged call leaves no successor anywhere (Appendix G 26).
 *  * C13 — a call that happened is always recorded; a callback without a confirmed
 *    instant is "Callback — needs a time" on Today until one is set.
 *  * C14 — a refusal leaves nothing written: before the log by deciding first, after
 *    it by a savepoint.
 *  * C15 — "just now" is database time; an entered time is checked with a tolerance.
 *  * C16 — the ticket and the calling identity that authorized the call are recorded.
 *  * C17 — recording the outcome of a callback task completes the callback.
 *  * C18 — a callback's instant is the domain clock's resolution of its local fields,
 *    DST gap included, and a disagreeing `dueAt` is refused.
 *  * S10 — consuming a ticket re-runs `authorizeDial`.
 *  * S15 — a route from another firm or contact never reaches an effect.
 *  * C22 — an automated task's pause is scoped to its enrollment, visible on the card,
 *    and lifted by Resume, never silently by a clock.
 *
 * Every firm here is made fresh for its scenario, because an engaged call is terminal
 * for a firm's automation and a scenario that shared one would test the order the
 * scenarios ran in. No real business name or number appears: the numbers are in the
 * NANP 555-01XX fictional block and the names are fixture names.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let policy: SeededPolicy;
let sequences: SeededSequences;
let businessDate = '';
let firmCounter = 0;

const contextFor = (
  workspaceId: string,
  userId: string,
  role: 'admin' | 'salesperson',
  db: SessionQueryable = database.session,
): RepositoryContext => repositoryContext(workspaceScope(workspaceId, { kind: 'user', userId, role }), db);

const salesperson = (): RepositoryContext =>
  contextFor(seeded.alpha.workspaceId, seeded.alpha.salesperson.userId, 'salesperson');
const admin = (): RepositoryContext => contextFor(seeded.alpha.workspaceId, seeded.alpha.admin.userId, 'admin');
const worker = (): RepositoryContext =>
  repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), database.session);

/** Run one command in a real transaction, the way `runCommand` does in production. */
async function inTransaction<T>(work: (context: RepositoryContext) => Promise<T>): Promise<T> {
  const session = await database.appRuntimeSession();
  await session.query('BEGIN');
  try {
    const value = await work(contextFor(seeded.alpha.workspaceId, seeded.alpha.salesperson.userId, 'salesperson', session));
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
  readonly routeId: string;
  readonly routeVersion: number;
  readonly opportunityId: string;
}

/** A fresh firm in Providence, assigned to the salesperson, with a contact, a number and an open opportunity. */
async function makeFirm(): Promise<Firm> {
  firmCounter += 1;
  const suffix = String(20 + firmCounter).padStart(2, '0');
  const { id: firmId } = await one<{ id: string }>(
    `INSERT INTO firms (workspace_id, name, assigned_user_id, region_code, postal_code,
                        time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
     VALUES ($1, $2, $3, 'RI', '02903', 'America/New_York', 'medium', 'state_default', 'firm-zone.1')
     RETURNING id`,
    [seeded.alpha.workspaceId, `Calls Fixture Holdings ${suffix}`, seeded.alpha.salesperson.userId],
  );
  const { id: contactId } = await one<{ id: string }>(
    'INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id',
    [seeded.alpha.workspaceId, firmId, `Robin Placeholder ${suffix}`],
  );
  const route = await one<{ id: string; version: number }>(
    `INSERT INTO phone_routes (workspace_id, firm_id, contact_id, e164, source, retrieved_at,
                               association_confidence, technical_validation, eligibility, eligibility_policy_version)
     VALUES ($1, $2, $3, $4, 'salesperson', now(), 0.9, 'passed', 'usable', 'route-policy.1')
     RETURNING id, version`,
    [seeded.alpha.workspaceId, firmId, contactId, `+140155501${suffix}`],
  );
  const stageId = await firstStageId(database.session, seeded.alpha.workspaceId);
  const { id: opportunityId } = await one<{ id: string }>(
    'INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at) VALUES ($1, $2, $3, now()) RETURNING id',
    [seeded.alpha.workspaceId, firmId, stageId],
  );
  return { firmId, contactId, routeId: route.id, routeVersion: Number(route.version), opportunityId };
}

/** Another contact at a firm, for a second enrollment beside the first. */
async function addContact(firmId: string, name: string): Promise<string> {
  const { id } = await one<{ id: string }>(
    'INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id',
    [seeded.alpha.workspaceId, firmId, name],
  );
  return id;
}

/** A published two-step version: a call first, configured `onNoAnswer`, then a second call. */
async function callFirstVersion(onNoAnswer: 'advance' | 'retry_call'): Promise<string> {
  const { id: sequenceId } = await one<{ id: string }>(
    'INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id',
    [seeded.alpha.workspaceId, `Call first ${onNoAnswer} ${randomUUID().slice(0, 8)}`, seeded.alpha.admin.userId],
  );
  const { id: versionId } = await one<{ id: string }>(
    'INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 1) RETURNING id',
    [seeded.alpha.workspaceId, sequenceId],
  );
  await database.session.query(
    `INSERT INTO sequence_steps (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, on_no_answer)
     VALUES ($1, $2, 1, 'call_task', 'elapsed', 0, $3)`,
    [seeded.alpha.workspaceId, versionId, onNoAnswer],
  );
  await database.session.query(
    `INSERT INTO sequence_steps (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, on_no_answer)
     VALUES ($1, $2, 2, 'call_task', 'business_days', 2, 'advance')`,
    [seeded.alpha.workspaceId, versionId],
  );
  await database.session.query(
    `UPDATE sequence_versions SET state = 'published', published_at = now(), published_by_user_id = $3
      WHERE workspace_id = $1 AND id = $2`,
    [seeded.alpha.workspaceId, versionId, seeded.alpha.admin.userId],
  );
  return versionId;
}

interface EnrolledCall {
  readonly enrollmentId: string;
  readonly executionId: string;
  readonly itemId: string;
}

/** Enrol a contact and put its due call task on today's list, as the 05:00 build does. */
async function enrolWithCallTask(firm: Firm, contactId: string, versionId: string): Promise<EnrolledCall> {
  const enrolled = await enrollContact(salesperson(), {
    sequenceVersionId: versionId,
    opportunityId: firm.opportunityId,
    firmId: firm.firmId,
    contactId,
  });
  if (!enrolled.ok) throw new Error(`enrollment refused: ${enrolled.reason}`);
  const itemId = await upsertTodayItem(worker(), {
    businessDate,
    firmId: firm.firmId,
    contactId,
    itemKey: `step-execution:${enrolled.value.firstExecutionId}`,
    kind: 'call_due',
    dueAt: enrolled.value.firstDueAt,
    sourceKind: 'step_execution',
    sourceId: enrolled.value.firstExecutionId,
  });
  return { enrollmentId: enrolled.value.enrollmentId, executionId: enrolled.value.firstExecutionId, itemId };
}

async function execution(id: string): Promise<{
  state: string;
  result: string | null;
  completion_source: string | null;
  attempt_count: number;
  due_at: Date;
}> {
  return await one(
    'SELECT state, result, completion_source, attempt_count, due_at FROM step_executions WHERE workspace_id = $1 AND id = $2',
    [seeded.alpha.workspaceId, id],
  );
}

async function executionsOf(enrollmentId: string): Promise<{ ordinal: number; state: string }[]> {
  const { rows } = await database.session.query<{ ordinal: number; state: string }>(
    'SELECT ordinal, state FROM step_executions WHERE workspace_id = $1 AND enrollment_id = $2 ORDER BY ordinal',
    [seeded.alpha.workspaceId, enrollmentId],
  );
  return rows.map(row => ({ ordinal: Number(row.ordinal), state: row.state }));
}

async function itemStatus(itemId: string): Promise<string | undefined> {
  const { rows } = await database.session.query<{ status: string }>(
    'SELECT status FROM today_items WHERE workspace_id = $1 AND id = $2',
    [seeded.alpha.workspaceId, itemId],
  );
  return rows[0]?.status;
}

async function callLogCount(firmId: string): Promise<number> {
  const { rows } = await database.session.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM call_logs WHERE workspace_id = $1 AND firm_id = $2',
    [seeded.alpha.workspaceId, firmId],
  );
  return Number(rows[0]?.count ?? '0');
}

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  policy = await seedPolicy(database.session, seeded, crm);
  sequences = await seedSequences(database.session, seeded);
  businessDate = await businessDateOf(salesperson(), await databaseNow(salesperson()));
});

afterAll(async () => {
  await database.drop();
});

describe('C04: a logged call applies the frozen step, bound through its Today task', () => {
  it('voicemail completes the call step, creates its configured successor and finishes the task', async () => {
    const firm = await makeFirm();
    const enrolled = await enrolWithCallTask(firm, firm.contactId, await callFirstVersion('advance'));

    const logged = await inTransaction(async context =>
      await logCallOutcome(context, { firmId: firm.firmId, itemId: enrolled.itemId, outcome: 'voicemail_left' }),
    );
    if (!logged.ok) throw new Error(`refused: ${logged.reason}`);
    expect(logged.value.stepExecutionId).toBe(enrolled.executionId);
    expect(logged.value.stepApplication).toBe('completed');
    expect(logged.value.successorExecutionId).not.toBeNull();

    expect(await execution(enrolled.executionId)).toMatchObject({
      state: 'completed',
      result: 'voicemail_left',
      completion_source: 'call_log',
    });
    // The successor is the frozen version's step 2, the second call.
    expect(await executionsOf(enrolled.enrollmentId)).toEqual([
      { ordinal: 1, state: 'completed' },
      { ordinal: 2, state: 'pending' },
    ]);
    expect(await itemStatus(enrolled.itemId)).toBe('completed');
    const log = await one<{ step_execution_id: string | null }>(
      'SELECT step_execution_id FROM call_logs WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, logged.value.callLogId],
    );
    expect(log.step_execution_id).toBe(enrolled.executionId);
  });

  it('a no-answer follows the step’s own configuration: retry re-arms the same row, advance moves on', async () => {
    const firm = await makeFirm();
    const retrying = await enrolWithCallTask(firm, firm.contactId, await callFirstVersion('retry_call'));
    const advancing = await enrolWithCallTask(
      firm,
      await addContact(firm.firmId, 'Casey Placeholder'),
      await callFirstVersion('advance'),
    );
    const before = await execution(retrying.executionId);

    // The same request for both. What differs is the published step each is bound to.
    const retried = await inTransaction(async context =>
      await logCallOutcome(context, { firmId: firm.firmId, itemId: retrying.itemId, outcome: 'no_answer' }),
    );
    const advanced = await inTransaction(async context =>
      await logCallOutcome(context, { firmId: firm.firmId, itemId: advancing.itemId, outcome: 'no_answer' }),
    );
    if (!retried.ok || !advanced.ok) throw new Error('refused');

    expect(retried.value.stepEffect).toBe('retry_call');
    expect(retried.value.stepApplication).toBe('retry_scheduled');
    const after = await execution(retrying.executionId);
    expect(after.state).toBe('pending');
    expect(after.attempt_count).toBe(before.attempt_count + 1);
    expect(after.due_at.getTime()).toBeGreaterThan(before.due_at.getTime());
    // One row per step (G8), no successor, and the move is on the shift history.
    expect(await executionsOf(retrying.enrollmentId)).toEqual([{ ordinal: 1, state: 'pending' }]);
    const shift = await one<{ reason: string }>(
      'SELECT reason FROM step_execution_shifts WHERE workspace_id = $1 AND step_execution_id = $2',
      [seeded.alpha.workspaceId, retrying.executionId],
    );
    expect(shift.reason).toBe('retry_call');
    // Today's task is done; the retry is tomorrow's.
    expect(await itemStatus(retrying.itemId)).toBe('completed');

    expect(advanced.value.stepEffect).toBe('advance');
    expect(advanced.value.stepApplication).toBe('completed');
    expect(await execution(advancing.executionId)).toMatchObject({ state: 'completed', result: 'no_answer' });
    expect(await executionsOf(advancing.enrollmentId)).toEqual([
      { ordinal: 1, state: 'completed' },
      { ordinal: 2, state: 'pending' },
    ]);
  });

  it('scenario 26: an engaged call completes the step and leaves no successor anywhere at the firm', async () => {
    const firm = await makeFirm();
    const called = await enrolWithCallTask(firm, firm.contactId, await callFirstVersion('advance'));
    const colleague = await enrolWithCallTask(
      firm,
      await addContact(firm.firmId, 'Bailey Placeholder'),
      await callFirstVersion('advance'),
    );
    // The trap: unexecuted steps existed before the outcome, so "no successor" is a
    // consequence of the outcome and not of a plan that had run out.
    expect(await executionsOf(colleague.enrollmentId)).toEqual([{ ordinal: 1, state: 'pending' }]);

    const logged = await inTransaction(async context =>
      await logCallOutcome(context, { firmId: firm.firmId, itemId: called.itemId, outcome: 'interested' }),
    );
    if (!logged.ok) throw new Error(`refused: ${logged.reason}`);
    expect(logged.value.stepApplication).toBe('completed_and_stopped');
    expect(logged.value.setManual).toBe(true);
    expect(await execution(called.executionId)).toMatchObject({ state: 'completed', result: 'connected' });
    expect(await executionsOf(called.enrollmentId)).toEqual([{ ordinal: 1, state: 'completed' }]);
    // Every live enrollment at the firm ended in the same transaction.
    const { rows } = await database.session.query<{ state: string; end_reason: string | null }>(
      'SELECT state, end_reason FROM sequence_enrollments WHERE workspace_id = $1 AND firm_id = $2',
      [seeded.alpha.workspaceId, firm.firmId],
    );
    expect(rows.map(row => [row.state, row.end_reason])).toEqual([
      ['stopped', 'engaged_call'],
      ['stopped', 'engaged_call'],
    ]);
    expect(await executionsOf(colleague.enrollmentId)).toEqual([{ ordinal: 1, state: 'cancelled' }]);
    expect((await readOpenOpportunity(salesperson(), firm.firmId))?.control_mode).toBe('manual');
  });

  it('a wrong number or a failed call completes nothing, and the task stays', async () => {
    const firm = await makeFirm();
    const enrolled = await enrolWithCallTask(firm, firm.contactId, await callFirstVersion('advance'));
    const logged = await inTransaction(async context =>
      await logCallOutcome(context, {
        firmId: firm.firmId,
        itemId: enrolled.itemId,
        outcome: 'policy_or_technical_failure',
      }),
    );
    if (!logged.ok) throw new Error('refused');
    expect(logged.value.stepApplication).toBe('not_completed');
    expect((await execution(enrolled.executionId)).state).toBe('pending');
    expect(await itemStatus(enrolled.itemId)).toBe('open');
  });
});

describe('C13: a call that happened is always recorded', () => {
  it('records a callback request with no instant and puts "Callback — needs a time" on Today', async () => {
    const firm = await makeFirm();
    const logged = await inTransaction(async context =>
      await logCallOutcome(context, { firmId: firm.firmId, contactId: firm.contactId, outcome: 'callback_requested' }),
    );
    if (!logged.ok) throw new Error(`refused: ${logged.reason}`);
    expect(logged.value.callbackId).toBeNull();
    expect(logged.value.followUps).toEqual([{ kind: 'callback_time_needed', reason: 'no_instant' }]);
    expect(logged.value.setManual).toBe(true);

    const key = callbackTimeNeededItemKey(logged.value.callLogId);
    const card = await readTodayFirm(salesperson(), { firmId: firm.firmId, now: await databaseNow(salesperson()) });
    const task = card?.tasks.find(entry => entry.callLogId === logged.value.callLogId);
    expect(task).toMatchObject({ kind: 'callback', lane: 'callback', status: 'open', callbackId: null });

    // The 05:00 build carries it rather than cancelling it: the callback source makes it.
    await buildTodaySnapshot(worker(), { businessDate, now: await databaseNow(salesperson()) });
    const items = await listTodayItems(salesperson(), { businessDate, firmId: firm.firmId });
    expect(items.find(item => item.itemKey === key)?.status).toBe('open');

    // The time, set later, is the callback — beside the call that asked for it.
    const scheduled = await inTransaction(async context =>
      await scheduleCallbackForCall(context, {
        callLogId: logged.value.callLogId,
        localDate: '2026-09-29',
        localTime: '10:00',
        sourceTimeZone: 'America/New_York',
      }),
    );
    if (!scheduled.ok) throw new Error(`refused: ${scheduled.reason}`);
    expect(scheduled.value.dueAt).toBe('2026-09-29T14:00:00.000Z');
    const callback = await one<{ call_log_id: string }>(
      'SELECT call_log_id FROM callbacks WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, scheduled.value.id],
    );
    expect(callback.call_log_id).toBe(logged.value.callLogId);
    const after = await listTodayItems(salesperson(), { businessDate, firmId: firm.firmId, includeFinished: true });
    expect(after.find(item => item.itemKey === key)?.status).toBe('completed');

    // And no build brings it back.
    await buildTodaySnapshot(worker(), { businessDate, now: await databaseNow(salesperson()) });
    const rebuilt = await listTodayItems(salesperson(), { businessDate, firmId: firm.firmId });
    expect(rebuilt.find(item => item.itemKey === key)).toBeUndefined();
  });

  it('records a wrong number with no route named, and says no number was retired', async () => {
    const firm = await makeFirm();
    const logged = await inTransaction(async context =>
      await logCallOutcome(context, { firmId: firm.firmId, outcome: 'wrong_number' }),
    );
    if (!logged.ok) throw new Error(`refused: ${logged.reason}`);
    expect(logged.value.retiredRouteId).toBeNull();
    expect(logged.value.followUps).toEqual([{ kind: 'route_not_named', reason: 'wrong_number' }]);
    expect(await callLogCount(firm.firmId)).toBe(1);
  });
});

describe('C14: a refusal never leaves a partial write', () => {
  it('refuses before the log: nothing at all is written', async () => {
    const firm = await makeFirm();
    const other = await makeFirm();
    const refused = await inTransaction(async context =>
      await logCallOutcome(context, { firmId: firm.firmId, routeId: other.routeId, outcome: 'interested' }),
    );
    expect(refused).toEqual({ ok: false, reason: 'route_unknown' });
    expect(await callLogCount(firm.firmId)).toBe(0);
    expect((await readOpenOpportunity(salesperson(), firm.firmId))?.control_mode).toBe('automated');
  });

  it('an effect refused after the log rolls every effect back, and the call stays recorded', async () => {
    const firm = await makeFirm();
    const enrolled = await enrolWithCallTask(firm, firm.contactId, await callFirstVersion('advance'));
    // A callback task whose callback row is gone: completing it is refused part-way,
    // after the step, the manual switch and the enrollment stop have been written.
    const staleItem = await upsertTodayItem(worker(), {
      businessDate,
      firmId: firm.firmId,
      contactId: firm.contactId,
      itemKey: `callback:${randomUUID()}`,
      kind: 'callback',
      dueAt: await databaseNow(salesperson()),
      sourceKind: 'callback',
      sourceId: randomUUID(),
    });

    const logged = await inTransaction(async context =>
      await logCallOutcome(context, { firmId: firm.firmId, itemId: staleItem, outcome: 'interested' }),
    );
    if (!logged.ok) throw new Error(`refused: ${logged.reason}`);
    expect(logged.value.followUps).toEqual([{ kind: 'effects_not_applied', reason: 'callback_unknown' }]);
    expect(logged.value.setManual).toBe(false);
    expect(await callLogCount(firm.firmId)).toBe(1);
    // None of the effects survived the savepoint.
    expect((await readOpenOpportunity(salesperson(), firm.firmId))?.control_mode).toBe('automated');
    expect(await executionsOf(enrolled.enrollmentId)).toEqual([{ ordinal: 1, state: 'pending' }]);
    const events = await one<{ count: string }>(
      `SELECT count(*)::text AS count FROM crm_domain_events
        WHERE workspace_id = $1 AND firm_id = $2 AND event_kind = 'opportunity.manual_mode'`,
      [seeded.alpha.workspaceId, firm.firmId],
    );
    expect(events.count).toBe('0');
  });
});

describe('C15: "just now" is the database’s clock', () => {
  it('records now when no time is sent, reads a slightly fast clock as now, and refuses the future', async () => {
    const firm = await makeFirm();
    const before = Date.parse(await databaseNow(salesperson()));
    const justNow = await inTransaction(async context =>
      await logCallOutcome(context, { firmId: firm.firmId, outcome: 'busy' }),
    );
    if (!justNow.ok) throw new Error('refused');
    expect(Date.parse(justNow.value.occurredAt)).toBeGreaterThanOrEqual(before);

    // Thirty seconds fast: the case that used to fail `recorded_at >= occurred_at`.
    const fast = await inTransaction(async context =>
      await logCallOutcome(context, {
        firmId: firm.firmId,
        outcome: 'busy',
        occurredAt: new Date(Date.now() + 30_000).toISOString(),
      }),
    );
    if (!fast.ok) throw new Error(`refused: ${fast.reason}`);
    const row = await one<{ ok: boolean }>(
      'SELECT recorded_at >= occurred_at AS ok FROM call_logs WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, fast.value.callLogId],
    );
    expect(row.ok).toBe(true);

    const future = await inTransaction(async context =>
      await logCallOutcome(context, {
        firmId: firm.firmId,
        outcome: 'busy',
        occurredAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      }),
    );
    expect(future).toEqual({ ok: false, reason: 'occurred_at_in_future' });
  });
});

describe('C16 and S15: the call is recorded with what authorized it, and nothing foreign', () => {
  it('records the ticket, its route and its calling identity from the ticket alone', async () => {
    const context = salesperson();
    const issued = await authorizeDialCommand(context, {
      firmId: crm.alpha.firmId,
      contactId: crm.alpha.contactId,
      routeId: policy.alpha.phoneRouteId,
      routeVersion: policy.alpha.phoneRouteVersion,
      callingIdentityId: policy.alpha.callingIdentityId,
      deviceId: seeded.alpha.salesperson.deviceId,
      commandId: 'g79-carried-ticket',
      at: policy.insideWindow,
    });
    if (!issued.ok) throw new Error(`expected a ticket, got ${issued.reason}`);
    const consumed = await consumeDialTicket(context, {
      ticketId: issued.value.ticketId,
      deviceId: seeded.alpha.salesperson.deviceId,
      at: policy.insideWindow,
    });
    expect(consumed.ok).toBe(true);

    const logged = await inTransaction(async inner =>
      await logCallOutcome(inner, { firmId: crm.alpha.firmId, ticketId: issued.value.ticketId, outcome: 'no_answer' }),
    );
    if (!logged.ok) throw new Error(`refused: ${logged.reason}`);
    const row = await one<{ ticket_id: string; calling_identity_id: string; phone_route_id: string; contact_id: string }>(
      'SELECT ticket_id, calling_identity_id, phone_route_id, contact_id FROM call_logs WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, logged.value.callLogId],
    );
    expect(row).toEqual({
      ticket_id: issued.value.ticketId,
      calling_identity_id: policy.alpha.callingIdentityId,
      phone_route_id: policy.alpha.phoneRouteId,
      contact_id: crm.alpha.contactId,
    });

    // The same ticket named against another firm, or beside another route, is refused.
    const firm = await makeFirm();
    expect(
      await inTransaction(async inner =>
        await logCallOutcome(inner, { firmId: firm.firmId, ticketId: issued.value.ticketId, outcome: 'no_answer' }),
      ),
    ).toEqual({ ok: false, reason: 'ticket_mismatch' });
    expect(
      await inTransaction(async inner =>
        await logCallOutcome(inner, {
          firmId: crm.alpha.firmId,
          ticketId: issued.value.ticketId,
          routeId: firm.routeId,
          outcome: 'no_answer',
        }),
      ),
    ).toEqual({ ok: false, reason: 'ticket_mismatch' });
  });

  it('refuses another firm’s route and another contact’s route before any effect', async () => {
    const firm = await makeFirm();
    const other = await makeFirm();
    const before = await one<{ eligibility: string }>(
      'SELECT eligibility FROM phone_routes WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, other.routeId],
    );
    expect(
      await inTransaction(async context =>
        await logCallOutcome(context, { firmId: firm.firmId, routeId: other.routeId, outcome: 'wrong_number' }),
      ),
    ).toEqual({ ok: false, reason: 'route_unknown' });
    const colleague = await addContact(firm.firmId, 'Drew Placeholder');
    expect(
      await inTransaction(async context =>
        await logCallOutcome(context, {
          firmId: firm.firmId,
          contactId: colleague,
          routeId: firm.routeId,
          outcome: 'wrong_number',
        }),
      ),
    ).toEqual({ ok: false, reason: 'route_unknown' });
    // The foreign route was never retired.
    const after = await one<{ eligibility: string }>(
      'SELECT eligibility FROM phone_routes WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, other.routeId],
    );
    expect(after.eligibility).toBe(before.eligibility);
    expect(await callLogCount(firm.firmId)).toBe(0);
  });
});

describe('C17: the outcome of a callback task completes the callback', () => {
  it('completes it on a conversation, and leaves it open on a missed call', async () => {
    const firm = await makeFirm();
    const make = async (localTime: string): Promise<string> => {
      const created = await createCallback(salesperson(), {
        firmId: firm.firmId,
        contactId: firm.contactId,
        assignedUserId: seeded.alpha.salesperson.userId,
        localDate: businessDate,
        localTime,
        sourceTimeZone: 'America/New_York',
      });
      if (!created.ok) throw new Error(`refused: ${created.reason}`);
      return created.value.id;
    };
    const reached = await make('15:00');
    const missed = await make('16:00');
    const card = await readTodayFirm(salesperson(), { firmId: firm.firmId, now: await databaseNow(salesperson()) });
    const taskOf = (callbackId: string): string => {
      const task = card?.tasks.find(entry => entry.callbackId === callbackId);
      if (task === undefined) throw new Error('the callback is not on the card');
      return task.itemId;
    };

    const logged = await inTransaction(async context =>
      await logCallOutcome(context, { firmId: firm.firmId, itemId: taskOf(reached), outcome: 'interested' }),
    );
    if (!logged.ok) throw new Error(`refused: ${logged.reason}`);
    expect(logged.value.completedCallbackId).toBe(reached);
    const done = await one<{ status: string }>('SELECT status FROM callbacks WHERE workspace_id = $1 AND id = $2', [
      seeded.alpha.workspaceId,
      reached,
    ]);
    expect(done.status).toBe('completed');
    expect(await itemStatus(taskOf(reached))).toBe('completed');

    const noAnswer = await inTransaction(async context =>
      await logCallOutcome(context, { firmId: firm.firmId, itemId: taskOf(missed), outcome: 'no_answer' }),
    );
    if (!noAnswer.ok) throw new Error('refused');
    expect(noAnswer.value.completedCallbackId).toBeNull();
    const open = await one<{ status: string }>('SELECT status FROM callbacks WHERE workspace_id = $1 AND id = $2', [
      seeded.alpha.workspaceId,
      missed,
    ]);
    expect(open.status).toBe('open');
  });
});

describe('C18: a callback’s instant is the domain clock’s answer', () => {
  it('resolves a New York DST gap forward, and refuses the instant the old Mac sent', async () => {
    const firm = await makeFirm();
    const domain = localInstant('2026-03-08', { hour: 2, minute: 30 }, 'America/New_York');
    expect(domain).toBe('2026-03-08T07:30:00.000Z');

    // 01:30 EST: what the Mac's own correction produced for 02:30 that night.
    const old = await createCallback(salesperson(), {
      firmId: firm.firmId,
      assignedUserId: seeded.alpha.salesperson.userId,
      localDate: '2026-03-08',
      localTime: '02:30',
      sourceTimeZone: 'America/New_York',
      dueAt: '2026-03-08T06:30:00.000Z',
    });
    expect(old).toEqual({ ok: false, reason: 'callback_instant_mismatch' });

    const created = await createCallback(salesperson(), {
      firmId: firm.firmId,
      assignedUserId: seeded.alpha.salesperson.userId,
      localDate: '2026-03-08',
      localTime: '02:30',
      sourceTimeZone: 'America/New_York',
      dueAt: domain,
    });
    if (!created.ok) throw new Error(`refused: ${created.reason}`);
    expect(created.value.dueAt).toBe(domain);
    // The local fields the person typed are kept as typed (Appendix D).
    expect(created.value.requestedLocalTime).toBe('02:30:00');
  });

  it('a call whose callback instant disagrees is recorded, with the callback needing a time', async () => {
    const firm = await makeFirm();
    const logged = await inTransaction(async context =>
      await logCallOutcome(context, {
        firmId: firm.firmId,
        outcome: 'callback_requested',
        callback: {
          localDate: '2026-03-08',
          localTime: '02:30',
          sourceTimeZone: 'America/New_York',
          dueAt: '2026-03-08T06:30:00.000Z',
        },
      }),
    );
    if (!logged.ok) throw new Error(`refused: ${logged.reason}`);
    expect(logged.value.callbackId).toBeNull();
    expect(logged.value.followUps).toEqual([{ kind: 'callback_time_needed', reason: 'instant_mismatch' }]);
  });
});

describe('S10: consuming a ticket re-runs the dial decision', () => {
  const issue = async (commandId: string): Promise<string> => {
    const issued = await authorizeDialCommand(salesperson(), {
      firmId: crm.alpha.firmId,
      contactId: crm.alpha.contactId,
      routeId: policy.alpha.phoneRouteId,
      routeVersion: policy.alpha.phoneRouteVersion,
      callingIdentityId: policy.alpha.callingIdentityId,
      deviceId: seeded.alpha.salesperson.deviceId,
      commandId,
      at: policy.insideWindow,
    });
    if (!issued.ok) throw new Error(`expected a ticket, got ${issued.reason}`);
    return issued.value.ticketId;
  };
  const consume = async (ticketId: string) =>
    await consumeDialTicket(salesperson(), {
      ticketId,
      deviceId: seeded.alpha.salesperson.deviceId,
      at: policy.insideWindow,
    });
  const unconsumed = async (ticketId: string): Promise<boolean> =>
    (
      await one<{ consumed_at: Date | null }>('SELECT consumed_at FROM dial_tickets WHERE workspace_id = $1 AND id = $2', [
        seeded.alpha.workspaceId,
        ticketId,
      ])
    ).consumed_at === null;

  it('consumes an untouched ticket (the positive control)', async () => {
    const ticketId = await issue('g79-s10-control');
    expect(await consume(ticketId)).toMatchObject({ ok: true, value: { telUri: `tel:${policy.alpha.e164}` } });
  });

  it('refuses after a calling pause, and writes nothing', async () => {
    const ticketId = await issue('g79-s10-pause');
    const paused = await openPause(admin(), { scopeKind: 'channel', channel: 'call' });
    if (!paused.ok) throw new Error('pause refused');
    expect(await consume(ticketId)).toEqual({ ok: false, reason: 'scoped_pause' });
    expect(await unconsumed(ticketId)).toBe(true);
    await releasePause(admin(), { pauseId: paused.value.id });
    // Decided again on every attempt: with the pause gone, the same ticket is allowed.
    expect((await consume(ticketId)).ok).toBe(true);
  });

  it('refuses during a restore hold', async () => {
    const ticketId = await issue('g79-s10-restore');
    const holdId = await openHold(worker(), {
      scopeKind: 'workspace',
      reasonCode: 'restore_in_progress',
      blockedActionKinds: ['dial_authorization'],
      sourceEventKind: 'restore.detected',
      recoveryAction: 'advance_generation',
    });
    expect(await consume(ticketId)).toEqual({ ok: false, reason: 'restore_in_progress' });
    await database.session.query('UPDATE active_holds SET released_at = now() WHERE workspace_id = $1 AND id = $2', [
      seeded.alpha.workspaceId,
      holdId,
    ]);
  });

  it('refuses after the calling identity is disabled', async () => {
    const ticketId = await issue('g79-s10-identity');
    await database.session.query('UPDATE calling_identities SET enabled = false WHERE workspace_id = $1 AND id = $2', [
      seeded.alpha.workspaceId,
      policy.alpha.callingIdentityId,
    ]);
    expect(await consume(ticketId)).toEqual({ ok: false, reason: 'identity_disabled' });
    await database.session.query('UPDATE calling_identities SET enabled = true WHERE workspace_id = $1 AND id = $2', [
      seeded.alpha.workspaceId,
      policy.alpha.callingIdentityId,
    ]);
  });

  it('refuses after the posture is revoked', async () => {
    const ticketId = await issue('g79-s10-posture');
    expect((await revokeStatePosture(admin(), { postureId: policy.alpha.postureId })).ok).toBe(true);
    expect(await consume(ticketId)).toEqual({ ok: false, reason: 'posture_missing' });
    await database.session.query(
      'UPDATE state_postures SET revoked_at = NULL, revoked_by_user_id = NULL WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, policy.alpha.postureId],
    );
  });

  it('refuses after the number is suppressed', async () => {
    const ticketId = await issue('g79-s10-suppression');
    const suppressed = await recordSuppression(salesperson(), {
      scope: 'handle',
      value: policy.alpha.e164,
      firmId: crm.alpha.firmId,
      source: 'prospect_do_not_call',
      journal: recordingSuppressionJournal(),
    });
    expect(suppressed.ok).toBe(true);
    expect(await consume(ticketId)).toEqual({ ok: false, reason: 'handle_suppressed' });
    expect(await unconsumed(ticketId)).toBe(true);
  });

  it('refuses after the route is retired, on the version the ticket recorded', async () => {
    // The beta workspace: alpha's number is suppressed for good by the case above.
    const context = contextFor(seeded.beta.workspaceId, seeded.beta.salesperson.userId, 'salesperson');
    const issued = await authorizeDialCommand(context, {
      firmId: crm.beta.firmId,
      contactId: crm.beta.contactId,
      routeId: policy.beta.phoneRouteId,
      routeVersion: policy.beta.phoneRouteVersion,
      callingIdentityId: policy.beta.callingIdentityId,
      deviceId: seeded.beta.salesperson.deviceId,
      commandId: 'g79-s10-route',
      at: policy.insideWindow,
    });
    if (!issued.ok) throw new Error(`expected a ticket, got ${issued.reason}`);
    expect((await retireRoute(context, { routeKind: 'phone', routeId: policy.beta.phoneRouteId, reason: 'test' })).ok).toBe(
      true,
    );
    // Retiring bumps the version, so the ticket's recorded version is stale first.
    expect(
      await consumeDialTicket(context, {
        ticketId: issued.value.ticketId,
        deviceId: seeded.beta.salesperson.deviceId,
        at: policy.insideWindow,
      }),
    ).toEqual({ ok: false, reason: 'route_version_stale' });
  });
});

describe('C22: an automated task is paused, visibly, until Resume', () => {
  it('pauses one enrollment’s email, not the firm’s, keeps the task open, and resumes on release', async () => {
    const firm = await makeFirm();
    const pausedExecution = await makeStepExecution(database.session, {
      workspaceId: seeded.alpha.workspaceId,
      firmId: firm.firmId,
      opportunityId: firm.opportunityId,
      userId: seeded.alpha.salesperson.userId,
      templateVersionId: sequences.alpha.template.templateVersionId,
    });
    const otherExecution = await makeStepExecution(database.session, {
      workspaceId: seeded.alpha.workspaceId,
      firmId: firm.firmId,
      opportunityId: firm.opportunityId,
      userId: seeded.alpha.salesperson.userId,
      templateVersionId: sequences.alpha.template.templateVersionId,
    });
    const enrollmentOf = async (executionId: string): Promise<string> =>
      (
        await one<{ enrollment_id: string }>(
          'SELECT enrollment_id FROM step_executions WHERE workspace_id = $1 AND id = $2',
          [seeded.alpha.workspaceId, executionId],
        )
      ).enrollment_id;
    const pausedEnrollment = await enrollmentOf(pausedExecution);
    const otherEnrollment = await enrollmentOf(otherExecution);
    const itemId = await upsertTodayItem(worker(), {
      businessDate,
      firmId: firm.firmId,
      itemKey: `step-execution:${pausedExecution}`,
      kind: 'email_due',
      dueAt: await databaseNow(salesperson()),
      sourceKind: 'step_execution',
      sourceId: pausedExecution,
      automated: true,
    });

    const outcome = await inTransaction(async context =>
      await snoozeTodayItem(context, { itemId, reason: 'Their office is closed this week' }),
    );
    if (!outcome.ok || outcome.value.outcome !== 'held') throw new Error('expected a pause');
    expect(outcome.value.scope).toBe('enrollment');
    const holdId = outcome.value.holdId;

    const blocks = async (enrollmentId: string): Promise<boolean> =>
      (
        await listApplicableHolds(salesperson(), {
          actionKind: 'email_send',
          firmId: firm.firmId,
          enrollmentId,
        })
      ).some(hold => hold.id === holdId);
    expect(await blocks(pausedEnrollment)).toBe(true);
    // Not firm-wide: the colleague's email at the same firm is not paused by it.
    expect(await blocks(otherEnrollment)).toBe(false);

    // Visible: the task stays open, carrying the hold its Resume control releases.
    expect(await itemStatus(itemId)).toBe('open');
    const card = await readTodayFirm(salesperson(), { firmId: firm.firmId, now: await databaseNow(salesperson()) });
    expect(card?.tasks.find(task => task.itemId === itemId)?.pauseHoldId).toBe(holdId);

    // No clock releases it: nothing but Resume does.
    const released = await inTransaction(async context => await releaseTodayPause(context, { holdId }));
    if (!released.ok) throw new Error(`refused: ${released.reason}`);
    expect(released.value.resume).toBe('resume');
    expect(await blocks(pausedEnrollment)).toBe(false);
    const after = await readTodayFirm(salesperson(), { firmId: firm.firmId, now: await databaseNow(salesperson()) });
    expect(after?.tasks.find(task => task.itemId === itemId)?.pauseHoldId).toBeNull();
    expect(await inTransaction(async context => await releaseTodayPause(context, { holdId }))).toEqual({
      ok: false,
      reason: 'pause_already_released',
    });
  });
});
