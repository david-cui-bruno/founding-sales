import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { databaseNow, openHold } from '../../policy/index.ts';
import {
  COMPLETION_ANCHOR_RULE_SUFFIX,
  DEFAULT_HOLD_RECHECK_MILLISECONDS,
  allowAllEligibility,
  dispatchPreparedStep,
  enrollContact,
  listStepExecutions,
  readEnrollment,
  recordingSendHandoff,
  resumeEnrollment,
  runDueStepExecution,
  type RecordingSendHandoff,
} from '../../sequences/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedSequences, type SeededSequences } from './support/sequenceFixtures.ts';

/**
 * A step run more than once (lane g82: audit C05, C09, C11).
 *
 * * **C11** — a completed step's successor is the start-anchored plan while steps run on
 *   time, and the plan's spacing counted from when the step actually happened when it
 *   ran late. For an email that is the fence's original dispatch time, never the
 *   moment a reconciliation or an admin settled it (12.5, Appendix B).
 * * **Settling from the fence** — a step whose fence already exists is driven from the
 *   fence: `sent` completes it, an unanswered `unknown_terminal` holds it, the admin's
 *   answer continues or stops the sequence and takes the firm's terminal hold with it.
 * * **C09** — a second resume counts only what the first did not apply.
 * * **The interval a held step waits** — a step an open hold blocks keeps its
 *   `not_before`, so the wake takes it straight after the release; any other held step
 *   waits out its reason's recheck.
 *
 * The seeded version is email at 0 hours, a call at two business days and a LinkedIn
 * task at four, all "after enrollment". Monday 21 September 2026 09:00 New York is
 * 13:00Z; 08:00 New York on a business day in September is 12:00Z.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let sequences: SeededSequences;

const MONDAY_NINE = '2026-09-21T13:00:00.000Z';

const salesperson = (): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }),
    database.session,
  );

const worker = (): RepositoryContext =>
  repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), database.session);

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  sequences = await seedSequences(database.session, seeded);
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  for (const table of [
    'enrollment_linkedin_results',
    'step_execution_shifts',
    'step_executions',
    'sequence_enrollments',
    'active_holds',
  ]) {
    await database.session.query(`DELETE FROM ${table}`);
  }
  await database.session.query(
    `UPDATE opportunities SET status = 'open', closed_at = NULL, close_reason = NULL,
            control_mode = 'automated', control_mode_reason = NULL`,
  );
});

/** Enroll the seeded contact, started Monday 09:00 New York with its email due then. */
async function enrollMonday(): Promise<{ readonly enrollmentId: string; readonly emailExecutionId: string }> {
  const result = await enrollContact(salesperson(), {
    sequenceVersionId: sequences.alpha.publishedVersionId,
    opportunityId: crm.alpha.opportunityId,
    firmId: crm.alpha.firmId,
    contactId: crm.alpha.contactId,
  });
  if (!result.ok) throw new Error(`the enrollment fixture was refused: ${result.reason}`);
  const enrollmentId = result.value.enrollmentId;
  await database.session.query(
    `UPDATE sequence_enrollments SET started_at = $3::timestamptz, created_at = $3::timestamptz
      WHERE workspace_id = $1 AND id = $2`,
    [seeded.alpha.workspaceId, enrollmentId, MONDAY_NINE],
  );
  await database.session.query(
    `UPDATE step_executions SET due_at = $3::timestamptz, not_before = $3::timestamptz, original_due_at = $3::timestamptz
      WHERE workspace_id = $1 AND enrollment_id = $2`,
    [seeded.alpha.workspaceId, enrollmentId, MONDAY_NINE],
  );
  const [email] = await listStepExecutions(worker(), { enrollmentId });
  if (email === undefined) throw new Error('the enrollment has no first execution');
  return { enrollmentId, emailExecutionId: email.id };
}

/** Run the Monday email step through preparation. */
async function prepareEmail(handoff: RecordingSendHandoff, stepExecutionId: string): Promise<string> {
  const outcome = await runDueStepExecution(worker(), {
    stepExecutionId,
    now: MONDAY_NINE,
    eligibility: allowAllEligibility(),
    sendHandoff: handoff,
  });
  if (outcome.kind !== 'handed_to_send') throw new Error(`the email step was ${outcome.kind}`);
  return outcome.outboundMessageId;
}

async function executionRow(stepExecutionId: string) {
  const { rows } = await database.session.query<{
    state: string;
    hold_reason_code: string | null;
    not_before: Date;
    due_at: Date;
    completed_at: Date | null;
    rule_version: string;
  }>(
    'SELECT state, hold_reason_code, not_before, due_at, completed_at, rule_version FROM step_executions WHERE workspace_id = $1 AND id = $2',
    [seeded.alpha.workspaceId, stepExecutionId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no such execution');
  return row;
}

async function successorOf(enrollmentId: string) {
  const executions = await listStepExecutions(worker(), { enrollmentId });
  const call = executions.find(execution => execution.ordinal === 2);
  if (call === undefined) throw new Error('the call step was not created');
  return { ...call, row: await executionRow(call.id) };
}

describe('C11: the successor of a late email keeps its spacing from the original dispatch', () => {
  it('an email sent on time leaves the call where the plan put it', async () => {
    const { enrollmentId, emailExecutionId } = await enrollMonday();
    const handoff = recordingSendHandoff();
    const fenceId = await prepareEmail(handoff, emailExecutionId);
    handoff.dispatchesTo(emailExecutionId, { state: 'sent', dispatchedAt: '2026-09-21T13:05:00.000Z', heldReason: null });
    const sent = await dispatchPreparedStep(worker(), {
      stepExecutionId: emailExecutionId,
      outboundMessageId: fenceId,
      sendHandoff: handoff,
      now: '2026-09-21T13:05:01.000Z',
    });
    expect(sent.kind).toBe('sent');

    const call = await successorOf(enrollmentId);
    expect(call.dueAt).toBe('2026-09-23T12:00:00.000Z');
    expect(call.row.rule_version.endsWith(COMPLETION_ANCHOR_RULE_SUFFIX)).toBe(false);
  });

  it('an email that went Thursday puts the call two business days after Thursday, not due at once', async () => {
    const { enrollmentId, emailExecutionId } = await enrollMonday();
    const handoff = recordingSendHandoff();
    const fenceId = await prepareEmail(handoff, emailExecutionId);
    handoff.dispatchesTo(emailExecutionId, { state: 'sent', dispatchedAt: '2026-09-24T14:00:00.000Z', heldReason: null });
    await dispatchPreparedStep(worker(), {
      stepExecutionId: emailExecutionId,
      outboundMessageId: fenceId,
      sendHandoff: handoff,
      now: '2026-09-24T14:00:01.000Z',
    });

    const email = await executionRow(emailExecutionId);
    expect(email.completed_at?.toISOString()).toBe('2026-09-24T14:00:00.000Z');
    const call = await successorOf(enrollmentId);
    // The plan said Wednesday; Thursday + two business days is Monday 28 September.
    expect(call.dueAt).toBe('2026-09-28T12:00:00.000Z');
    expect(call.row.rule_version.endsWith(COMPLETION_ANCHOR_RULE_SUFFIX)).toBe(true);
  });

  it('a send the Sent folder confirms days later continues from the original dispatch, not the confirmation', async () => {
    const { enrollmentId, emailExecutionId } = await enrollMonday();
    const handoff = recordingSendHandoff();
    const fenceId = await prepareEmail(handoff, emailExecutionId);
    handoff.dispatchesTo(emailExecutionId, { state: 'reconciling', dispatchedAt: '2026-09-21T13:05:00.000Z', heldReason: null });
    const inDoubt = await dispatchPreparedStep(worker(), {
      stepExecutionId: emailExecutionId,
      outboundMessageId: fenceId,
      sendHandoff: handoff,
      now: '2026-09-21T13:05:01.000Z',
    });
    expect(inDoubt).toEqual({ kind: 'held', stepExecutionId: emailExecutionId, reasonCode: 'send_unknown_reconciling' });

    // Thursday: the Sent folder found it. The step's next wake reads the fence.
    handoff.setOutcome(emailExecutionId, {
      state: 'sent',
      dispatchedAt: '2026-09-21T13:05:00.000Z',
      heldReason: null,
      outboundMessageId: fenceId,
    });
    const settled = await runDueStepExecution(worker(), {
      stepExecutionId: emailExecutionId,
      now: '2026-09-24T15:00:00.000Z',
      eligibility: allowAllEligibility(),
      sendHandoff: handoff,
    });
    expect(settled).toEqual({ kind: 'completed', stepExecutionId: emailExecutionId, result: 'sent' });
    expect((await executionRow(emailExecutionId)).completed_at?.toISOString()).toBe('2026-09-21T13:05:00.000Z');
    // Not Thursday + 2: the reconciliation's delay does not move the cadence.
    expect((await successorOf(enrollmentId)).dueAt).toBe('2026-09-23T12:00:00.000Z');
    expect(handoff.dispatched).toEqual([fenceId]);
  });
});

describe('an unknown-terminal fence waits for the admin, and the answer moves the sequence', () => {
  async function terminalStep(): Promise<{
    readonly enrollmentId: string;
    readonly emailExecutionId: string;
    readonly fenceId: string;
    readonly handoff: RecordingSendHandoff;
  }> {
    const { enrollmentId, emailExecutionId } = await enrollMonday();
    const handoff = recordingSendHandoff();
    const fenceId = await prepareEmail(handoff, emailExecutionId);
    handoff.setOutcome(emailExecutionId, {
      state: 'unknown_terminal',
      dispatchedAt: '2026-09-21T13:05:00.000Z',
      heldReason: null,
      outboundMessageId: fenceId,
    });
    // The hold reconciliation opens on the firm when the observation expires.
    await openHold(worker(), {
      scopeKind: 'firm',
      scopeKey: crm.alpha.firmId,
      reasonCode: 'send_unknown_terminal',
      blockedActionKinds: ['email_send', 'enrollment_advance'],
      sourceEventKind: 'outbound_message',
      sourceEventId: fenceId,
      recoveryAction: 'mark_delivered_or_skipped',
    });
    return { enrollmentId, emailExecutionId, fenceId, handoff };
  }

  const run = async (handoff: RecordingSendHandoff, stepExecutionId: string) =>
    await runDueStepExecution(worker(), {
      stepExecutionId,
      now: '2026-09-23T14:00:00.000Z',
      eligibility: allowAllEligibility(),
      sendHandoff: handoff,
    });

  const openTerminalHolds = async (fenceId: string): Promise<number> => {
    const { rows } = await database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM active_holds
        WHERE workspace_id = $1 AND source_event_id = $2 AND reason_code = 'send_unknown_terminal'
          AND released_at IS NULL`,
      [seeded.alpha.workspaceId, fenceId],
    );
    return Number(rows[0]?.count ?? '0');
  };

  it('unanswered, it holds and leaves the firm’s terminal hold where it is', async () => {
    // (That its own fence's hold does not keep the step from being asked again is the
    // wake's rule, proved against a real fence in `wake.test.ts`.)
    const step = await terminalStep();
    expect(await run(step.handoff, step.emailExecutionId)).toEqual({
      kind: 'held',
      stepExecutionId: step.emailExecutionId,
      reasonCode: 'send_unknown_terminal',
    });
    expect((await executionRow(step.emailExecutionId)).state).toBe('held');
    expect(await openTerminalHolds(step.fenceId)).toBe(1);
    expect(step.handoff.dispatched).toEqual([]);
  });

  it('delivered continues the sequence from the original dispatch and lifts the firm’s terminal hold', async () => {
    const step = await terminalStep();
    step.handoff.setOutcome(step.emailExecutionId, {
      state: 'unknown_terminal',
      dispatchedAt: '2026-09-21T13:05:00.000Z',
      heldReason: null,
      outboundMessageId: step.fenceId,
      adminResolution: 'delivered',
    });
    expect(await run(step.handoff, step.emailExecutionId)).toEqual({
      kind: 'completed',
      stepExecutionId: step.emailExecutionId,
      result: 'sent',
    });
    expect((await executionRow(step.emailExecutionId)).completed_at?.toISOString()).toBe('2026-09-21T13:05:00.000Z');
    expect((await successorOf(step.enrollmentId)).dueAt).toBe('2026-09-23T12:00:00.000Z');
    expect(await openTerminalHolds(step.fenceId)).toBe(0);
    expect(step.handoff.dispatched).toEqual([]);
  });

  it('skipped stops the enrollment for review and never resends', async () => {
    const step = await terminalStep();
    step.handoff.setOutcome(step.emailExecutionId, {
      state: 'unknown_terminal',
      dispatchedAt: '2026-09-21T13:05:00.000Z',
      heldReason: null,
      outboundMessageId: step.fenceId,
      adminResolution: 'skipped',
    });
    expect((await run(step.handoff, step.emailExecutionId)).kind).toBe('completed');
    const enrollment = await readEnrollment(worker(), { enrollmentId: step.enrollmentId });
    expect(enrollment?.state).toBe('stopped');
    expect(enrollment?.endReason).toBe('send_skipped');
    expect(await openTerminalHolds(step.fenceId)).toBe(0);
    expect(step.handoff.dispatched).toEqual([]);
  });
});

describe('C09: a second resume shifts by what the first did not apply', () => {
  it('a one-day pause and, later, a two-hour one shift the steps a day and then two hours — not a day and two hours again', async () => {
    const { enrollmentId, emailExecutionId } = await enrollMonday();
    await database.session.query(
      `UPDATE sequence_enrollments SET started_at = now() - interval '10 days', created_at = now() - interval '10 days'
        WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, enrollmentId],
    );
    const pause = async (startedAgo: string, releasedAgo: string): Promise<void> => {
      const id = await openHold(worker(), {
        scopeKind: 'firm',
        scopeKey: crm.alpha.firmId,
        reasonCode: 'scoped_pause',
        blockedActionKinds: ['email_send', 'enrollment_advance'],
        sourceEventKind: 'administrative_pause',
      });
      await database.session.query(
        `UPDATE active_holds SET started_at = now() - $2::interval, released_at = now() - $3::interval WHERE id = $1`,
        [id, startedAgo, releasedAgo],
      );
    };

    await pause('5 days', '4 days');
    const first = await resumeEnrollment(worker(), { enrollmentId });
    expect(first.ok && first.value.kind).toBe('resume');
    if (!first.ok) return;
    expect(first.value.shiftMilliseconds / 3_600_000).toBeCloseTo(24, 1);
    expect(first.value.executionsShifted).toBe(1);
    // That resume ran three hours ago.
    await database.session.query(
      `UPDATE step_execution_shifts SET shifted_at = now() - interval '3 hours'
        WHERE workspace_id = $1 AND enrollment_id = $2`,
      [seeded.alpha.workspaceId, enrollmentId],
    );

    await pause('2 hours', '0 seconds');
    const second = await resumeEnrollment(worker(), { enrollmentId });
    expect(second.ok && second.value.kind).toBe('resume');
    if (!second.ok) return;
    const hours = second.value.shiftMilliseconds / 3_600_000;
    expect(hours).toBeGreaterThan(1.9);
    expect(hours).toBeLessThan(2.1);

    const { rows } = await database.session.query<{ total: string }>(
      `SELECT sum(shift_milliseconds)::text AS total FROM step_execution_shifts
        WHERE workspace_id = $1 AND step_execution_id = $2 AND reason = 'hold_union'`,
      [seeded.alpha.workspaceId, emailExecutionId],
    );
    expect(Number(rows[0]?.total ?? '0') / 3_600_000).toBeCloseTo(26, 1);
  });

  it('a seven-day review is asked of the episode that just ended, not the lifetime total', async () => {
    const { enrollmentId } = await enrollMonday();
    await database.session.query(
      `UPDATE sequence_enrollments SET started_at = now() - interval '30 days', created_at = now() - interval '30 days'
        WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, enrollmentId],
    );
    const pause = async (startedAgo: string, releasedAgo: string): Promise<void> => {
      const id = await openHold(worker(), {
        scopeKind: 'firm',
        scopeKey: crm.alpha.firmId,
        reasonCode: 'scoped_pause',
        blockedActionKinds: ['email_send', 'enrollment_advance'],
        sourceEventKind: 'administrative_pause',
      });
      await database.session.query(
        `UPDATE active_holds SET started_at = now() - $2::interval, released_at = now() - $3::interval WHERE id = $1`,
        [id, startedAgo, releasedAgo],
      );
    };
    await pause('20 days', '15 days');
    const first = await resumeEnrollment(worker(), { enrollmentId });
    expect(first.ok && first.value.kind).toBe('resume');
    await database.session.query(
      `UPDATE step_execution_shifts SET shifted_at = now() - interval '10 days'
        WHERE workspace_id = $1 AND enrollment_id = $2`,
      [seeded.alpha.workspaceId, enrollmentId],
    );
    // Five days and then four: nine in the enrollment's life, four in this episode.
    await pause('5 days', '1 day');
    const second = await resumeEnrollment(worker(), { enrollmentId });
    expect(second.ok && second.value.kind).toBe('resume');
  });
});

describe('how long a held step waits before the scheduler asks again', () => {
  it('a step an open hold blocks keeps its not_before, so the pass after the release takes it', async () => {
    const { emailExecutionId } = await enrollMonday();
    await openHold(worker(), {
      scopeKind: 'opportunity',
      scopeKey: crm.alpha.opportunityId,
      reasonCode: 'uncertain_reply',
      blockedActionKinds: ['email_send', 'enrollment_advance'],
      sourceEventKind: 'mail_message',
    });
    const held = await runDueStepExecution(worker(), {
      stepExecutionId: emailExecutionId,
      now: MONDAY_NINE,
      eligibility: {
        evaluate: async () => await Promise.resolve({ ok: false as const, reasonCode: 'uncertain_reply' as const }),
      },
      sendHandoff: recordingSendHandoff(),
    });
    expect(held.kind === 'held' && held.reasonCode).toBe('uncertain_reply');
    expect((await executionRow(emailExecutionId)).not_before.toISOString()).toBe(MONDAY_NINE);
  });

  it('a step no hold row explains waits out its recheck', async () => {
    const { emailExecutionId } = await enrollMonday();
    const before = Date.parse(await databaseNow(worker()));
    const held = await runDueStepExecution(worker(), {
      stepExecutionId: emailExecutionId,
      now: MONDAY_NINE,
      eligibility: {
        evaluate: async () => await Promise.resolve({ ok: false as const, reasonCode: 'route_missing' as const }),
      },
      sendHandoff: recordingSendHandoff(),
    });
    expect(held.kind === 'held' && held.reasonCode).toBe('route_missing');
    const waited = (await executionRow(emailExecutionId)).not_before.getTime() - before;
    expect(waited).toBeGreaterThanOrEqual(DEFAULT_HOLD_RECHECK_MILLISECONDS - 1000);
  });
});
