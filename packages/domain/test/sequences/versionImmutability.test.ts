import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import {
  createDraftVersion,
  createSequence,
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
import { firstStageId } from '../db/support/crmFixtures.ts';
import { FIXTURE_SIGN_OFF, fixtureBody, seedSequences } from './support/sequenceFixtures.ts';

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

interface Firm {
  readonly firmId: string;
  readonly contactId: string;
  readonly opportunityId: string;
}

/** One more firm with one reachable contact and an open opportunity, in workspace alpha. */
async function newFirm(label: string): Promise<Firm> {
  const workspaceId = seeded.alpha.workspaceId;
  const { rows: firm } = await database.session.query<{ id: string }>(
    `INSERT INTO firms (workspace_id, name, assigned_user_id, website, locality, region_code, postal_code,
                        time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
     VALUES ($1, $2, $3, $4, 'Providence', 'RI', '02903', 'America/New_York', 'medium', 'state_default', 'firm-zone.1')
     RETURNING id`,
    [workspaceId, `Immutable ${label}`, seeded.alpha.salesperson.userId, `https://${label}.example.test`],
  );
  const firmId = firm[0]?.id ?? '';
  const { rows: contact } = await database.session.query<{ id: string }>(
    `INSERT INTO contacts (workspace_id, firm_id, full_name, title, is_primary)
     VALUES ($1, $2, 'Robin Example', 'Owner', true) RETURNING id`,
    [workspaceId, firmId],
  );
  const contactId = contact[0]?.id ?? '';
  await database.session.query(
    `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                  association_confidence, technical_validation, eligibility, eligibility_policy_version)
     VALUES ($1, $2, $3, $4, 'research_provider', TIMESTAMPTZ '2026-09-01 12:00:00+00',
             0.950, 'passed', 'usable', 'route-policy.1')`,
    [workspaceId, firmId, contactId, `robin@${label}.example.test`],
  );
  const { rows: opportunity } = await database.session.query<{ id: string }>(
    `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
     VALUES ($1, $2, $3, TIMESTAMPTZ '2026-09-01 12:00:00+00') RETURNING id`,
    [workspaceId, firmId, await firstStageId(database.session, workspaceId)],
  );
  return { firmId, contactId, opportunityId: opportunity[0]?.id ?? '' };
}

const text = (opening: string) => ({
  name: 'Versioned',
  subject: 'Hello {firm_name}',
  body: fixtureBody(opening),
  footer: { signOff: FIXTURE_SIGN_OFF },
  requiredVariables: ['firm_name'],
});

async function approvedTemplate(opening: string): Promise<string> {
  const created = await createTemplateVersion(contextFor('admin'), { ...text(opening), approve: true });
  if (!created.ok) throw new Error(`the template was refused: ${created.reason}`);
  return created.value.id;
}

const emailStep = (templateVersionId: string): DraftStepInput => ({
  ordinal: 1,
  channel: 'email',
  delay: { unit: 'elapsed', hours: 0 },
  templateVersionId,
});
const callStep = (ordinal: number, days: number): DraftStepInput => ({
  ordinal,
  channel: 'call_task',
  delay: { unit: 'business_days', days },
  onNoAnswer: 'advance',
});

/** A new sequence with one published version of `steps`. */
async function publishedPlan(steps: readonly DraftStepInput[]): Promise<{ sequenceId: string; versionId: string }> {
  const sequence = await createSequence(contextFor('admin'), { name: `Plan ${crypto.randomUUID()}` });
  if (!sequence.ok) throw new Error(`the sequence was refused: ${sequence.reason}`);
  const draft = await createDraftVersion(contextFor('admin'), { sequenceId: sequence.value.id, steps });
  if (!draft.ok) throw new Error(`the draft was refused: ${draft.reason}`);
  const published = await publishVersion(contextFor('admin'), { sequenceVersionId: draft.value.sequenceVersionId });
  if (!published.ok) throw new Error(`the publication was refused: ${published.reason}`);
  return { sequenceId: sequence.value.id, versionId: draft.value.sequenceVersionId };
}

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

    // A second save of the published version lands on the same draft (one per sequence).
    const again = await saveSteps(contextFor('admin'), {
      sequenceVersionId: plan.versionId,
      steps: [emailStep(template), callStep(2, 4)],
    });
    expect(again).toEqual({
      ok: true,
      value: { steps: 2, sequenceVersionId: saved.value.sequenceVersionId, version: 2, newVersion: true },
    });
    expect(await versionBytes(plan.versionId)).toEqual(before);
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
  it('sends the old text and keeps the old cadence for the running enrollment, and the new ones for a new enrollment', async () => {
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

    // (c) The running enrollment: its own version's steps, the text it was enrolled under.
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
