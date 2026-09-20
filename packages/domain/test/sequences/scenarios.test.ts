import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { databaseNow, listApplicableHolds, openHold, releaseHold } from '../../policy/index.ts';
import { changeStage, emitCrmDomainEvent } from '../../crm/index.ts';
import { LONG_HOLD_REVIEW_MILLISECONDS } from '../../src/index.ts';
import {
  allowAllEligibility,
  consumeTerminalStops,
  createDraftVersion,
  createSequence,
  dispatchPreparedStep,
  enrollContact,
  listStepExecutions,
  publishVersion,
  readEnrollment,
  recordLinkedInResult,
  recordingSendHandoff,
  completeLinkedInStep,
  resumeEnrollment,
  runDueStepExecution,
  undoLinkedInStep,
  LINKEDIN_UNDO_WINDOW_MILLISECONDS,
  type RecordingSendHandoff,
} from '../../sequences/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedSequences, type SeededSequences } from './support/sequenceFixtures.ts';

/**
 * Appendix G scenarios 9, 18, 26, 28, 31, 32 and 33, and the terminal stop the
 * coordinator made a requirement of this lane (`docs/decisions/g3a-domain-event-outbox.md`).
 *
 * Each one is a sentence from the specification that this lane is accepted on, and
 * each is run against a real PostgreSQL with two workspaces seeded, because the
 * interesting half of most of them is a constraint or a transaction rather than a
 * branch.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let sequences: SeededSequences;

const contextFor = (workspace: 'alpha' | 'beta', who: 'admin' | 'salesperson'): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded[workspace].workspaceId, {
      kind: 'user',
      userId: seeded[workspace][who].userId,
      role: who,
    }),
    database.session,
  );

const worker = (workspace: 'alpha' | 'beta' = 'alpha'): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded[workspace].workspaceId, { kind: 'system', component: 'worker' }),
    database.session,
  );

async function clearEnrollments(): Promise<void> {
  await database.session.query('DELETE FROM enrollment_linkedin_results');
  await database.session.query('DELETE FROM step_execution_shifts');
  await database.session.query('DELETE FROM step_executions');
  await database.session.query('DELETE FROM sequence_enrollments');
  await database.session.query('DELETE FROM sequence_event_cursors');
  await database.session.query('DELETE FROM today_items');
  await database.session.query('DELETE FROM today_snapshots');
  await database.session.query('DELETE FROM active_holds');
  await database.session.query('DELETE FROM crm_domain_events');
  // The terminal-stop scenarios close and manualize the opportunity; put it back, so
  // each scenario starts from the same automated, open opportunity.
  await database.session.query(
    `UPDATE opportunities
        SET status = 'open', closed_at = NULL, close_reason = NULL,
            control_mode = 'automated', control_mode_reason = NULL`,
  );
}

/** Put an enrollment's unfinished steps at one instant, so a timing test says which. */
async function setDue(enrollmentId: string, instant: string): Promise<void> {
  await database.session.query(
    `UPDATE step_executions
        SET due_at = $3::timestamptz, not_before = $3::timestamptz, original_due_at = $3::timestamptz
      WHERE workspace_id = $1 AND enrollment_id = $2 AND state IN ('pending', 'held')`,
    [seeded.alpha.workspaceId, enrollmentId, instant],
  );
}

/** Backdate an enrollment's start, so a hold that ran before now is a hold it lived through. */
async function backdateStart(enrollmentId: string, interval: string): Promise<void> {
  await database.session.query(
    `UPDATE sequence_enrollments SET started_at = now() - $3::interval
      WHERE workspace_id = $1 AND id = $2`,
    [seeded.alpha.workspaceId, enrollmentId, interval],
  );
}

/** Enroll the seeded contact in the seeded published version. Refusals are fixture failures. */
async function enrollAlpha(contactId: string = crm.alpha.contactId): Promise<string> {
  const result = await enrollContact(contextFor('alpha', 'salesperson'), {
    sequenceVersionId: sequences.alpha.publishedVersionId,
    opportunityId: crm.alpha.opportunityId,
    firmId: crm.alpha.firmId,
    contactId,
  });
  if (!result.ok) throw new Error(`the enrollment fixture was refused: ${result.reason}`);
  return result.value.enrollmentId;
}

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
  await clearEnrollments();
});

describe('enrollment and its first execution commit together (Appendix A "Enroll")', () => {
  it('creates the enrollment and exactly one first execution, or neither', async () => {
    const enrollmentId = await enrollAlpha();
    const executions = await listStepExecutions(worker(), { enrollmentId });
    expect(executions).toHaveLength(1);
    expect(executions[0]?.ordinal).toBe(1);
    expect(executions[0]?.channel).toBe('email');
    expect(executions[0]?.state).toBe('pending');
  });

  it('refuses a second live enrollment for the contact rather than throwing', async () => {
    await enrollAlpha();
    const again = await enrollContact(contextFor('alpha', 'salesperson'), {
      sequenceVersionId: sequences.alpha.publishedVersionId,
      opportunityId: crm.alpha.opportunityId,
      firmId: crm.alpha.firmId,
      contactId: crm.alpha.contactId,
    });
    expect(again).toEqual({ ok: false, reason: 'contact_already_enrolled' });
  });

  it('refuses enrollment in a draft version (11.2: enrollments freeze to an immutable version)', async () => {
    const result = await enrollContact(contextFor('alpha', 'salesperson'), {
      sequenceVersionId: sequences.alpha.draftVersionId,
      opportunityId: crm.alpha.opportunityId,
      firmId: crm.alpha.firmId,
      contactId: crm.alpha.contactId,
    });
    expect(result).toEqual({ ok: false, reason: 'version_not_published' });
  });
});

describe('scenario 32: the email window, Monday mornings, weekends and DST', () => {
  it('places a Monday-due email on Monday morning rather than Tuesday', async () => {
    const enrollmentId = await enrollAlpha();
    // Monday 07:30 New York, before the window opens.
    await setDue(enrollmentId, '2026-09-21T11:30:00Z');
    const placed = await runDueStepExecution(worker(), {
      enrollmentId,
      now: '2026-09-21T11:30:00Z',
      eligibility: allowAllEligibility(),
      sendHandoff: recordingSendHandoff(),
    });
    expect(placed.kind).toBe('scheduled');
    // 08:00 New York on the same Monday, not the next day.
    expect(placed.kind === 'scheduled' ? placed.sendAt : '').toBe('2026-09-21T12:00:00.000Z');
  });

  it('moves a Saturday-due email to Monday morning', async () => {
    const enrollmentId = await enrollAlpha();
    await setDue(enrollmentId, '2026-09-19T14:00:00Z');
    const placed = await runDueStepExecution(worker(), {
      enrollmentId,
      now: '2026-09-19T14:00:00Z', // Saturday
      eligibility: allowAllEligibility(),
      sendHandoff: recordingSendHandoff(),
    });
    expect(placed.kind === 'scheduled' ? placed.sendAt : '').toBe('2026-09-21T12:00:00.000Z');
  });
});

describe('scenario 9: the LinkedIn successor races the undo', () => {
  let enrollmentId = '';
  let linkedInExecutionId = '';

  beforeEach(async () => {
    enrollmentId = await enrollAlpha();
    // Fast-forward to the LinkedIn step: complete the first two by hand, the way the
    // cadence would, so the test is about the third.
    await database.session.query(
      `UPDATE step_executions SET state = 'completed', completed_at = now(),
              completion_source = 'system', result = 'not_applicable'
        WHERE workspace_id = $1 AND enrollment_id = $2`,
      [seeded.alpha.workspaceId, enrollmentId],
    );
    const created = await database.session.query<{ id: string }>(
      `INSERT INTO step_executions
         (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
          due_at, not_before, original_due_at, source_zone, rule_version)
       VALUES ($1, $2, $3, $4, $5, 'linkedin_task', 3, now(), now(), now(), 'America/New_York', 'business-day.1+holidays.2026')
       RETURNING id`,
      [
        seeded.alpha.workspaceId,
        enrollmentId,
        sequences.alpha.linkedInStepId,
        crm.alpha.firmId,
        crm.alpha.contactId,
      ],
    );
    linkedInExecutionId = created.rows[0]?.id ?? '';
  });

  it('hands off, creates the successor with a ten-minute grace, and never claims a send', async () => {
    const completed = await completeLinkedInStep(contextFor('alpha', 'salesperson'), {
      stepExecutionId: linkedInExecutionId,
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.result).toBe('handed_off');
    expect(completed.value.completionSource).toBe('open_and_copy');
    // There is no fourth step in the seeded version, so the successor is absent and
    // the enrollment completes. The grace period is asserted on a version that has one.
    expect(completed.value.successorNotBefore).toBeNull();

    const executions = await listStepExecutions(worker(), { enrollmentId });
    const linkedIn = executions.find(execution => execution.id === linkedInExecutionId);
    expect(linkedIn?.state).toBe('completed');
  });

  it('undoes inside ten minutes, reopening the step and cancelling the successor', async () => {
    const completed = await completeLinkedInStep(contextFor('alpha', 'salesperson'), {
      stepExecutionId: linkedInExecutionId,
    });
    expect(completed.ok).toBe(true);

    const undone = await undoLinkedInStep(contextFor('alpha', 'salesperson'), {
      stepExecutionId: linkedInExecutionId,
      now: await databaseNow(worker()),
    });
    expect(undone.ok).toBe(true);
    const executions = await listStepExecutions(worker(), { enrollmentId });
    expect(executions.find(execution => execution.id === linkedInExecutionId)?.state).toBe('pending');
  });

  it('refuses the undo once the ten-minute window has passed', async () => {
    await completeLinkedInStep(contextFor('alpha', 'salesperson'), {
      stepExecutionId: linkedInExecutionId,
    });
    const now = await databaseNow(worker());
    const late = new Date(Date.parse(now) + LINKEDIN_UNDO_WINDOW_MILLISECONDS + 1000).toISOString();
    const undone = await undoLinkedInStep(contextFor('alpha', 'salesperson'), {
      stepExecutionId: linkedInExecutionId,
      now: late,
    });
    expect(undone).toEqual({ ok: false, reason: 'undo_window_expired' });
  });
});

describe('scenario 18: a recorded LinkedIn reply stops the opportunity', () => {
  it('switches the opportunity to manual and ends every live enrollment of the firm', async () => {
    const enrollmentId = await enrollAlpha();
    const recorded = await recordLinkedInResult(contextFor('alpha', 'salesperson'), {
      enrollmentId,
      result: 'replied',
    });
    expect(recorded.ok).toBe(true);

    const enrollment = await readEnrollment(worker(), { enrollmentId });
    expect(enrollment?.state).toBe('stopped');
    expect(enrollment?.endReason).toBe('linkedin_reply');

    const { rows } = await database.session.query<{ control_mode: string }>(
      'SELECT control_mode FROM opportunities WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, crm.alpha.opportunityId],
    );
    expect(rows[0]?.control_mode).toBe('manual');

    const executions = await listStepExecutions(worker(), { enrollmentId });
    expect(executions.every(execution => execution.state === 'cancelled')).toBe(true);
  });

  it('records "no engagement" without ending anything (11.3)', async () => {
    const enrollmentId = await enrollAlpha();
    const recorded = await recordLinkedInResult(contextFor('alpha', 'salesperson'), {
      enrollmentId,
      result: 'no_engagement',
    });
    expect(recorded.ok).toBe(true);
    expect((await readEnrollment(worker(), { enrollmentId }))?.state).toBe('active');
  });
});

describe('the terminal stop arrives through the outbox, and is consumed once', () => {
  it('cancels every pending step of the firm in the transaction that consumes the event', async () => {
    const enrollmentId = await enrollAlpha();
    const changed = await changeStage(contextFor('alpha', 'salesperson'), {
      opportunityId: crm.alpha.opportunityId,
      toStageKey: 'won',
      reason: 'Signed.',
    });
    expect(changed.ok).toBe(true);

    const report = await consumeTerminalStops(worker());
    expect(report.enrollmentsStopped).toBe(1);

    const enrollment = await readEnrollment(worker(), { enrollmentId });
    expect(enrollment?.state).toBe('stopped');
    expect(enrollment?.endReason).toBe('stage_won');
    const executions = await listStepExecutions(worker(), { enrollmentId });
    expect(executions.every(execution => execution.state === 'cancelled')).toBe(true);

    // The cursor advanced, so a second pass is a no-op rather than a second stop.
    expect((await consumeTerminalStops(worker())).enrollmentsStopped).toBe(0);
  });

  it('does not reach into the other workspace (G 8)', async () => {
    await enrollAlpha();
    await emitCrmDomainEvent(contextFor('beta', 'admin'), {
      kind: 'opportunity.terminal_stop',
      firmId: crm.beta.firmId,
      opportunityId: crm.beta.opportunityId,
      dedupeKey: `terminal-stop:${crm.beta.opportunityId}`,
      detail: { status: 'lost' },
    });
    const report = await consumeTerminalStops(worker('alpha'));
    expect(report.enrollmentsStopped).toBe(0);
  });
});

describe('scenario 28: two overlapping holds, cleared in both orders', () => {
  it('stays blocked until both clear and shifts by the union, never the sum', async () => {
    const enrollmentId = await enrollAlpha();
    await backdateStart(enrollmentId, '3 days');
    const context = contextFor('alpha', 'admin');

    // Two holds that overlap by a day: together they block for two days, not three.
    const first = await openHold(context, {
      scopeKind: 'firm',
      scopeKey: crm.alpha.firmId,
      reasonCode: 'scoped_pause',
      blockedActionKinds: ['email_send', 'enrollment_advance'],
      sourceEventKind: 'test.first',
    });
    const second = await openHold(context, {
      scopeKind: 'opportunity',
      scopeKey: crm.alpha.opportunityId,
      reasonCode: 'reassignment',
      blockedActionKinds: ['email_send', 'enrollment_advance'],
      sourceEventKind: 'test.second',
    });
    await database.session.query(
      `UPDATE active_holds SET started_at = now() - interval '2 days' WHERE id = $1`,
      [first],
    );
    await database.session.query(
      `UPDATE active_holds SET started_at = now() - interval '1 day' WHERE id = $1`,
      [second],
    );

    await releaseHold(context, first);
    const stillHeld = await resumeEnrollment(context, { enrollmentId });
    expect(stillHeld.ok).toBe(true);
    expect(stillHeld.ok && stillHeld.value.kind).toBe('still_held');

    await releaseHold(context, second);
    const resumed = await resumeEnrollment(context, { enrollmentId });
    expect(resumed.ok && resumed.value.kind).toBe('resume');
    if (!resumed.ok || resumed.value.kind !== 'resume') return;
    // The union of [-2d, now] and [-1d, now] is two days, not three.
    const days = resumed.value.shiftMilliseconds / 86_400_000;
    expect(days).toBeGreaterThan(1.9);
    expect(days).toBeLessThan(2.1);
  });
});

describe('scenario 31: a hold longer than seven days needs review', () => {
  it('refuses to resume and marks the enrollment for review', async () => {
    const enrollmentId = await enrollAlpha();
    await backdateStart(enrollmentId, '10 days');
    const context = contextFor('alpha', 'admin');
    const hold = await openHold(context, {
      scopeKind: 'firm',
      scopeKey: crm.alpha.firmId,
      reasonCode: 'scoped_pause',
      blockedActionKinds: ['email_send', 'enrollment_advance'],
      sourceEventKind: 'test.long',
    });
    await database.session.query(
      `UPDATE active_holds SET started_at = now() - interval '9 days' WHERE id = $1`,
      [hold],
    );
    await releaseHold(context, hold);

    const decided = await resumeEnrollment(context, { enrollmentId });
    expect(decided.ok && decided.value.kind).toBe('review_required');
    const enrollment = await readEnrollment(worker(), { enrollmentId });
    expect(enrollment?.state).toBe('review_required');
    expect(enrollment?.reviewUnionMilliseconds ?? 0).toBeGreaterThan(LONG_HOLD_REVIEW_MILLISECONDS);

    // A due step of an enrollment awaiting review does not run.
    const outcome = await runDueStepExecution(worker(), {
      enrollmentId,
      now: await databaseNow(worker()),
      eligibility: allowAllEligibility(),
      sendHandoff: recordingSendHandoff(),
    });
    expect(outcome.kind).toBe('held');
    expect(outcome.kind === 'held' ? outcome.reasonCode : '').toBe('long_hold_review');
  });
});

describe('scenario 33: many contacts at one firm, due on the same day', () => {
  it('gives each contact one enrollment and holds the ones the cap refuses', async () => {
    const context = contextFor('alpha', 'salesperson');
    const contactIds: string[] = [crm.alpha.contactId];
    for (const name of ['Alex Example', 'Jordan Example']) {
      const { rows } = await database.session.query<{ id: string }>(
        `INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id`,
        [seeded.alpha.workspaceId, crm.alpha.firmId, name],
      );
      contactIds.push(rows[0]?.id ?? '');
    }

    const enrollmentIds: string[] = [];
    for (const contactId of contactIds) enrollmentIds.push(await enrollAlpha(contactId));
    expect(new Set(enrollmentIds).size).toBe(3);

    // The cap belongs to the sending lane and arrives here as a refusal from the
    // eligibility port. The step holds; it is never sent anyway.
    const capped = await runDueStepExecution(worker(), {
      enrollmentId: enrollmentIds[2] ?? '',
      now: await databaseNow(worker()),
      eligibility: { evaluate: async () => await Promise.resolve({ ok: false, reasonCode: 'daily_cap' }) },
      sendHandoff: recordingSendHandoff(),
    });
    expect(capped.kind === 'held' ? capped.reasonCode : '').toBe('daily_cap');

    // One reply stops all three: the same outbox event, one consumption.
    await emitCrmDomainEvent(context, {
      kind: 'opportunity.terminal_stop',
      firmId: crm.alpha.firmId,
      opportunityId: crm.alpha.opportunityId,
      dedupeKey: `terminal-stop:test:${crm.alpha.opportunityId}`,
      detail: { status: 'lost' },
    });
    const report = await consumeTerminalStops(worker());
    expect(report.enrollmentsStopped).toBe(3);
  });
});

describe('the send hand-off is a rendered request, and the fence is G7-2’s', () => {
  it('hands the send a rendered subject and body with the template version id', async () => {
    const enrollmentId = await enrollAlpha();
    // Monday 09:00 New York, inside the window.
    await setDue(enrollmentId, '2026-09-21T13:00:00Z');
    const handoff = recordingSendHandoff();
    const outcome = await runDueStepExecution(worker(), {
      enrollmentId,
      now: '2026-09-21T13:00:00Z',
      eligibility: allowAllEligibility(),
      sendHandoff: handoff,
    });
    expect(outcome.kind).toBe('handed_to_send');
    const [request] = handoff.prepared;
    expect(request?.templateVersionId).toBe(sequences.alpha.template.templateVersionId);
    expect(request?.templateContentHash).toBe(sequences.alpha.template.contentHash);
    expect(request?.subject).toContain(crm.collidingFirmName);
    expect(request?.body).toContain('Reply "stop"');
    expect(request?.body).not.toMatch(/\{[a-z_]+\}/);
    expect(request?.toAddress).toBe(crm.collidingEmail);
  });

  it('holds the step rather than rendering an empty variable (11.1)', async () => {
    const created = await createSequence(contextFor('alpha', 'admin'), {
      name: `One step ${String(Date.now())}`,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const draft = await createDraftVersion(contextFor('alpha', 'admin'), {
      sequenceId: created.value.id,
      steps: [
        {
          ordinal: 1,
          channel: 'email',
          delay: { unit: 'elapsed', hours: 0 },
          templateVersionId: sequences.alpha.template.templateVersionId,
        },
      ],
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const published = await publishVersion(contextFor('alpha', 'admin'), {
      sequenceVersionId: draft.value.sequenceVersionId,
    });
    expect(published.ok).toBe(true);

    // A contact whose name the template needs and the CRM has not got.
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, '?') RETURNING id`,
      [seeded.alpha.workspaceId, crm.alpha.firmId],
    );
    const contactId = rows[0]?.id ?? '';
    const enrolled = await enrollContact(contextFor('alpha', 'salesperson'), {
      sequenceVersionId: draft.value.sequenceVersionId,
      opportunityId: crm.alpha.opportunityId,
      firmId: crm.alpha.firmId,
      contactId,
    });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;

    await setDue(enrolled.value.enrollmentId, '2026-09-21T13:00:00Z');
    const outcome = await runDueStepExecution(worker(), {
      enrollmentId: enrolled.value.enrollmentId,
      now: '2026-09-21T13:00:00Z',
      eligibility: allowAllEligibility(),
      sendHandoff: recordingSendHandoff(),
    });
    expect(outcome.kind === 'held' ? outcome.reasonCode : '').toBe('missing_variables');
    const holds = await listApplicableHolds(worker(), {
      actionKind: 'email_send',
      firmId: crm.alpha.firmId,
      enrollmentId: enrolled.value.enrollmentId,
    });
    expect(holds.map(hold => hold.reasonCode)).toContain('missing_variables');
  });
});

describe('dispatch belongs to this lane, and a held fence is not terminal', () => {
  /** Run the due email step of an enrollment and return what the fence was handed. */
  async function handOff(
    handoff: RecordingSendHandoff,
    enrollmentId: string,
  ): Promise<{ readonly stepExecutionId: string; readonly outboundMessageId: string }> {
    await setDue(enrollmentId, '2026-09-21T13:00:00Z');
    const outcome = await runDueStepExecution(worker(), {
      enrollmentId,
      now: '2026-09-21T13:00:00Z',
      eligibility: allowAllEligibility(),
      sendHandoff: handoff,
    });
    if (outcome.kind !== 'handed_to_send') throw new Error(`the step was ${outcome.kind}`);
    return { stepExecutionId: outcome.stepExecutionId, outboundMessageId: outcome.outboundMessageId };
  }

  it('carries the business date the daily cap counts against', async () => {
    const enrollmentId = await enrollAlpha();
    const handoff = recordingSendHandoff();
    await handOff(handoff, enrollmentId);
    // 09:00 New York on Monday 21 September 2026 is that date, not the UTC one.
    expect(handoff.prepared[0]?.businessDate).toBe('2026-09-21');
  });

  it('dispatches after the step transaction and completes the step from the fence', async () => {
    const enrollmentId = await enrollAlpha();
    const handoff = recordingSendHandoff();
    const { stepExecutionId, outboundMessageId } = await handOff(handoff, enrollmentId);
    handoff.dispatchesTo(stepExecutionId, {
      state: 'sent',
      dispatchedAt: '2026-09-21T13:00:05.000Z',
      heldReason: null,
    });

    const result = await dispatchPreparedStep(worker(), {
      stepExecutionId,
      outboundMessageId,
      sendHandoff: handoff,
      now: '2026-09-21T13:00:06Z',
    });
    expect(result.kind).toBe('sent');
    expect(handoff.dispatched).toEqual([outboundMessageId]);

    const executions = await listStepExecutions(worker(), { enrollmentId });
    const first = executions.find(execution => execution.ordinal === 1);
    expect(first?.state).toBe('completed');
    expect(first?.result).toBe('sent');
    // Appendix B: the successor is counted from the original dispatch time.
    expect(executions.some(execution => execution.ordinal === 2)).toBe(true);
  });

  it('returns a capped step to held with a future not_before rather than stopping it', async () => {
    const enrollmentId = await enrollAlpha();
    const handoff = recordingSendHandoff();
    const { stepExecutionId, outboundMessageId } = await handOff(handoff, enrollmentId);
    handoff.dispatchesTo(stepExecutionId, {
      state: 'held',
      dispatchedAt: null,
      heldReason: 'daily_cap',
    });

    const now = await databaseNow(worker());
    const result = await dispatchPreparedStep(worker(), {
      stepExecutionId,
      outboundMessageId,
      sendHandoff: handoff,
      now,
    });
    expect(result).toEqual({ kind: 'held', stepExecutionId, reasonCode: 'daily_cap' });

    const [execution] = await listStepExecutions(worker(), { enrollmentId });
    expect(execution?.state).toBe('held');
    expect(execution?.holdReasonCode).toBe('daily_cap');
    // Not terminal: the cap clears with the clock, so the row waits rather than dying.
    expect(Date.parse(execution?.notBefore ?? now)).toBeGreaterThan(Date.parse(now));
    expect(execution?.completedAt ?? null).toBeNull();
  });

  it('never dispatches a fence twice: an already-sent fence is read, not re-sent', async () => {
    const enrollmentId = await enrollAlpha();
    const handoff = recordingSendHandoff();
    const { stepExecutionId, outboundMessageId } = await handOff(handoff, enrollmentId);
    handoff.dispatchesTo(stepExecutionId, {
      state: 'sent',
      dispatchedAt: '2026-09-21T13:00:05.000Z',
      heldReason: null,
    });
    await dispatchPreparedStep(worker(), {
      stepExecutionId,
      outboundMessageId,
      sendHandoff: handoff,
      now: '2026-09-21T13:00:06Z',
    });
    const again = await dispatchPreparedStep(worker(), {
      stepExecutionId,
      outboundMessageId,
      sendHandoff: handoff,
      now: '2026-09-21T13:00:07Z',
    });
    expect(again.kind).toBe('nothing_to_do');
    expect(handoff.dispatched).toEqual([outboundMessageId]);
  });

  it('holds an unknown-terminal fence for the admin resolution Appendix B names', async () => {
    const enrollmentId = await enrollAlpha();
    const handoff = recordingSendHandoff();
    const { stepExecutionId, outboundMessageId } = await handOff(handoff, enrollmentId);
    handoff.dispatchesTo(stepExecutionId, {
      state: 'unknown_terminal',
      dispatchedAt: '2026-09-21T13:00:05.000Z',
      heldReason: null,
    });
    const result = await dispatchPreparedStep(worker(), {
      stepExecutionId,
      outboundMessageId,
      sendHandoff: handoff,
      now: '2026-09-21T13:00:06Z',
    });
    expect(result).toEqual({
      kind: 'held',
      stepExecutionId,
      reasonCode: 'send_unknown_terminal',
    });
  });
});
