import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repositoryContext, workspaceScope } from '@fss/domain/db';
import { openHold, releaseHold } from '@fss/domain/policy';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from '../support/authFixture.ts';
import { issueSessionFor } from '../support/sessionFixture.ts';
import { createCrmBridge } from '../../../desktop/src/main/crmBridge.ts';
import { createSequenceBridge } from '../../../desktop/src/main/sequenceBridge.ts';
import { buildFirmWorkspaceView } from '../../../desktop/src/renderer/firmWorkspaceView.ts';
import { sequenceScreen, suggestedPlan } from '../../../desktop/src/renderer/sequenceView.ts';
import { desktopClient } from '../support/wireThrough.ts';

/**
 * A founder authors a sequence, starts a firm on it, and reviews a long hold before
 * resuming it — all from the Mac (release.md 8.0au; lane g88, audit G03, G06, C20 and the
 * route-usability gap lane g84 reported).
 *
 * Until g88 the sequence editor could show a sequence and could not make one: `saveDraft`
 * was declared, exposed by the preload script and registered by nobody, there was no way
 * to write a template, and nothing on the Mac enrolled anybody. A firm added from the Mac
 * had only `candidate` numbers, which no dial may use. "Review and resume" resumed at once
 * and showed nothing. And clearing a contact's title — like every contact save — was a
 * 400, because the bridge sent the fields beside `contactId` instead of in the `patch` the
 * route reads.
 *
 * This check drives the shipped sequence and CRM bridges through the real routes over a
 * real PostgreSQL, in the order a founder meets them, and asks the database what landed.
 *
 * ## The vacuous-pass traps, named
 *
 * **A plan that publishes itself.** The suggested plan fills the editor; the check
 * requires the version to still be a draft after saving it, and published only after
 * Publish.
 *
 * **An enrolment that looks like it worked.** The enrolment is read back from
 * `sequence_enrollments` with its first step, not from the notice.
 *
 * **A review that agrees with a resume that moved nothing.** The enrollment lived through
 * a released nine-day pause; the review must move its step, and the confirmation must put
 * it exactly where the review said.
 *
 * **A cleared title that was never sent.** The title is set, then cleared through the
 * bridge, and read back from `contacts` as null.
 */

describe('8.0au: a founder authors, enrols, confirms a number and reviews a resume from the Mac (lane g88)', () => {
  let fixture: AuthFixture;
  let adminToken = '';
  let firmId = '';
  let contactId = '';
  let sequenceVersionId = '';
  let enrollmentId = '';

  const session = () => ({
    state: async () => await Promise.resolve({ online: true, mayMutate: true, device: { role: 'admin' as const } }),
  });
  const sequences = () =>
    createSequenceBridge({
      api: desktopClient(fixture, adminToken),
      session: session(),
    });
  const crm = () => createCrmBridge({ api: desktopClient(fixture, adminToken), clientVersion: CURRENT_CLIENT_VERSION, session: session() });

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('creates a sequence with a draft, writes and approves a template, fills the suggested plan and publishes it', async () => {
    const bridge = sequences();
    let state = await bridge.createSequence({ name: 'Founder plan' });
    expect(state.notice).toBe('sequence_created');
    expect(state.sequences.map(entry => entry.name)).toEqual(['Founder plan']);
    expect(state.versions.map(version => [version.version, version.state, version.steps.length])).toEqual([[1, 'draft', 0]]);
    const draftId = state.versions[0]?.id ?? '';

    state = await bridge.createTemplate({
      templateId: null,
      name: 'First touch',
      subject: 'A question for {firm_name}',
      body: 'Hello {contact_first_name},\n\nA short note about {firm_name}.',
      signOff: 'David\nCallie',
    });
    expect(state.notice).toBe('template_created');
    const template = state.templates[0];
    expect(template?.approvedAt).toBeNull();
    expect(template?.requiredVariables).toEqual(['firm_name', 'contact_first_name']);
    state = await bridge.approveTemplate({ templateVersionId: template?.id ?? '' });
    expect(state.notice).toBe('template_approved');

    const plan = suggestedPlan(state.templates);
    expect(plan.map(step => [step.channel, step.templateVersionId])).toEqual([
      ['call_task', null],
      ['email', template?.id],
      ['call_task', null],
    ]);
    state = await bridge.saveDraft({ sequenceVersionId: draftId, steps: plan });
    expect(state.notice).toBe('draft_saved');
    // Saved, and still a draft: nothing publishes itself.
    expect(state.versions.map(version => [version.state, version.steps.map(step => [step.ordinal, step.channel])])).toEqual([
      ['draft', [[1, 'call_task'], [2, 'email'], [3, 'call_task']]],
    ]);
    expect(sequenceScreen(state).versions[0]?.canPublish).toBe(true);

    state = await bridge.publish({ sequenceVersionId: draftId });
    expect(state.notice).toBe('published');
    expect(state.versions[0]?.state).toBe('published');
    sequenceVersionId = draftId;
  });

  it('adds a firm, confirms its number, puts it in the pipeline and enrols its contact', async () => {
    const bridge = crm();
    await bridge.openAddFirm();
    let state = await bridge.addFirm({
      name: 'Aspen Test Wealth',
      website: 'aspen.example.test',
      timeZone: 'America/New_York',
      contactName: 'Kim Placeholder',
      contactTitle: 'Principal',
      contactEmail: 'kim@aspen.example.test',
      contactPhone: '401 555 0121',
    });
    expect(state.notice).toBe('firm_added');
    const page = state.firm;
    if (page?.visibility !== 'assigned_or_admin' || page.read.visibility !== 'assigned_or_admin') throw new Error('no detail');
    firmId = page.read.firm.id;
    contactId = page.read.firm.contacts[0]?.id ?? '';
    // Usable on entry since wave 2 (S4.4): no confirmation needed.
    const number = page.read.firm.phoneRoutes[0];
    expect([number?.eligibility, number?.version]).toEqual(['usable', 1]);

    // The installed desktop's Confirm still answers, and moves nothing.
    state = await bridge.confirmRoute({ routeId: number?.id ?? '', routeVersion: 1 });
    expect(state.notice).toBe('route_confirmed');
    const { rows: routes } = await fixture.db.query<{ eligibility: string; version: number; technical_validation: string }>(
      'SELECT eligibility, version, technical_validation FROM phone_routes WHERE workspace_id = $1 AND id = $2',
      [fixture.alpha.workspaceId, number?.id],
    );
    expect(routes[0]).toEqual({ eligibility: 'usable', version: 1, technical_validation: 'passed' });

    // No opportunity yet: the page offers "Add to pipeline", and enrolling is refused here.
    expect(state.firm?.visibility === 'assigned_or_admin' ? state.firm.opportunity : 'redacted').toBeNull();
    expect(state.sequences?.published.map(entry => entry.label)).toEqual(['Founder plan v1']);
    state = await bridge.enroll({ sequenceVersionId, contactId });
    expect(state.notice).toBe('opportunity_not_open');

    state = await bridge.openOpportunity();
    expect(state.notice).toBe('opportunity_opened');
    state = await bridge.enroll({ sequenceVersionId, contactId });
    expect(state.notice).toBe('enrolled');
    expect(buildFirmWorkspaceView(state).banners.map(banner => banner.text)).toContain('Enrolled. The first step is on its way to Today.');
    expect(state.sequences?.enrollments.map(entry => [entry.contactId, entry.label, entry.state])).toEqual([
      [contactId, 'Founder plan v1', 'active'],
    ]);

    const { rows } = await fixture.db.query<{ id: string; channel: string }>(
      `SELECT e.id, x.channel FROM sequence_enrollments e
         JOIN step_executions x ON x.workspace_id = e.workspace_id AND x.enrollment_id = e.id
        WHERE e.workspace_id = $1 AND e.contact_id = $2`,
      [fixture.alpha.workspaceId, contactId],
    );
    expect(rows.map(row => row.channel)).toEqual(['call_task']);
    enrollmentId = rows[0]?.id ?? '';
  });

  it('clears a contact’s title with the explicit null the patch reads (C20)', async () => {
    const bridge = crm();
    await bridge.openFirm({ firmId });
    const saved = await bridge.saveContact({ contactId, fullName: 'Kim Placeholder', title: null, makePrimary: false });
    expect(saved.notice).toBe('saved');
    const { rows } = await fixture.db.query<{ title: string | null }>('SELECT title FROM contacts WHERE id = $1', [contactId]);
    expect(rows[0]?.title).toBeNull();
  });

  it('shows the dates a resume gives the steps after a long hold, and resumes only when confirmed', async () => {
    // Ten days in, a nine-day pause of the firm, released; an older release's automatic
    // reconsideration left the enrollment in review. Since wave 2 (S4.1) the scheduler
    // resumes such a row on its own; the installed desktop's review still works on it.
    await fixture.db.query(`UPDATE sequence_enrollments SET started_at = now() - interval '10 days' WHERE id = $1`, [enrollmentId]);
    const admin = repositoryContext(
      workspaceScope(fixture.alpha.workspaceId, { kind: 'user', userId: fixture.alpha.admin.userId, role: 'admin' }),
      fixture.db,
    );
    const hold = await openHold(admin, {
      scopeKind: 'firm',
      scopeKey: firmId,
      reasonCode: 'scoped_pause',
      blockedActionKinds: ['call_task', 'enrollment_advance'],
      sourceEventKind: 'test.g88',
    });
    await fixture.db.query(`UPDATE active_holds SET started_at = now() - interval '9 days' WHERE id = $1`, [hold]);
    await releaseHold(admin, hold);
    await fixture.db.query(
      `UPDATE sequence_enrollments SET state = 'review_required', review_union_milliseconds = $2 WHERE id = $1`,
      [enrollmentId, 9 * 86_400_000],
    );

    const bridge = sequences();
    let state = await bridge.state();
    expect(state.heldEnrollments.map(entry => entry.id)).toEqual([enrollmentId]);

    // Pressing Resume without a review opens the review, and resumes nothing.
    state = await bridge.resumeEnrollment({ enrollmentId });
    expect(state.resumeReview?.preview.enrollmentId).toBe(enrollmentId);
    expect(state.heldEnrollments.map(entry => entry.id)).toEqual([enrollmentId]);
    const review = state.resumeReview?.preview;
    expect(review?.kind).toBe('resume');
    const proposed = review?.steps.map(step => step.proposedDueAt) ?? [];
    expect(proposed).toHaveLength(1);
    const moved = Date.parse(proposed[0] ?? '') - Date.parse(review?.steps[0]?.dueAt ?? '');
    expect(moved / 86_400_000).toBeGreaterThan(8.9);
    const panel = sequenceScreen(state).resumeReview;
    expect(panel?.canConfirm).toBe(true);
    expect(panel?.steps[0]?.moved).toBe(true);

    state = await bridge.resumeEnrollment({ enrollmentId });
    expect(state.notice).toBe('resumed');
    expect(state.resumeReview).toBeNull();
    expect(state.heldEnrollments).toEqual([]);
    const { rows } = await fixture.db.query<{ due_at: Date }>(
      `SELECT due_at FROM step_executions WHERE enrollment_id = $1 AND state IN ('pending', 'held') ORDER BY ordinal`,
      [enrollmentId],
    );
    expect(rows.map(row => row.due_at.toISOString())).toEqual(proposed);
  });
});
