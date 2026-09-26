import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { databaseNow } from '../../policy/index.ts';
import {
  allowAllEligibility,
  createDraftVersion,
  enrollContact,
  listSequenceVersions,
  previewResume,
  proposeEnrollmentMigration,
  publishVersion,
  readSequenceVersion,
  recordingSendHandoff,
  resumeAfterReview,
  runDueStepExecution,
  sequenceVersionForDisplay,
  stopEnrollments,
} from '../../sequences/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedSequences, type SeededSequences } from './support/sequenceFixtures.ts';

/**
 * What the code does with a step or an execution whose channel was LinkedIn (lanes A2
 * and D1).
 *
 * LinkedIn was removed on 25 September 2026. Migration 0018 kept one LinkedIn value, a
 * step's and an execution's `linkedin_task` channel, so a published version's steps keep
 * their places and delays; every other LinkedIn value is gone from the schema. On
 * schema 18 the CHECK still admits the marker, so this file writes it with SQL (the
 * only way left to write one) and asserts the reads: a version shows a `removed` step
 * with nothing it carried, the resume review names `channel_removed`, a resume keeps the
 * LinkedIn execution held, "Edit as a new draft" copies a version without it, and
 * nothing enrols into, publishes or runs it.
 */

const FOUR_STOPS = ['human_reply', 'engaged_call', 'opt_out_or_suppression', 'stage_closed'];

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let sequences: SeededSequences;

/** Ids of what `seedLinkedInSteps` stored. */
const ids = {
  linkedInSequenceId: '',
  publishedVersionId: '',
  draftVersionId: '',
  publishedOnlySequenceId: '',
  linkedInStepId: '',
  spareContactId: '',
  heldEnrollmentId: '',
  heldExecutionId: '',
  mixedSequenceId: '',
  mixedVersionId: '',
  mixedLinkedInStepId: '',
  mixedCallStepId: '',
};

const workspaceOf = (): string => seeded.alpha.workspaceId;

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

async function publish(versionId: string): Promise<void> {
  await database.session.query(
    `UPDATE sequence_versions SET state = 'published', published_at = now(), published_by_user_id = $3
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceOf(), versionId, seeded.alpha.admin.userId],
  );
}

/** A version of one LinkedIn step, as a version stored before 25 September 2026 reads on schema 18. */
async function linkedInVersion(sequenceId: string, version: number, published: boolean): Promise<{ versionId: string; stepId: string }> {
  const versionId = await one(
    'INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, $3) RETURNING id',
    [workspaceOf(), sequenceId, version],
  );
  const stepId = await one(
    `INSERT INTO sequence_steps (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount)
     VALUES ($1, $2, 1, 'linkedin_task', 'elapsed', 0) RETURNING id`,
    [workspaceOf(), versionId],
  );
  if (published) await publish(versionId);
  return { versionId, stepId };
}

async function contact(fullName: string): Promise<string> {
  return await one('INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id', [
    workspaceOf(),
    crm.alpha.firmId,
    fullName,
  ]);
}

async function sequence(name: string): Promise<string> {
  return await one('INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id', [
    workspaceOf(),
    name,
    seeded.alpha.admin.userId,
  ]);
}

/** Three sequences with LinkedIn steps, and a live enrollment whose LinkedIn execution is held. */
async function seedLinkedInSteps(): Promise<void> {
  const workspaceId = workspaceOf();
  ids.spareContactId = await contact('Spare Example');

  // A published LinkedIn version with a LinkedIn draft after it, and a second sequence
  // whose only version is a published LinkedIn one.
  ids.linkedInSequenceId = await sequence('LinkedIn first');
  const published = await linkedInVersion(ids.linkedInSequenceId, 1, true);
  ids.publishedVersionId = published.versionId;
  ids.linkedInStepId = published.stepId;
  ids.draftVersionId = (await linkedInVersion(ids.linkedInSequenceId, 2, false)).versionId;
  ids.publishedOnlySequenceId = await sequence('LinkedIn only');
  await linkedInVersion(ids.publishedOnlySequenceId, 1, true);

  // Lane A2's case: a published version of a LinkedIn task and then a call.
  ids.mixedSequenceId = await sequence('LinkedIn then a call');
  const mixed = await linkedInVersion(ids.mixedSequenceId, 1, false);
  ids.mixedVersionId = mixed.versionId;
  ids.mixedLinkedInStepId = mixed.stepId;
  ids.mixedCallStepId = await one(
    `INSERT INTO sequence_steps
       (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, on_no_answer)
     VALUES ($1, $2, 2, 'call_task', 'business_days', 2, 'advance') RETURNING id`,
    [workspaceId, ids.mixedVersionId],
  );
  await publish(ids.mixedVersionId);

  // A live enrollment whose LinkedIn execution is held for a person, as PR 234's worker
  // left it.
  ids.heldEnrollmentId = await one(
    `INSERT INTO sequence_enrollments
       (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
        started_at, firm_time_zone, holiday_calendar_version, state)
     VALUES ($1, $2, $3, $4, $5, $6, now() - interval '2 hours', 'America/New_York', $7, 'active')
     RETURNING id`,
    [
      workspaceId,
      ids.publishedVersionId,
      crm.alpha.opportunityId,
      crm.alpha.firmId,
      crm.alpha.contactId,
      seeded.alpha.salesperson.userId,
      sequences.alpha.calendarVersion,
    ],
  );
  ids.heldExecutionId = await one(
    `INSERT INTO step_executions
       (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
        due_at, not_before, original_due_at, source_zone, rule_version, state, hold_reason_code)
     VALUES ($1, $2, $3, $4, $5, 'linkedin_task', 1, now() - interval '1 hour', now() - interval '1 hour',
             now() - interval '1 hour', 'America/New_York', 'elapsed.1', 'held', 'long_hold_review')
     RETURNING id`,
    [workspaceId, ids.heldEnrollmentId, ids.linkedInStepId, crm.alpha.firmId, crm.alpha.contactId],
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  sequences = await seedSequences(database.session, seeded);
  await seedLinkedInSteps();
});

afterAll(async () => {
  await database.drop();
});

describe('a step or an execution whose channel was LinkedIn', () => {
  it('never runs a stored LinkedIn execution: the worker holds it and prepares no send', async () => {
    // A stored `linkedin_task`: runDueStepExecution holds it with long_hold_review,
    // prepares no send, and does so again after its recheck.
    const handoff = recordingSendHandoff();
    const now = await databaseNow(worker());
    for (const at of [now, new Date(Date.parse(now) + 2 * 60 * 60 * 1000).toISOString()]) {
      expect(
        await runDueStepExecution(worker(), {
          stepExecutionId: ids.heldExecutionId,
          now: at,
          eligibility: allowAllEligibility(),
          sendHandoff: handoff,
        }),
      ).toEqual({ kind: 'held', stepExecutionId: ids.heldExecutionId, reasonCode: 'long_hold_review' });
    }
    expect(handoff.prepared).toEqual([]);
  });

  it('shows a version with a LinkedIn step as a removed step, with nothing it carried (lane A2)', async () => {
    const [version] = (await listSequenceVersions(worker(), ids.mixedSequenceId)).map(sequenceVersionForDisplay);
    expect(version?.id).toBe(ids.mixedVersionId);
    expect(version?.steps).toEqual([
      {
        id: ids.mixedLinkedInStepId,
        sequenceVersionId: ids.mixedVersionId,
        ordinal: 1,
        channel: 'removed',
        removedChannel: 'linkedin',
        delay: { unit: 'elapsed', hours: 0 },
        onNoAnswer: null,
        templateVersionId: null,
      },
      {
        id: ids.mixedCallStepId,
        sequenceVersionId: ids.mixedVersionId,
        ordinal: 2,
        channel: 'call_task',
        delay: { unit: 'business_days', days: 2 },
        onNoAnswer: 'advance',
        templateVersionId: null,
      },
    ]);
    expect(version?.stopConditions).toEqual(FOUR_STOPS);

    // Every version of the first sequence, the draft included, reads the same way, and
    // the engine's own read keeps the stored marker `isStepChannel` refuses.
    const all = (await listSequenceVersions(worker(), ids.linkedInSequenceId)).map(sequenceVersionForDisplay);
    expect(all.map(entry => entry.steps.map(step => step.channel))).toEqual([['removed'], ['removed']]);
    expect((await readSequenceVersion(worker(), ids.mixedVersionId))?.steps[0]?.channel).toBe('linkedin_task');
  });

  it('reviews the held LinkedIn execution as held for channel_removed, unmoved (lane A2)', async () => {
    const preview = await previewResume(contextFor('salesperson'), { enrollmentId: ids.heldEnrollmentId });
    if (!preview.ok) throw new Error(`the review was refused: ${preview.reason}`);
    expect(preview.value.steps).toHaveLength(1);
    const [step] = preview.value.steps;
    expect(step).toMatchObject({
      stepExecutionId: ids.heldExecutionId,
      ordinal: 1,
      channel: 'removed',
      removedChannel: 'linkedin',
      state: 'held',
      heldReason: 'channel_removed',
    });
    expect(step?.proposedDueAt).toBe(step?.dueAt);
  });

  it('refuses to enrol into, publish or migrate onto a version whose step was LinkedIn', async () => {
    expect(
      await enrollContact(contextFor('salesperson'), {
        sequenceVersionId: ids.publishedVersionId,
        opportunityId: crm.alpha.opportunityId,
        firmId: crm.alpha.firmId,
        contactId: ids.spareContactId,
      }),
    ).toEqual({ ok: false, reason: 'step_unknown' });
    expect(await publishVersion(contextFor('admin'), { sequenceVersionId: ids.draftVersionId })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
    const live = await enrollContact(contextFor('salesperson'), {
      sequenceVersionId: sequences.alpha.publishedVersionId,
      opportunityId: crm.alpha.opportunityId,
      firmId: crm.alpha.firmId,
      contactId: ids.spareContactId,
    });
    if (!live.ok) throw new Error(`the enrollment fixture was refused: ${live.reason}`);
    expect(
      await proposeEnrollmentMigration(contextFor('admin'), {
        fromSequenceVersionId: sequences.alpha.publishedVersionId,
        toSequenceVersionId: ids.publishedVersionId,
        enrollmentIds: [live.value.enrollmentId],
      }),
    ).toEqual({ ok: false, reason: 'step_unknown' });
    await stopEnrollments(worker(), { enrollmentId: live.value.enrollmentId, reason: 'admin_stop' });
  });

  it('copies a version whose step was LinkedIn to a new draft without it, numbered from 1 (lane D1)', async () => {
    // "Edit as a new draft" is createDraftVersion with no steps. The mixed version is a
    // LinkedIn task at 1 and a call at 2; the copy used to keep the LinkedIn task, and
    // `validateSteps` refused the whole draft as `invalid_input`.
    const mixed = await createDraftVersion(contextFor('admin'), { sequenceId: ids.mixedSequenceId });
    if (!mixed.ok) throw new Error(`the draft was refused: ${mixed.reason}`);
    expect(mixed.value.version).toBe(2);
    const draft = await readSequenceVersion(contextFor('admin'), mixed.value.sequenceVersionId);
    expect(draft?.state).toBe('draft');
    expect(draft?.steps.map(({ ordinal, channel, delay, onNoAnswer, templateVersionId }) => ({ ordinal, channel, delay, onNoAnswer, templateVersionId }))).toEqual([
      { ordinal: 1, channel: 'call_task', delay: { unit: 'business_days', days: 2 }, onNoAnswer: 'advance', templateVersionId: null },
    ]);
    // The published version is untouched: its LinkedIn step is still stored, and still shown.
    expect((await readSequenceVersion(worker(), ids.mixedVersionId))?.steps.map(step => step.channel)).toEqual([
      'linkedin_task',
      'call_task',
    ]);

    // A version of only a LinkedIn step copies to a draft with no steps. A draft may be
    // empty; publishing one is what is refused, for `version_has_no_steps`.
    const only = await createDraftVersion(contextFor('admin'), { sequenceId: ids.publishedOnlySequenceId });
    if (!only.ok) throw new Error(`the draft was refused: ${only.reason}`);
    expect(only.value.version).toBe(2);
    expect((await readSequenceVersion(contextFor('admin'), only.value.sequenceVersionId))?.steps).toEqual([]);
    expect(await publishVersion(contextFor('admin'), { sequenceVersionId: only.value.sequenceVersionId })).toEqual({
      ok: false,
      reason: 'version_has_no_steps',
    });
  });

  it('keeps a held LinkedIn execution held on resume, and returns a current one to pending (lane A2)', async () => {
    const workspaceId = workspaceOf();
    const reviewContactId = await contact('Review Example');
    const enrollmentId = await one(
      `INSERT INTO sequence_enrollments
         (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id, state,
          review_union_milliseconds, started_at, firm_time_zone, holiday_calendar_version)
       VALUES ($1, $2, $3, $4, $5, $6, 'review_required', 864000000, now() - interval '12 days',
               'America/New_York', $7)
       RETURNING id`,
      [
        workspaceId,
        ids.mixedVersionId,
        crm.alpha.opportunityId,
        crm.alpha.firmId,
        reviewContactId,
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
        [workspaceId, enrollmentId, stepId, crm.alpha.firmId, reviewContactId, channel, ordinal],
      );
    // Written on schema 18: the marker is the one LinkedIn value the CHECK still admits.
    const linkedIn = await held(ids.mixedLinkedInStepId, 'linkedin_task', 1);
    const call = await held(ids.mixedCallStepId, 'call_task', 2);

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
    await stopEnrollments(worker(), { enrollmentId, reason: 'admin_stop' });
  });

  it('lets a person stop the enrollment a held LinkedIn execution belongs to', async () => {
    // Cancelling the held LinkedIn execution is an UPDATE of a row the CHECKs must
    // still accept.
    const stopped = await stopEnrollments(contextFor('admin'), { enrollmentId: ids.heldEnrollmentId, reason: 'admin_stop' });
    expect(stopped).toMatchObject({ enrollmentsStopped: 1, executionsCancelled: 1 });
  });
});
