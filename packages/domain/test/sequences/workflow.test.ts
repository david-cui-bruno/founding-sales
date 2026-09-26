import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { databaseNow } from '../../policy/clock.ts';
import { buildTodaySnapshot } from '../../today/build.ts';
import { readTodayFirm, readTodayList } from '../../today/dto.ts';
import { businessDateOf } from '../../today/snapshots.ts';
import {
  approveTemplateVersion,
  createTemplateVersion,
  readTemplateVersion,
  updateTemplateVersion,
} from '../../templates/templates.ts';
import { recordHolidayCalendar } from '../../sequences/calendars.ts';
import {
  createDraftVersion,
  createSequence,
  publishVersion,
  retireVersion,
  saveSteps,
} from '../../sequences/definitions.ts';
import { allowAllEligibility } from '../../sequences/eligibility.ts';
import { enrollContact } from '../../sequences/enrollments.ts';
import { completeStepExecution, runDueStepExecution } from '../../sequences/executions.ts';
import { listStepExecutions, readSequenceVersion } from '../../sequences/rows.ts';
import { recordingSendHandoff } from '../../sequences/sendHandoff.ts';
import { dueSequenceWorkSource } from '../../sequences/todaySource.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { SENDING_STOP_LINE } from '@fss/contracts';
import {
  FIXTURE_SIGN_OFF,
  fixtureBody,
  seedSequences,
  type SeededSequences,
} from './support/sequenceFixtures.ts';

/**
 * The rest of the lane against a real PostgreSQL: DST, the Today source, the
 * template lifecycle and edit in place (specification 11.1, 11.2, 8.2, Appendix D,
 * Appendix G 8 and 32; wave 2, S3).
 *
 * The scenario file holds the six Appendix G cases this lane is accepted on; this one
 * holds the behaviour those cases assume. Two workspaces with colliding names
 * throughout.
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
  await database.session.query('DELETE FROM step_execution_shifts');
  await database.session.query('DELETE FROM step_executions');
  await database.session.query('DELETE FROM sequence_enrollments');
  await database.session.query('DELETE FROM today_items');
  await database.session.query('DELETE FROM today_snapshots');
  await database.session.query('DELETE FROM active_holds');
}

async function enroll(workspace: 'alpha' | 'beta', contactId?: string): Promise<string> {
  const firm = crm[workspace];
  const result = await enrollContact(contextFor(workspace, 'salesperson'), {
    sequenceVersionId: sequences[workspace].publishedVersionId,
    opportunityId: firm.opportunityId,
    firmId: firm.firmId,
    contactId: contactId ?? firm.contactId,
  });
  if (!result.ok) throw new Error(`the enrollment fixture was refused: ${result.reason}`);
  return result.value.enrollmentId;
}

async function setDue(workspace: 'alpha' | 'beta', enrollmentId: string, instant: string): Promise<void> {
  await database.session.query(
    `UPDATE step_executions
        SET due_at = $3::timestamptz, not_before = $3::timestamptz, original_due_at = $3::timestamptz
      WHERE workspace_id = $1 AND enrollment_id = $2 AND state IN ('pending', 'held')`,
    [seeded[workspace].workspaceId, enrollmentId, instant],
  );
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

describe('scenario 32: DST resolves deterministically in the firm’s own zone', () => {
  /**
   * The United States moves its clocks on a Sunday, so the 08:00 window never falls
   * inside the gap itself. What DST does change is the *UTC instant* 08:00 lands on,
   * and that is what these two assert: the same local morning, an hour apart in UTC,
   * on either side of a transition. A rule that computed the offset once and reused
   * it would pass one of these and fail the other.
   */
  it('places the Monday after the autumn fold at 08:00 EST, not EDT', async () => {
    const enrollmentId = await enroll('alpha');
    // Sunday 1 November 2026 is the fold day; the next sending day is Monday the 2nd.
    await setDue('alpha', enrollmentId, '2026-11-01T14:00:00Z');
    const placed = await runDueStepExecution(worker(), {
      enrollmentId,
      now: '2026-11-01T14:00:00Z',
      eligibility: allowAllEligibility(),
      sendHandoff: recordingSendHandoff(),
    });
    // 08:00 America/New_York in EST is 13:00 UTC.
    expect(placed.kind === 'scheduled' ? placed.sendAt : '').toBe('2026-11-02T13:00:00.000Z');
  });

  it('places the Monday after the spring gap at 08:00 EDT, not EST', async () => {
    const enrollmentId = await enroll('alpha');
    // Saturday 13 March 2027; the gap is Sunday the 14th and the next sending day is
    // Monday the 15th.
    await setDue('alpha', enrollmentId, '2027-03-13T14:00:00Z');
    const placed = await runDueStepExecution(worker(), {
      enrollmentId,
      now: '2027-03-13T14:00:00Z',
      eligibility: allowAllEligibility(),
      sendHandoff: recordingSendHandoff(),
    });
    // 08:00 America/New_York in EDT is 12:00 UTC.
    expect(placed.kind === 'scheduled' ? placed.sendAt : '').toBe('2027-03-15T12:00:00.000Z');
  });

  it('records the move as a shift, and never moves work earlier', async () => {
    const enrollmentId = await enroll('alpha');
    await setDue('alpha', enrollmentId, '2026-11-01T14:00:00Z');
    await runDueStepExecution(worker(), {
      enrollmentId,
      now: '2026-11-01T14:00:00Z',
      eligibility: allowAllEligibility(),
      sendHandoff: recordingSendHandoff(),
    });
    const { rows } = await database.session.query<{ reason: string; shift_milliseconds: string }>(
      `SELECT reason, shift_milliseconds::text FROM step_execution_shifts
        WHERE workspace_id = $1 AND enrollment_id = $2`,
      [seeded.alpha.workspaceId, enrollmentId],
    );
    expect(rows[0]?.reason).toBe('send_window');
    expect(Number(rows[0]?.shift_milliseconds ?? 0)).toBeGreaterThan(0);
    // `original_due_at` is the instant the cadence produced, and it does not move.
    const executions = await listStepExecutions(worker(), { enrollmentId });
    expect(executions[0]?.originalDueAt).toBe('2026-11-01T14:00:00.000Z');
    expect(executions[0]?.dueAt).toBe('2026-11-02T13:00:00.000Z');
  });
});

describe('the Today source: lane 3 is due sequence work (8.2)', () => {
  it('counts emails and calls separately on one card', async () => {
    const enrollmentId = await enroll('alpha');
    const now = await databaseNow(worker());
    await setDue('alpha', enrollmentId, now);

    // Walk a second enrollment to its second step so both kinds exist at once — 8.2's
    // "Expanding the card reveals contact-level tasks".
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id`,
      [seeded.alpha.workspaceId, crm.alpha.firmId, 'Alex Example'],
    );
    const id = await enroll('alpha', rows[0]?.id ?? '');
    const first = (await listStepExecutions(worker(), { enrollmentId: id }))[0];
    if (first !== undefined) {
      await completeStepExecution(worker(), {
        stepExecutionId: first.id,
        completionSource: 'send',
        result: 'sent',
      });
    }
    await setDue('alpha', id, now);

    const businessDate = await businessDateOf(worker(), now);
    await buildTodaySnapshot(worker(), {
      businessDate,
      now,
      sources: [dueSequenceWorkSource()],
    });

    const list = await readTodayList(contextFor('alpha', 'salesperson'), { now });
    const card = list.cards.find(candidate => candidate.firmId === crm.alpha.firmId);
    expect(card).toBeDefined();
    expect(card?.counts.emailsDue).toBe(1);
    expect(card?.counts.callsDue).toBe(1);
  });

  it('does not put one workspace’s due work on the other’s list (G 8)', async () => {
    const now = await databaseNow(worker());
    const businessDate = await businessDateOf(worker(), now);
    const alpha = await enroll('alpha');
    await setDue('alpha', alpha, now);

    for (const workspace of ['alpha', 'beta'] as const) {
      await buildTodaySnapshot(worker(workspace), {
        businessDate,
        now,
        sources: [dueSequenceWorkSource()],
      });
    }

    const betaList = await readTodayList(contextFor('beta', 'admin'), { now });
    expect(betaList.cards).toHaveLength(0);
    const alphaList = await readTodayList(contextFor('alpha', 'admin'), { now });
    expect(alphaList.cards.map(card => card.firmId)).toEqual([crm.alpha.firmId]);
  });
});

describe('a held step says how long it has been held (wave 2, S4.1)', () => {
  it('answers heldDays on the expanded card for a held step, and null for one that is not', async () => {
    const now = await databaseNow(worker());
    const held = await enroll('alpha');
    await setDue('alpha', held, new Date(Date.parse(now) - 3 * 86_400_000 - 60_000).toISOString());
    await database.session.query(
      `UPDATE step_executions SET state = 'held', hold_reason_code = 'mailbox_disconnected'
        WHERE workspace_id = $1 AND enrollment_id = $2`,
      [seeded.alpha.workspaceId, held],
    );
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id`,
      [seeded.alpha.workspaceId, crm.alpha.firmId, 'Alex Example'],
    );
    const pending = await enroll('alpha', rows[0]?.id ?? '');
    await setDue('alpha', pending, now);

    await buildTodaySnapshot(worker(), {
      businessDate: await businessDateOf(worker(), now),
      now,
      sources: [dueSequenceWorkSource()],
    });
    const page = await readTodayFirm(contextFor('alpha', 'salesperson'), { firmId: crm.alpha.firmId, now });
    const byExecution = new Map(page?.tasks.map(task => [task.stepExecutionId, task.heldDays]));
    const [heldStep] = await listStepExecutions(worker(), { enrollmentId: held });
    const [pendingStep] = await listStepExecutions(worker(), { enrollmentId: pending });
    expect(byExecution.get(heldStep?.id ?? '')).toBe(3);
    expect(byExecution.get(pendingStep?.id ?? '')).toBeNull();
  });
});

describe('the template lifecycle (11.1, 12.6)', () => {
  it('refuses to approve a body that breaks a rule, and names every rule it broke', async () => {
    const created = await createTemplateVersion(contextFor('alpha', 'admin'), {
      name: 'Too much',
      subject: 'Our pricing for you',
      body: 'No footer.',
      footer: { signOff: FIXTURE_SIGN_OFF },
      requiredVariables: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const approved = await approveTemplateVersion(contextFor('alpha', 'admin'), {
      templateVersionId: created.value.id,
    });
    expect(approved.ok).toBe(false);
    if (approved.ok) return;
    expect(approved.reason).toBe('template_unapproved');
    expect(approved.issues).toEqual(['template_footer_missing']);
  });

  it('approves a body past the copy limits and answers the warnings with the version', async () => {
    const created = await createTemplateVersion(contextFor('alpha', 'admin'), {
      name: 'Copy advice',
      subject: 'Our pricing for you',
      body: fixtureBody(`${'Word '.repeat(90)}See https://one.example.test and https://two.example.test.`),
      footer: { signOff: FIXTURE_SIGN_OFF },
      requiredVariables: [],
    });
    if (!created.ok) throw new Error(`the template was refused: ${created.reason}`);
    const expected = ['template_body_multiple_urls', 'template_body_too_long', 'template_pricing_or_guarantee_language'];
    expect([...created.value.warnings].sort()).toEqual(expected);

    const approved = await approveTemplateVersion(contextFor('alpha', 'admin'), { templateVersionId: created.value.id });
    if (!approved.ok) throw new Error(`the approval was refused: ${approved.reason}`);
    expect(approved.value.approvedAt).not.toBeNull();
    expect([...approved.value.warnings].sort()).toEqual(expected);
  });

  it('approves a body that satisfies them, and refuses a salesperson who tries', async () => {
    const payload = {
      name: 'Second touch',
      subject: 'Following up',
      body: fixtureBody('A short note.'),
      footer: { signOff: FIXTURE_SIGN_OFF },
      requiredVariables: [],
    };
    const refused = await createTemplateVersion(contextFor('alpha', 'salesperson'), payload);
    expect(refused).toEqual({ ok: false, reason: 'admin_only' });

    const created = await createTemplateVersion(contextFor('alpha', 'admin'), payload);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const approved = await approveTemplateVersion(contextFor('alpha', 'admin'), {
      templateVersionId: created.value.id,
    });
    expect(approved.ok).toBe(true);

    // A retired version (nothing retires one since wave 2 but a stored row) refuses a
    // second approval.
    await database.session.query('UPDATE template_versions SET retired_at = now() WHERE id = $1', [created.value.id]);
    const again = await approveTemplateVersion(contextFor('alpha', 'admin'), {
      templateVersionId: created.value.id,
    });
    expect(again).toMatchObject({ ok: false, reason: 'template_retired' });
  });

  it('refuses to publish a version whose email step names an unapproved template', async () => {
    const draft = await createTemplateVersion(contextFor('alpha', 'admin'), {
      name: 'Unapproved',
      subject: 'Hello',
      body: fixtureBody('Still a draft.'),
      footer: { signOff: FIXTURE_SIGN_OFF },
      requiredVariables: [],
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const sequence = await createSequence(contextFor('alpha', 'admin'), {
      name: `Unapproved plan ${String(Date.now())}`,
    });
    expect(sequence.ok).toBe(true);
    if (!sequence.ok) return;
    const version = await createDraftVersion(contextFor('alpha', 'admin'), {
      sequenceId: sequence.value.id,
      steps: [
        {
          ordinal: 1,
          channel: 'email',
          delay: { unit: 'elapsed', hours: 0 },
          templateVersionId: draft.value.id,
        },
      ],
    });
    expect(version.ok).toBe(true);
    if (!version.ok) return;

    const published = await publishVersion(contextFor('alpha', 'admin'), {
      sequenceVersionId: version.value.sequenceVersionId,
    });
    expect(published).toEqual({ ok: false, reason: 'template_unapproved' });
  });
});

describe('one draft per sequence (11.1)', () => {
  it('answers a second draft request with the draft already there, and gives it the steps asked for', async () => {
    const sequence = await createSequence(contextFor('alpha', 'admin'), { name: `Second draft ${String(Date.now())}` });
    if (!sequence.ok) throw new Error(`the sequence was refused: ${sequence.reason}`);
    const first = await createDraftVersion(contextFor('alpha', 'admin'), { sequenceId: sequence.value.id });
    if (!first.ok) throw new Error(`the draft was refused: ${first.reason}`);

    // No steps: the same draft, unchanged. Until 26 September 2026 this raised
    // sequence_versions_one_draft, which the API answered as a 500.
    expect(await createDraftVersion(contextFor('alpha', 'admin'), { sequenceId: sequence.value.id })).toEqual(first);

    const call = {
      ordinal: 1,
      channel: 'call_task' as const,
      delay: { unit: 'elapsed' as const, hours: 0 },
      onNoAnswer: 'advance' as const,
    };
    expect(await createDraftVersion(contextFor('alpha', 'admin'), { sequenceId: sequence.value.id, steps: [call] })).toEqual(
      first,
    );
    const draft = await readSequenceVersion(contextFor('alpha', 'admin'), first.value.sequenceVersionId);
    expect(draft?.state).toBe('draft');
    expect(draft?.steps.map(step => step.channel)).toEqual(['call_task']);
  });
});

describe('templates edit in place (wave 2, S3)', () => {
  const text = (opening: string) => ({
    name: 'Edited in place',
    subject: 'Following up',
    body: fixtureBody(opening),
    footer: { signOff: FIXTURE_SIGN_OFF },
    requiredVariables: [],
  });

  async function approvedTemplate(opening: string): Promise<string> {
    const created = await createTemplateVersion(contextFor('alpha', 'admin'), { ...text(opening), approve: true });
    if (!created.ok) throw new Error(`the template was refused: ${created.reason}`);
    expect(created.value.approvedAt).not.toBeNull();
    return created.value.id;
  }

  it('saves and approves a new template in one command', async () => {
    const created = await createTemplateVersion(contextFor('alpha', 'admin'), { ...text('One command.'), approve: true });
    if (!created.ok) throw new Error(`the template was refused: ${created.reason}`);
    expect(created.value).toMatchObject({ approvedAt: expect.any(String) as unknown as string, issues: [] });
    const refused = await createTemplateVersion(contextFor('alpha', 'admin'), {
      ...text('ignored'),
      body: 'No footer.',
      approve: true,
    });
    expect(refused).toEqual({ ok: false, reason: 'template_unapproved', issues: ['template_footer_missing'] });
  });

  it('keeps the approval when the edited text passes every rule, and recomputes the hash', async () => {
    const id = await approvedTemplate('The first wording.');
    const before = await readTemplateVersion(contextFor('alpha', 'admin'), id);
    const edited = await updateTemplateVersion(contextFor('alpha', 'admin'), { ...text('A typo, fixed.'), templateVersionId: id });
    if (!edited.ok) throw new Error(`the edit was refused: ${edited.reason}`);
    expect(edited.value).toMatchObject({
      id,
      version: before?.version,
      body: fixtureBody('A typo, fixed.'),
      approvedAt: before?.approvedAt,
      issues: [],
    });
    expect(edited.value.contentHash).not.toBe(before?.contentHash);
  });

  it('drops the approval when a plain save breaks a rule, and says which', async () => {
    const id = await approvedTemplate('Approved wording.');
    const edited = await updateTemplateVersion(contextFor('alpha', 'admin'), {
      ...text('ignored'),
      body: 'The footer went missing.',
      templateVersionId: id,
    });
    if (!edited.ok) throw new Error(`the edit was refused: ${edited.reason}`);
    expect(edited.value).toMatchObject({ approvedAt: null, issues: ['template_footer_missing'] });
  });

  it('refuses a save and approve that breaks a rule, and leaves the live text as it was', async () => {
    const id = await approvedTemplate('Live wording.');
    const before = await readTemplateVersion(contextFor('alpha', 'admin'), id);
    const refused = await updateTemplateVersion(contextFor('alpha', 'admin'), {
      ...text('ignored'),
      body: 'No footer, {nobody_knows_this}.',
      templateVersionId: id,
      approve: true,
    });
    expect(refused).toEqual({
      ok: false,
      reason: 'template_unapproved',
      issues: ['template_footer_missing', 'template_unknown_variable'],
    });
    expect(await readTemplateVersion(contextFor('alpha', 'admin'), id)).toEqual(before);
  });

  it('approves an unapproved version with save and approve, and refuses a salesperson, a retired version and an unsubscribe link', async () => {
    const created = await createTemplateVersion(contextFor('alpha', 'admin'), text('Draft wording.'));
    if (!created.ok) throw new Error(`the template was refused: ${created.reason}`);
    expect(created.value.approvedAt).toBeNull();
    const approved = await updateTemplateVersion(contextFor('alpha', 'admin'), {
      ...text('Final wording.'),
      templateVersionId: created.value.id,
      approve: true,
    });
    expect(approved.ok && approved.value.approvedAt !== null).toBe(true);

    expect(
      await updateTemplateVersion(contextFor('alpha', 'salesperson'), { ...text('x'), templateVersionId: created.value.id }),
    ).toEqual({ ok: false, reason: 'admin_only' });
    expect(
      await updateTemplateVersion(contextFor('alpha', 'admin'), {
        ...text('Click unsubscribe to stop.'),
        templateVersionId: created.value.id,
      }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
    await database.session.query('UPDATE template_versions SET retired_at = now() WHERE id = $1', [created.value.id]);
    expect(
      await updateTemplateVersion(contextFor('alpha', 'admin'), { ...text('x'), templateVersionId: created.value.id }),
    ).toEqual({ ok: false, reason: 'template_retired' });
  });

  it('sends the edited text, byte for byte, from a step not yet prepared', async () => {
    const templateVersionId = sequences.alpha.template.templateVersionId;
    const enrollmentId = await enroll('alpha');
    // Monday 09:00 New York, inside the window.
    await setDue('alpha', enrollmentId, '2026-09-21T13:00:00Z');

    // The seeded template is edited in place while the enrollment's first step waits.
    const edited = await updateTemplateVersion(contextFor('alpha', 'admin'), {
      name: 'Seeded, edited',
      subject: 'Hello {firm_name}',
      body: fixtureBody('Edited after enrolment.'),
      footer: { signOff: FIXTURE_SIGN_OFF },
      requiredVariables: ['firm_name'],
      templateVersionId,
    });
    if (!edited.ok) throw new Error(`the edit was refused: ${edited.reason}`);
    expect(edited.value.approvedAt).not.toBeNull();

    const handoff = recordingSendHandoff();
    const outcome = await runDueStepExecution(worker(), {
      enrollmentId,
      now: '2026-09-21T13:00:00Z',
      eligibility: allowAllEligibility(),
      sendHandoff: handoff,
    });
    expect(outcome.kind).toBe('handed_to_send');
    const [request] = handoff.prepared;
    expect(request?.templateContentHash).toBe(edited.value.contentHash);
    // The rendered body is the approved body: nothing is appended or stripped at send.
    expect(request?.body).toBe(fixtureBody('Edited after enrolment.'));
    expect(request?.body.endsWith(`${FIXTURE_SIGN_OFF}\n${SENDING_STOP_LINE}`)).toBe(true);
  });

  it('never leaves an approved version without the footer: no setting waives the rule, and the rule is the guard', async () => {
    // Migration 0019 dropped the stop-line CHECK, so every path that grants or keeps an
    // approval must refuse a body that does not end with the sign-off and stop line.
    const bare = { ...text('ignored'), body: 'Just the words, no footer.' };
    expect(await createTemplateVersion(contextFor('alpha', 'admin'), { ...bare, approve: true })).toEqual({
      ok: false,
      reason: 'template_unapproved',
      issues: ['template_footer_missing'],
    });
    const draft = await createTemplateVersion(contextFor('alpha', 'admin'), bare);
    if (!draft.ok) throw new Error(`the draft was refused: ${draft.reason}`);
    expect(draft.value).toMatchObject({ approvedAt: null, issues: ['template_footer_missing'] });
    expect(await approveTemplateVersion(contextFor('alpha', 'admin'), { templateVersionId: draft.value.id })).toEqual({
      ok: false,
      reason: 'template_unapproved',
      issues: ['template_footer_missing'],
    });
    const id = await approvedTemplate('Approved, then stripped.');
    expect(
      await updateTemplateVersion(contextFor('alpha', 'admin'), { ...bare, templateVersionId: id, approve: true }),
    ).toMatchObject({ ok: false, reason: 'template_unapproved' });
    const stripped = await updateTemplateVersion(contextFor('alpha', 'admin'), { ...bare, templateVersionId: id });
    expect(stripped.ok && stripped.value.approvedAt).toBeNull();

    const { rows } = await database.session.query<{ count: string }>(
      `SELECT count(*) AS count FROM template_versions
        WHERE approved_at IS NOT NULL AND right(body, length($1)) <> $1`,
      [SENDING_STOP_LINE],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });
});

describe('published steps edit in place (wave 2, S3)', () => {
  const emailStep = () => ({
    ordinal: 1,
    channel: 'email' as const,
    delay: { unit: 'elapsed' as const, hours: 0 },
    templateVersionId: sequences.alpha.template.templateVersionId,
  });
  const callStep = (ordinal: number, days: number) => ({
    ordinal,
    channel: 'call_task' as const,
    delay: { unit: 'business_days' as const, days },
    onNoAnswer: 'advance' as const,
  });

  async function publishedPlan(): Promise<string> {
    const sequence = await createSequence(contextFor('alpha', 'admin'), { name: `Edited plan ${String(Date.now())}` });
    if (!sequence.ok) throw new Error(`the sequence was refused: ${sequence.reason}`);
    const draft = await createDraftVersion(contextFor('alpha', 'admin'), {
      sequenceId: sequence.value.id,
      steps: [emailStep(), callStep(2, 3)],
    });
    if (!draft.ok) throw new Error(`the draft was refused: ${draft.reason}`);
    const published = await publishVersion(contextFor('alpha', 'admin'), { sequenceVersionId: draft.value.sequenceVersionId });
    if (!published.ok) throw new Error(`the publication was refused: ${published.reason}`);
    return draft.value.sequenceVersionId;
  }

  it('updates a published step in place and adds one, keeping the step rows live enrollments point at', async () => {
    const versionId = await publishedPlan();
    const before = await readSequenceVersion(contextFor('alpha', 'admin'), versionId);
    const saved = await saveSteps(contextFor('alpha', 'admin'), {
      sequenceVersionId: versionId,
      steps: [emailStep(), callStep(2, 9), callStep(3, 2)],
    });
    expect(saved).toEqual({ ok: true, value: { steps: 3 } });
    const after = await readSequenceVersion(contextFor('alpha', 'admin'), versionId);
    expect(after?.state).toBe('published');
    expect(after?.steps.map(step => step.id).slice(0, 2)).toEqual(before?.steps.map(step => step.id));
    expect(after?.steps[1]?.delay).toEqual({ unit: 'business_days', days: 9 });
    expect(after?.steps).toHaveLength(3);
  });

  it('refuses to change the channel of, or remove, a step something has executed', async () => {
    const enrollmentId = await enroll('alpha');
    expect(enrollmentId).toBeTruthy();
    const versionId = sequences.alpha.publishedVersionId;
    const before = await readSequenceVersion(contextFor('alpha', 'admin'), versionId);
    // The enrollment's first execution names step 1.
    expect(
      await saveSteps(contextFor('alpha', 'admin'), { sequenceVersionId: versionId, steps: [callStep(1, 0), callStep(2, 3)] }),
    ).toEqual({ ok: false, reason: 'step_in_use' });
    expect(await readSequenceVersion(contextFor('alpha', 'admin'), versionId)).toEqual(before);
  });

  it('holds a published edit to what publication checks, and refuses a retired version', async () => {
    const versionId = await publishedPlan();
    expect(await saveSteps(contextFor('alpha', 'admin'), { sequenceVersionId: versionId, steps: [] })).toEqual({
      ok: false,
      reason: 'version_has_no_steps',
    });
    const unapproved = await createTemplateVersion(contextFor('alpha', 'admin'), {
      name: 'Not yet',
      subject: 'Hello',
      body: fixtureBody('Not approved.'),
      footer: { signOff: FIXTURE_SIGN_OFF },
      requiredVariables: [],
    });
    if (!unapproved.ok) throw new Error(`the template was refused: ${unapproved.reason}`);
    expect(
      await saveSteps(contextFor('alpha', 'admin'), {
        sequenceVersionId: versionId,
        steps: [{ ...emailStep(), templateVersionId: unapproved.value.id }],
      }),
    ).toEqual({ ok: false, reason: 'template_unapproved' });
    expect(await saveSteps(contextFor('alpha', 'salesperson'), { sequenceVersionId: versionId, steps: [emailStep()] })).toEqual({
      ok: false,
      reason: 'admin_only',
    });

    expect((await retireVersion(contextFor('alpha', 'admin'), { sequenceVersionId: versionId })).ok).toBe(true);
    expect(await saveSteps(contextFor('alpha', 'admin'), { sequenceVersionId: versionId, steps: [emailStep()] })).toEqual({
      ok: false,
      reason: 'version_retired',
    });
  });
});

describe('the holiday calendar is versioned, never edited (11.2)', () => {
  it('supersedes the current one and refuses a version already used', async () => {
    const context = contextFor('beta', 'admin');
    const recorded = await recordHolidayCalendar(context, {
      version: 'holidays.2027',
      dates: ['2027-01-01'],
    });
    expect(recorded.ok).toBe(true);

    const again = await recordHolidayCalendar(context, {
      version: 'holidays.2027',
      dates: ['2027-01-01'],
    });
    expect(again).toEqual({ ok: false, reason: 'calendar_version_taken' });

    const bySalesperson = await recordHolidayCalendar(contextFor('beta', 'salesperson'), {
      version: 'holidays.2028',
      dates: [],
    });
    expect(bySalesperson).toEqual({ ok: false, reason: 'admin_only' });
  });
});
