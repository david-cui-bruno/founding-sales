import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { emitCrmDomainEvent } from '../../crm/index.ts';
import { databaseNow, listApplicableHolds, listPauses } from '../../policy/index.ts';
import { buildTodaySnapshot, businessDateOf, listTodayItems } from '../../today/index.ts';
import {
  allowAllEligibility,
  consumeTerminalStops,
  createDraftVersion,
  dueSequenceWorkSource,
  enrollContact,
  listSequenceVersions,
  listStepExecutions,
  previewResume,
  proposeEnrollmentMigration,
  publishVersion,
  readEnrollment,
  readSequenceVersion,
  recordingSendHandoff,
  resumeAfterReview,
  runDueStepExecution,
  sequenceVersionForDisplay,
} from '../../sequences/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedSequences, type SeededSequences } from './support/sequenceFixtures.ts';

/**
 * LinkedIn was removed on 25 September 2026, and the schema was not (Appendix G 9 and
 * 18 were its scenarios; `test/release/scenario09.check.ts` and `scenario18.check.ts`).
 *
 * Migrations 0001, 0004, 0008 and 0012 still admit every LinkedIn value: a
 * `linkedin_task` step or execution, a `linkedin_due` Today item, `linkedin_task` in a
 * hold's blocked kinds, a `linkedin` channel pause, and `linkedin_reply`, `open_and_copy`
 * and `handed_off` on a sequence row — and `linkedin_reply` is in every version's
 * `stop_conditions`, because the column's default puts it there and a CHECK requires it.
 * Each case below writes the stored value with SQL, the only way left to write one, and
 * asserts that the code treats it as unknown: held and never run, not listed, refused,
 * or dropped on read.
 *
 * ## The vacuous-pass trap
 *
 * A reader that drops a value nobody stored passes by construction. Every case that
 * asserts an absence first reads the raw row and asserts the LinkedIn value is really
 * there.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let sequences: SeededSequences;
let linkedInVersionId = '';
let linkedInDraftId = '';
let linkedInStepId = '';
let linkedInSequenceId = '';
/** A second sequence whose only version is a published LinkedIn one, so it has no draft yet. */
let publishedOnlySequenceId = '';
/** Lane A2: a published version of a LinkedIn task and then a call, and its two step ids. */
let mixedSequenceId = '';
let mixedVersionId = '';
let mixedLinkedInStepId = '';
let mixedCallStepId = '';

const contextFor = (who: 'admin' | 'salesperson'): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha[who].userId, role: who }),
    database.session,
  );

const worker = (): RepositoryContext =>
  repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), database.session);

async function one(sql: string, values: readonly unknown[]): Promise<string> {
  const { rows } = await database.session.query<{ id: string }>(sql, [...values]);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`the fixture insert returned no row: ${sql.slice(0, 60)}`);
  return id;
}

/** A published version of one LinkedIn step, as it was stored before 25 September 2026. */
async function publishedLinkedInVersion(sequenceId: string): Promise<{ readonly versionId: string; readonly stepId: string }> {
  const workspaceId = seeded.alpha.workspaceId;
  const versionId = await one(
    'INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 1) RETURNING id',
    [workspaceId, sequenceId],
  );
  const stepId = await one(
    `INSERT INTO sequence_steps
       (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, linkedin_message)
     VALUES ($1, $2, 1, 'linkedin_task', 'elapsed', 0, 'Hello — a note from before.') RETURNING id`,
    [workspaceId, versionId],
  );
  await database.session.query(
    `UPDATE sequence_versions SET state = 'published', published_at = now(), published_by_user_id = $3
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, versionId, seeded.alpha.admin.userId],
  );
  return { versionId, stepId };
}

/**
 * Two sequences stored before 25 September 2026. The first has version 1 published and
 * version 2 a draft, each one LinkedIn step; the second has only its published version.
 */
async function seedLinkedInSequences(): Promise<void> {
  const workspaceId = seeded.alpha.workspaceId;
  linkedInSequenceId = await one(
    'INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id',
    [workspaceId, 'LinkedIn first', seeded.alpha.admin.userId],
  );
  const published = await publishedLinkedInVersion(linkedInSequenceId);
  linkedInVersionId = published.versionId;
  linkedInStepId = published.stepId;
  linkedInDraftId = await one(
    'INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 2) RETURNING id',
    [workspaceId, linkedInSequenceId],
  );
  await database.session.query(
    `INSERT INTO sequence_steps
       (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, linkedin_message)
     VALUES ($1, $2, 1, 'linkedin_task', 'elapsed', 0, 'Hello — a note from before.')`,
    [workspaceId, linkedInDraftId],
  );

  publishedOnlySequenceId = await one(
    'INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id',
    [workspaceId, 'LinkedIn only', seeded.alpha.admin.userId],
  );
  await publishedLinkedInVersion(publishedOnlySequenceId);

  mixedSequenceId = await one(
    'INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id',
    [workspaceId, 'LinkedIn then a call', seeded.alpha.admin.userId],
  );
  mixedVersionId = await one(
    'INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 1) RETURNING id',
    [workspaceId, mixedSequenceId],
  );
  mixedLinkedInStepId = await one(
    `INSERT INTO sequence_steps
       (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, linkedin_message)
     VALUES ($1, $2, 1, 'linkedin_task', 'elapsed', 0, 'Hello — a note from before.') RETURNING id`,
    [workspaceId, mixedVersionId],
  );
  mixedCallStepId = await one(
    `INSERT INTO sequence_steps
       (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, on_no_answer)
     VALUES ($1, $2, 2, 'call_task', 'business_days', 2, 'advance') RETURNING id`,
    [workspaceId, mixedVersionId],
  );
  await database.session.query(
    `UPDATE sequence_versions SET state = 'published', published_at = now(), published_by_user_id = $3
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, mixedVersionId, seeded.alpha.admin.userId],
  );
}

/** A live enrollment in the stored LinkedIn version, and its due LinkedIn execution. */
async function storedLinkedInExecution(): Promise<{ readonly enrollmentId: string; readonly executionId: string }> {
  const workspaceId = seeded.alpha.workspaceId;
  const enrollmentId = await one(
    `INSERT INTO sequence_enrollments
       (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
        started_at, firm_time_zone, holiday_calendar_version)
     VALUES ($1, $2, $3, $4, $5, $6, now() - interval '1 hour', 'America/New_York', $7)
     RETURNING id`,
    [
      workspaceId,
      linkedInVersionId,
      crm.alpha.opportunityId,
      crm.alpha.firmId,
      crm.alpha.contactId,
      seeded.alpha.salesperson.userId,
      sequences.alpha.calendarVersion,
    ],
  );
  const executionId = await one(
    `INSERT INTO step_executions
       (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
        due_at, not_before, original_due_at, source_zone, rule_version)
     VALUES ($1, $2, $3, $4, $5, 'linkedin_task', 1, now() - interval '1 minute', now() - interval '1 minute',
             now() - interval '1 minute', 'America/New_York', 'elapsed.1')
     RETURNING id`,
    [workspaceId, enrollmentId, linkedInStepId, crm.alpha.firmId, crm.alpha.contactId],
  );
  return { enrollmentId, executionId };
}

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  sequences = await seedSequences(database.session, seeded);
  await seedLinkedInSequences();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  for (const table of [
    'enrollment_migration_items',
    'enrollment_migrations',
    'step_execution_shifts',
    'step_executions',
    'sequence_enrollments',
    'sequence_event_cursors',
    'today_items',
    'today_snapshots',
    'administrative_pauses',
    'active_holds',
    'crm_domain_events',
  ]) {
    await database.session.query(`DELETE FROM ${table}`);
  }
  await database.session.query(
    `UPDATE opportunities
        SET status = 'open', closed_at = NULL, close_reason = NULL,
            control_mode = 'automated', control_mode_reason = NULL`,
  );
});

describe('a stored LinkedIn step is held and never run', () => {
  it('holds it for a person, prepares no send and never treats it as a task', async () => {
    const { executionId } = await storedLinkedInExecution();
    const handoff = recordingSendHandoff();
    const now = await databaseNow(worker());

    const first = await runDueStepExecution(worker(), {
      stepExecutionId: executionId,
      now,
      eligibility: allowAllEligibility(),
      sendHandoff: handoff,
    });
    expect(first).toEqual({ kind: 'held', stepExecutionId: executionId, reasonCode: 'long_hold_review' });

    // Asked again after its recheck, it is held again: nothing turns it into work.
    const later = new Date(Date.parse(now) + 2 * 60 * 60 * 1000).toISOString();
    const again = await runDueStepExecution(worker(), {
      stepExecutionId: executionId,
      now: later,
      eligibility: allowAllEligibility(),
      sendHandoff: handoff,
    });
    expect(again).toEqual({ kind: 'held', stepExecutionId: executionId, reasonCode: 'long_hold_review' });
    expect(handoff.prepared).toEqual([]);

    const { rows } = await database.session.query<{ channel: string; state: string; hold_reason_code: string | null }>(
      'SELECT channel, state, hold_reason_code FROM step_executions WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, executionId],
    );
    expect(rows[0]).toEqual({ channel: 'linkedin_task', state: 'held', hold_reason_code: 'long_hold_review' });
  });

  it('is not on Today, and a rebuild cancels the item an earlier build made for it', async () => {
    const { executionId } = await storedLinkedInExecution();
    const now = await databaseNow(worker());
    const businessDate = await businessDateOf(worker(), now);
    await database.session.query(
      `SELECT today_upsert_item($1, $2::date, $3, $4, 'linkedin_due', $5::timestamptz, $6, 'step_execution', $7, false)`,
      [
        seeded.alpha.workspaceId,
        businessDate,
        crm.alpha.firmId,
        `step-execution:${executionId}`,
        now,
        crm.alpha.contactId,
        executionId,
      ],
    );
    const stored = await database.session.query<{ kind: string; status: string }>(
      'SELECT kind, status FROM today_items WHERE workspace_id = $1 AND item_key = $2',
      [seeded.alpha.workspaceId, `step-execution:${executionId}`],
    );
    expect(stored.rows).toEqual([{ kind: 'linkedin_due', status: 'open' }]);

    expect(await listTodayItems(worker(), { businessDate, firmId: crm.alpha.firmId })).toEqual([]);

    const found = await dueSequenceWorkSource().find(worker(), {
      businessDate,
      businessTimeZone: 'America/New_York',
      now,
    });
    expect(found).toEqual([]);

    await buildTodaySnapshot(worker(), { businessDate, now, sources: [dueSequenceWorkSource()] });
    const rebuilt = await database.session.query<{ status: string }>(
      'SELECT status FROM today_items WHERE workspace_id = $1 AND item_key = $2',
      [seeded.alpha.workspaceId, `step-execution:${executionId}`],
    );
    expect(rebuilt.rows).toEqual([{ status: 'cancelled' }]);
  });
});

describe('nothing enrols into, publishes, copies or migrates onto a version with a LinkedIn step', () => {
  it('refuses each of the four', async () => {
    const enrolled = await enrollContact(contextFor('salesperson'), {
      sequenceVersionId: linkedInVersionId,
      opportunityId: crm.alpha.opportunityId,
      firmId: crm.alpha.firmId,
      contactId: crm.alpha.contactId,
    });
    expect(enrolled).toEqual({ ok: false, reason: 'step_unknown' });

    expect(await publishVersion(contextFor('admin'), { sequenceVersionId: linkedInDraftId })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });

    // "Editing a published sequence creates a new draft" copies the newest published
    // version's steps, and a LinkedIn step is not one a draft may carry.
    expect(await createDraftVersion(contextFor('admin'), { sequenceId: publishedOnlySequenceId })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });

    const live = await enrollContact(contextFor('salesperson'), {
      sequenceVersionId: sequences.alpha.publishedVersionId,
      opportunityId: crm.alpha.opportunityId,
      firmId: crm.alpha.firmId,
      contactId: crm.alpha.contactId,
    });
    if (!live.ok) throw new Error(`the enrollment fixture was refused: ${live.reason}`);
    expect(
      await proposeEnrollmentMigration(contextFor('admin'), {
        fromSequenceVersionId: sequences.alpha.publishedVersionId,
        toSequenceVersionId: linkedInVersionId,
        enrollmentIds: [live.value.enrollmentId],
      }),
    ).toEqual({ ok: false, reason: 'step_unknown' });
  });
});

describe('a stored LinkedIn value is dropped on read', () => {
  it('reads a version without the linkedin_reply its column still requires', async () => {
    const { rows } = await database.session.query<{ stop_conditions: string[] }>(
      'SELECT stop_conditions FROM sequence_versions WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, sequences.alpha.publishedVersionId],
    );
    expect(rows[0]?.stop_conditions).toContain('linkedin_reply');

    const version = await readSequenceVersion(worker(), sequences.alpha.publishedVersionId);
    expect(version?.stopConditions).toEqual(['human_reply', 'engaged_call', 'opt_out_or_suppression', 'stage_closed']);
  });

  it('reads a linkedin_reply end, and an open_and_copy handoff, as no value', async () => {
    const { enrollmentId, executionId } = await storedLinkedInExecution();
    await database.session.query(
      `UPDATE step_executions
          SET state = 'completed', completed_at = now(), completion_source = 'open_and_copy', result = 'handed_off'
        WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, executionId],
    );
    await database.session.query(
      `UPDATE sequence_enrollments SET state = 'stopped', ended_at = now(), end_reason = 'linkedin_reply'
        WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, enrollmentId],
    );

    const enrollment = await readEnrollment(worker(), { enrollmentId });
    expect(enrollment?.state).toBe('stopped');
    expect(enrollment?.endReason).toBeNull();
    const [execution] = await listStepExecutions(worker(), { enrollmentId });
    expect(execution).toMatchObject({ state: 'completed', completionSource: null, result: null });
  });

  it('reads a hold without linkedin_task, and lists no linkedin pause', async () => {
    const workspaceId = seeded.alpha.workspaceId;
    await database.session.query(
      `INSERT INTO active_holds
         (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind, recovery_action)
       VALUES ($1, 'opportunity', $2, 'uncertain_reply',
               ARRAY['email_send', 'call_task', 'linkedin_task', 'enrollment_advance']::text[],
               'mail_message', 'confirm_reply')`,
      [workspaceId, crm.alpha.opportunityId],
    );
    const holds = await listApplicableHolds(worker(), { actionKind: 'email_send', opportunityId: crm.alpha.opportunityId });
    expect(holds.map(hold => hold.blockedActionKinds)).toEqual([['email_send', 'call_task', 'enrollment_advance']]);

    const pauseHoldId = await one(
      `INSERT INTO active_holds
         (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind, recovery_action)
       VALUES ($1, 'channel', 'linkedin', 'scoped_pause', ARRAY['linkedin_task']::text[], 'administrative_pause', 'release_pause')
       RETURNING id`,
      [workspaceId],
    );
    await database.session.query(
      `INSERT INTO administrative_pauses
         (workspace_id, scope_kind, scope_key, channel, reason_code, hold_id, created_by_user_id)
       VALUES ($1, 'channel', 'linkedin', 'linkedin', 'scoped_pause', $2, $3)`,
      [workspaceId, pauseHoldId, seeded.alpha.admin.userId],
    );
    const stored = await database.session.query<{ channel: string }>(
      'SELECT channel FROM administrative_pauses WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(stored.rows).toEqual([{ channel: 'linkedin' }]);
    expect(await listPauses(contextFor('admin'))).toEqual([]);
  });
});

describe('a manual-mode event with the removed linkedin_reply origin still stops', () => {
  it('ends the enrollment as human_reply, the reading of every origin nothing knows', async () => {
    const enrolled = await enrollContact(contextFor('salesperson'), {
      sequenceVersionId: sequences.alpha.publishedVersionId,
      opportunityId: crm.alpha.opportunityId,
      firmId: crm.alpha.firmId,
      contactId: crm.alpha.contactId,
    });
    if (!enrolled.ok) throw new Error(`the enrollment fixture was refused: ${enrolled.reason}`);
    await database.session.query(
      `UPDATE opportunities SET control_mode = 'manual', control_mode_reason = 'a LinkedIn reply',
              control_mode_changed_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, crm.alpha.opportunityId],
    );
    await emitCrmDomainEvent(contextFor('admin'), {
      kind: 'opportunity.manual_mode',
      firmId: crm.alpha.firmId,
      opportunityId: crm.alpha.opportunityId,
      dedupeKey: `manual-mode:linkedin:${crm.alpha.opportunityId}`,
      reasonCode: 'opportunity_manual',
      detail: { reason: 'A LinkedIn reply was recorded by the salesperson.', origin: 'linkedin_reply' },
    });

    const report = await consumeTerminalStops(worker());
    expect(report.enrollmentsStopped).toBe(1);
    expect((await readEnrollment(worker(), { enrollmentId: enrolled.value.enrollmentId }))?.endReason).toBe('human_reply');
  });
});

describe('a stored LinkedIn step is shown, read-only, and stays held (lane A2)', () => {
  it('reads a schema-17 version with a LinkedIn step as a removed step, with nothing it carried', async () => {
    // The vacuous-pass trap: the stored row really is a LinkedIn task with its message.
    const { rows } = await database.session.query<{ channel: string; linkedin_message: string | null }>(
      'SELECT channel, linkedin_message FROM sequence_steps WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, mixedLinkedInStepId],
    );
    expect(rows[0]?.channel).toBe('linkedin_task');
    expect(rows[0]?.linkedin_message).not.toBeNull();

    const [version] = (await listSequenceVersions(worker(), mixedSequenceId)).map(sequenceVersionForDisplay);
    expect(version?.id).toBe(mixedVersionId);
    expect(version?.steps).toEqual([
      {
        id: mixedLinkedInStepId,
        sequenceVersionId: mixedVersionId,
        ordinal: 1,
        channel: 'removed',
        removedChannel: 'linkedin',
        delay: { unit: 'elapsed', hours: 0 },
        onNoAnswer: null,
        templateVersionId: null,
      },
      {
        id: mixedCallStepId,
        sequenceVersionId: mixedVersionId,
        ordinal: 2,
        channel: 'call_task',
        delay: { unit: 'business_days', days: 2 },
        onNoAnswer: 'advance',
        templateVersionId: null,
      },
    ]);
    expect(JSON.stringify(version)).not.toContain('a note from before');

    // Every version of the first sequence, the draft included, reads the same way.
    const all = (await listSequenceVersions(worker(), linkedInSequenceId)).map(sequenceVersionForDisplay);
    expect(all.map(entry => entry.steps.map(step => step.channel))).toEqual([['removed'], ['removed']]);

    // The engine's own read is unchanged: it keeps the stored channel `isStepChannel` refuses.
    expect((await readSequenceVersion(worker(), mixedVersionId))?.steps[0]?.channel).toBe('linkedin_task');
  });

  it('reviews a held LinkedIn execution as held for channel_removed, unmoved', async () => {
    const { enrollmentId, executionId } = await storedLinkedInExecution();
    await database.session.query(
      `UPDATE step_executions SET state = 'held', hold_reason_code = 'long_hold_review'
        WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, executionId],
    );
    const preview = await previewResume(contextFor('salesperson'), { enrollmentId });
    if (!preview.ok) throw new Error(`the review was refused: ${preview.reason}`);
    expect(preview.value.steps).toHaveLength(1);
    const [step] = preview.value.steps;
    expect(step).toMatchObject({
      stepExecutionId: executionId,
      ordinal: 1,
      channel: 'removed',
      removedChannel: 'linkedin',
      state: 'held',
      heldReason: 'channel_removed',
    });
    expect(step?.proposedDueAt).toBe(step?.dueAt);
  });

  it('keeps a held LinkedIn execution held on resume, and returns a current one to pending', async () => {
    const workspaceId = seeded.alpha.workspaceId;
    const enrollmentId = await one(
      `INSERT INTO sequence_enrollments
         (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id, state,
          review_union_milliseconds, started_at, firm_time_zone, holiday_calendar_version)
       VALUES ($1, $2, $3, $4, $5, $6, 'review_required', 864000000, now() - interval '12 days',
               'America/New_York', $7)
       RETURNING id`,
      [
        workspaceId,
        mixedVersionId,
        crm.alpha.opportunityId,
        crm.alpha.firmId,
        crm.alpha.contactId,
        seeded.alpha.salesperson.userId,
        sequences.alpha.calendarVersion,
      ],
    );
    const held = async (stepId: string, channel: string, ordinal: number): Promise<string> =>
      await one(
        `INSERT INTO step_executions
           (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal, state, hold_reason_code,
            due_at, not_before, original_due_at, source_zone, rule_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'held', 'long_hold_review',
                 now() - interval '1 day', now() - interval '1 day', now() - interval '1 day',
                 'America/New_York', 'elapsed.1')
         RETURNING id`,
        [workspaceId, enrollmentId, stepId, crm.alpha.firmId, crm.alpha.contactId, channel, ordinal],
      );
    const linkedIn = await held(mixedLinkedInStepId, 'linkedin_task', 1);
    const call = await held(mixedCallStepId, 'call_task', 2);

    const resumed = await resumeAfterReview(contextFor('salesperson'), { enrollmentId });
    expect(resumed).toMatchObject({ ok: true, value: { kind: 'resume' } });

    const { rows } = await database.session.query<{ id: string; state: string; hold_reason_code: string | null }>(
      'SELECT id, state, hold_reason_code FROM step_executions WHERE workspace_id = $1 AND enrollment_id = $2 ORDER BY ordinal',
      [workspaceId, enrollmentId],
    );
    expect(rows).toEqual([
      { id: linkedIn, state: 'held', hold_reason_code: 'long_hold_review' },
      // The same resume did clear the current step, so the LinkedIn one staying held is the rule, not a no-op.
      { id: call, state: 'pending', hold_reason_code: null },
    ]);
  });
});

