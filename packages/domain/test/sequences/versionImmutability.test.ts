import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import {
  createDraftVersion,
  publishVersion,
  retireVersion,
  saveSteps,
  type DraftStepInput,
} from '../../sequences/definitions.ts';
import { allowAllEligibility } from '../../sequences/eligibility.ts';
import { enrollContact } from '../../sequences/enrollments.ts';
import { completeStepExecution, runDueStepExecution } from '../../sequences/executions.ts';
import { listStepExecutions, readSequenceVersion } from '../../sequences/rows.ts';
import { recordingSendHandoff } from '../../sequences/sendHandoff.ts';
import { createTemplateVersion, readTemplateVersion, updateTemplateVersion } from '../../templates/templates.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { fixtureBody, seedSequences } from './support/sequenceFixtures.ts';
import {
  approvedTemplate as makeTemplate,
  callStep,
  emailStep,
  newFirm as makeFirm,
  publishedPlan as makePlan,
  templateText,
  type VersionFirm,
} from './support/versionFixtures.ts';

/**
 * Edits create new versions; running enrollments keep theirs (send-path v2, S2;
 * David, 30 September 2026).
 *
 * > "Existing enrollments keep their original steps, template versions, and cadence.
 * > Edits affect new enrollments by default."
 *
 * Until this slice `saveSteps` updated a published version's steps in place and
 * `updateTemplateVersion` rewrote an approved version's text in place, so a live
 * enrollment could read new steps or new approved text under an old agreement. Each case
 * below fails with that in-place path put back:
 *
 *   (a) the published rows are byte-identical after an edit (`row_to_json` of every row);
 *   (b) a new enrollment on the newly published version runs the edited steps and text;
 *   (c) an enrollment already running sends the text it was enrolled under and schedules
 *       the next step by its own version's delay.
 *
 * (d), the database triggers of migration 0026 answered as refusals, is at the end.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;

const DUE = '2026-09-21T13:00:00Z';

const contextFor = (who: 'admin' | 'salesperson'): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha[who].userId, role: who }),
    database.session,
  );

const worker = (): RepositoryContext =>
  repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), database.session);

type Firm = VersionFirm;
const newFirm = async (_label: string): Promise<Firm> => await makeFirm(database.session, seeded.alpha);
const text = templateText;
const approvedTemplate = async (opening: string): Promise<string> => await makeTemplate(contextFor('admin'), opening);
const publishedPlan = async (steps: readonly DraftStepInput[]) => await makePlan(contextFor('admin'), steps);

/** Every stored byte of a version and its steps, as the database has them. */
async function versionBytes(versionId: string): Promise<readonly string[]> {
  const { rows } = await database.session.query<{ row: string }>(
    `SELECT row_to_json(v)::text AS row FROM sequence_versions v WHERE v.id = $1
     UNION ALL
     SELECT row FROM (SELECT row_to_json(s)::text AS row FROM sequence_steps s
                       WHERE s.sequence_version_id = $1 ORDER BY s.ordinal) steps`,
    [versionId],
  );
  return rows.map(row => row.row);
}

async function templateBytes(templateVersionId: string): Promise<string | undefined> {
  const { rows } = await database.session.query<{ row: string }>(
    'SELECT row_to_json(t)::text AS row FROM template_versions t WHERE t.id = $1',
    [templateVersionId],
  );
  return rows[0]?.row;
}

async function enroll(versionId: string, firm: Firm): Promise<string> {
  const result = await enrollContact(contextFor('salesperson'), {
    sequenceVersionId: versionId,
    originKind: 'prospecting',
    opportunityId: firm.opportunityId,
    firmId: firm.firmId,
    contactId: firm.contactId,
  });
  if (!result.ok) throw new Error(`the enrollment was refused: ${result.reason}`);
  await database.session.query(
    `UPDATE step_executions SET due_at = $2::timestamptz, not_before = $2::timestamptz, original_due_at = $2::timestamptz
      WHERE enrollment_id = $1 AND state IN ('pending', 'held')`,
    [result.value.enrollmentId, DUE],
  );
  return result.value.enrollmentId;
}

/** Run the enrollment's due e-mail step and answer what crossed the hand-off. */
async function sendFirstStep(enrollmentId: string): Promise<{ hash: string | undefined; body: string | undefined }> {
  const handoff = recordingSendHandoff();
  const outcome = await runDueStepExecution(worker(), {
    enrollmentId,
    now: DUE,
    eligibility: allowAllEligibility(),
    sendHandoff: handoff,
  });
  expect(outcome.kind).toBe('handed_to_send');
  return { hash: handoff.prepared[0]?.templateContentHash, body: handoff.prepared[0]?.body };
}

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  // The holiday calendar every enrollment freezes; the plans are made per case.
  await seedSequences(database.session, seeded);
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.session.query('DELETE FROM step_execution_shifts');
  await database.session.query('DELETE FROM step_executions');
  await database.session.query('DELETE FROM sequence_enrollments');
  await database.session.query('DELETE FROM active_holds');
});

describe('(a) an edit never writes to a published version or an approved template', () => {
  it('writes the edited steps to a new draft version and leaves every published byte as it was', async () => {
    const template = await approvedTemplate('Published wording.');
    const plan = await publishedPlan([emailStep(template), callStep(2, 3)]);
    const before = await versionBytes(plan.versionId);

    const saved = await saveSteps(contextFor('admin'), {
      sequenceVersionId: plan.versionId,
      steps: [emailStep(template), callStep(2, 9), callStep(3, 2)],
    });
    if (!saved.ok) throw new Error(`the save was refused: ${saved.reason}`);
    expect(saved.value).toMatchObject({ steps: 3, version: 2, newVersion: true });
    expect(saved.value.sequenceVersionId).not.toBe(plan.versionId);

    expect(await versionBytes(plan.versionId)).toEqual(before);
    const draft = await readSequenceVersion(contextFor('admin'), saved.value.sequenceVersionId);
    expect(draft?.state).toBe('draft');
    expect(draft?.steps.map(step => step.delay)).toEqual([
      { unit: 'elapsed', hours: 0 },
      { unit: 'business_days', days: 9 },
      { unit: 'business_days', days: 2 },
    ]);

    // A second edit of the published version, while that draft exists, is refused and
    // names the draft rather than overwriting it (David, 30 September 2026).
    const draftBytes = await versionBytes(saved.value.sequenceVersionId);
    const again = await saveSteps(contextFor('admin'), {
      sequenceVersionId: plan.versionId,
      steps: [emailStep(template), callStep(2, 4)],
    });
    expect(again).toEqual({
      ok: false,
      reason: 'draft_exists',
      draft: { sequenceVersionId: saved.value.sequenceVersionId, version: 2 },
    });
    expect(await versionBytes(saved.value.sequenceVersionId)).toEqual(draftBytes);
    expect(await versionBytes(plan.versionId)).toEqual(before);
    // The draft itself is still edited directly.
    expect(
      await saveSteps(contextFor('admin'), { sequenceVersionId: saved.value.sequenceVersionId, steps: [emailStep(template)] }),
    ).toMatchObject({ ok: true, value: { newVersion: false, version: 2 } });
  });

  it('writes an edit of an approved template as its next version, pending approval, and leaves the approved row as it was', async () => {
    const id = await approvedTemplate('Approved wording.');
    const before = await templateBytes(id);
    const stored = await readTemplateVersion(contextFor('admin'), id);

    const pending = await updateTemplateVersion(contextFor('admin'), { ...text('Edited wording.'), templateVersionId: id });
    if (!pending.ok) throw new Error(`the edit was refused: ${pending.reason}`);
    expect(pending.value).toMatchObject({
      templateId: stored?.templateId,
      version: (stored?.version ?? 0) + 1,
      approvedAt: null,
    });
    expect(pending.value.id).not.toBe(id);

    // "Save and approve" on the approved version approves the new one, never the old.
    const approved = await updateTemplateVersion(contextFor('admin'), {
      ...text('Edited and approved.'),
      templateVersionId: id,
      approve: true,
    });
    if (!approved.ok) throw new Error(`the edit was refused: ${approved.reason}`);
    expect(approved.value.approvedAt).not.toBeNull();
    expect(approved.value.version).toBe((stored?.version ?? 0) + 2);

    expect(await templateBytes(id)).toBe(before);
  });

  it('still edits an unapproved template in place, and refuses a retired version and a salesperson', async () => {
    const created = await createTemplateVersion(contextFor('admin'), text('Draft wording.'));
    if (!created.ok) throw new Error(`the template was refused: ${created.reason}`);
    const edited = await updateTemplateVersion(contextFor('admin'), { ...text('Better wording.'), templateVersionId: created.value.id });
    expect(edited.ok && edited.value.id).toBe(created.value.id);
    expect(
      await updateTemplateVersion(contextFor('salesperson'), { ...text('x'), templateVersionId: created.value.id }),
    ).toEqual({ ok: false, reason: 'admin_only' });
    const plan = await publishedPlan([emailStep(await approvedTemplate('Retire me.'))]);
    expect((await retireVersion(contextFor('admin'), { sequenceVersionId: plan.versionId })).ok).toBe(true);
    expect(await saveSteps(contextFor('admin'), { sequenceVersionId: plan.versionId, steps: [callStep(1, 0)] })).toEqual({
      ok: false,
      reason: 'version_retired',
    });
    expect(await saveSteps(contextFor('salesperson'), { sequenceVersionId: plan.versionId, steps: [callStep(1, 0)] })).toEqual({
      ok: false,
      reason: 'admin_only',
    });
  });
});

describe('(b) and (c): new enrollments run the new version; running ones keep theirs', () => {
  it('retires the replaced version on publish, sends the old text and keeps the old cadence for the running enrollment, and the new ones for a new enrollment', async () => {
    const original = await approvedTemplate('The wording they were enrolled under.');
    const originalHash = (await readTemplateVersion(contextFor('admin'), original))?.contentHash;
    const plan = await publishedPlan([emailStep(original), callStep(2, 2)]);
    const oldSteps = (await readSequenceVersion(contextFor('admin'), plan.versionId))?.steps ?? [];

    const running = await enroll(plan.versionId, await newFirm('running'));

    // Both edits, after the enrollment exists: the template's text and the plan's cadence.
    const edited = await updateTemplateVersion(contextFor('admin'), {
      ...text('The wording written afterwards.'),
      templateVersionId: original,
      approve: true,
    });
    if (!edited.ok) throw new Error(`the edit was refused: ${edited.reason}`);
    const saved = await saveSteps(contextFor('admin'), {
      sequenceVersionId: plan.versionId,
      steps: [emailStep(edited.value.id), callStep(2, 9)],
    });
    if (!saved.ok) throw new Error(`the save was refused: ${saved.reason}`);
    expect((await publishVersion(contextFor('admin'), { sequenceVersionId: saved.value.sequenceVersionId })).ok).toBe(true);

    // Publishing the edit retired the version it replaced: one current version per
    // sequence, and nobody new can be enrolled in the old one.
    expect((await readSequenceVersion(contextFor('admin'), plan.versionId))?.state).toBe('retired');
    expect((await readSequenceVersion(contextFor('admin'), saved.value.sequenceVersionId))?.state).toBe('published');
    const late = await newFirm('late');
    expect(
      await enrollContact(contextFor('salesperson'), {
        sequenceVersionId: plan.versionId,
        originKind: 'prospecting',
        opportunityId: late.opportunityId,
        firmId: late.firmId,
        contactId: late.contactId,
      }),
    ).toEqual({ ok: false, reason: 'version_retired' });

    // (c) The running enrollment: its own (now retired) version's steps, the text it was
    // enrolled under.
    expect((await readSequenceVersion(contextFor('admin'), plan.versionId))?.steps).toEqual(oldSteps);
    const sent = await sendFirstStep(running);
    expect(sent.hash).toBe(originalHash);
    expect(sent.body).toBe(fixtureBody('The wording they were enrolled under.'));
    const [first] = await listStepExecutions(worker(), { enrollmentId: running });
    const completed = await completeStepExecution(worker(), {
      stepExecutionId: first?.id ?? '',
      completionSource: 'send',
      result: 'sent',
      completedAt: DUE,
    });
    expect(completed.ok).toBe(true);
    const successor = (await listStepExecutions(worker(), { enrollmentId: running })).find(step => step.ordinal === 2);
    expect(successor?.stepId).toBe(oldSteps[1]?.id);

    // (b) A new enrollment on the newly published version: the edited steps and text.
    const fresh = await enroll(saved.value.sequenceVersionId, await newFirm('fresh'));
    const newSteps = (await readSequenceVersion(contextFor('admin'), saved.value.sequenceVersionId))?.steps ?? [];
    expect(newSteps[1]?.delay).toEqual({ unit: 'business_days', days: 9 });
    const freshSent = await sendFirstStep(fresh);
    expect(freshSent.hash).toBe(edited.value.contentHash);
    expect(freshSent.body).toBe(fixtureBody('The wording written afterwards.'));
    const [freshFirst] = await listStepExecutions(worker(), { enrollmentId: fresh });
    expect(freshFirst?.stepId).toBe(newSteps[0]?.id);
  });
});

describe('(d) migration 0026’s triggers come back as refusals, never as a 500', () => {
  /**
   * The commands lock and read the state before they write, so no ordinary call reaches
   * the triggers. To prove the backstop answers, the one read that decides — the locked
   * state of the version, or the locked approval of the template — is made to lie: the
   * command then takes the path for a draft (or an unapproved template) and writes to a
   * row the database knows is frozen. The command runs inside a transaction, as every
   * command does through `runCommand`, and the transaction is still usable afterwards:
   * the refusal commits with its receipt.
   */
  function lyingContext(session: TestDatabase['session'], lie: (sql: string, row: Record<string, unknown>) => Record<string, unknown>): RepositoryContext {
    const db = {
      query: async (sql: string, values?: readonly unknown[]) => {
        const result = await session.query<Record<string, unknown>>(sql, values as unknown[]);
        return { ...result, rows: result.rows.map(row => lie(sql, row)) };
      },
    } as unknown as RepositoryContext['db'];
    return repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      db,
    );
  }

  it('answers version_not_draft when a save reaches a published version’s steps, and writes nothing', async () => {
    const template = await approvedTemplate('Frozen steps.');
    const plan = await publishedPlan([emailStep(template), callStep(2, 3)]);
    const before = await versionBytes(plan.versionId);
    const context = lyingContext(database.session, (sql, row) =>
      sql.includes('FROM sequence_versions') && sql.includes('FOR UPDATE') ? { ...row, state: 'draft' } : row,
    );

    await database.session.query('BEGIN');
    try {
      const saved = await saveSteps(context, { sequenceVersionId: plan.versionId, steps: [callStep(1, 1)] });
      expect(saved).toEqual({ ok: false, reason: 'version_not_draft' });
      // The transaction survived the trigger: the receipt could still commit.
      await database.session.query('SELECT 1');
    } finally {
      await database.session.query('COMMIT');
    }
    expect(await versionBytes(plan.versionId)).toEqual(before);
  });

  it('answers template_already_approved when an edit reaches an approved template’s bytes, and writes nothing', async () => {
    const id = await approvedTemplate('Frozen text.');
    const before = await templateBytes(id);
    const context = lyingContext(database.session, (sql, row) =>
      sql.includes('FROM template_versions') && sql.includes('FOR UPDATE') ? { ...row, approved_at: null } : row,
    );

    await database.session.query('BEGIN');
    try {
      const edited = await updateTemplateVersion(context, { ...text('Rewritten in place.'), templateVersionId: id });
      expect(edited).toEqual({ ok: false, reason: 'template_already_approved' });
      await database.session.query('SELECT 1');
    } finally {
      await database.session.query('COMMIT');
    }
    expect(await templateBytes(id)).toBe(before);
  });

  it('still throws any other restrict_violation, which would be a real bug', async () => {
    const plan = await publishedPlan([callStep(1, 0)]);
    const draft = await createDraftVersion(contextFor('admin'), { sequenceId: plan.sequenceId, steps: [callStep(1, 0)] });
    if (!draft.ok) throw new Error(`the draft was refused: ${draft.reason}`);
    await database.session.query('BEGIN');
    try {
      // Another trigger raising the same SQLSTATE with another message, for this
      // transaction only: the guard matches 0026's messages, not the code alone.
      await database.session.query(
        `CREATE FUNCTION pg_temp.boom() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN RAISE EXCEPTION 'something else entirely' USING ERRCODE = 'restrict_violation'; END $$;
         CREATE TRIGGER boom BEFORE INSERT ON sequence_steps FOR EACH ROW EXECUTE FUNCTION pg_temp.boom();`,
      );
      await expect(
        saveSteps(contextFor('admin'), { sequenceVersionId: draft.value.sequenceVersionId, steps: [callStep(1, 2)] }),
      ).rejects.toMatchObject({ code: '23001' });
    } finally {
      await database.session.query('ROLLBACK');
    }
  });
});
