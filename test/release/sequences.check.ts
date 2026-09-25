import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SENDING_STOP_LINE,
  enrollmentsResponseSchema,
  linkedInHandoffResultSchema,
  mayMutate,
  sequenceVersionsResponseSchema,
  sequencesResponseSchema,
  templateVersionsResponseSchema,
  wireDrift,
} from '@fss/contracts';
import { CONTAINER_CLIENT_VERSIONS } from '../../apps/api/src/bootstrap/main.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from '../../apps/api/test/support/authFixture.ts';
import { issueSessionFor } from '../../apps/api/test/support/sessionFixture.ts';
import { createSequenceBridge } from '../../apps/desktop/src/main/sequenceBridge.ts';
import { sequenceScreen } from '../../apps/desktop/src/renderer/sequenceView.ts';
import {
  emailStepAnswer,
  enrollmentAnswer,
  linkedInHandoffAnswer,
  linkedInStepAnswer,
  sequenceSummaryAnswer,
  sequenceVersionAnswer,
  templateVersionAnswer,
} from '../../apps/desktop/test/support/sequenceAnswers.ts';
import { DESKTOP_VERSION_UNDER_TEST, desktopClient, routeAnswer, shapeOf } from './support/wireThrough.ts';

/**
 * The sequence editor reads what the API sends (release.md 8.0aj; lane g78, audit items
 * D01, D02, D06, T04).
 *
 * Desktop 1.0.4 could not read a single populated version or enrollment list. The API
 * puts `sequenceVersionId` on every step (`toStep`, `packages/domain/sequences/rows.ts`)
 * and the desktop's strict step schema forbade it; the API sends thirteen enrollment
 * fields and the desktop's strict schema knew nine. Every such answer became
 * `unreadable_answer`, the bridge turned it into an empty list, and the window drew a
 * workspace with no versions and nobody enrolled. Production has had no sequences yet,
 * which is the only reason nobody saw it.
 *
 * ## The vacuous-pass traps, named
 *
 * **A fixture that agrees with the parser.** That is the defect itself: the unit
 * suite's steps had no `sequenceVersionId` either (T04). The route's own answer goes
 * through the desktop's own bridge here, and the unit fixtures in
 * `apps/desktop/test/support/sequenceAnswers.ts` are held to the route's answers key
 * for key and type for type.
 *
 * **An empty list parses.** `{ versions: [] }` passes any version schema, so the version
 * here has two steps, one of each kind the editor renders, and the enrollment list has
 * a live enrollment and one waiting for review.
 *
 * **A parse that fails into an empty list.** That is D06: the check asserts no slice is
 * unread, so a read that failed cannot pass as a read that found nothing.
 */

const SIGN_OFF = 'Sam Example\nCallie';
const NINE_DAYS = 9 * 86_400_000;

describe('8.0aj: the sequence editor reads a populated version and its enrollments (lane g78)', () => {
  let fixture: AuthFixture;
  let adminToken = '';
  let salespersonToken = '';
  let firmId = '';
  let opportunityId = '';
  let templateVersionId = '';
  let sequenceId = '';
  let sequenceVersionId = '';
  let heldEnrollmentId = '';
  let linkedInExecutionId = '';

  const command = (extra: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });
  const result = (answer: { body: unknown }): Record<string, unknown> =>
    ((answer.body as { result?: unknown }).result ?? {}) as Record<string, unknown>;
  const post = async (path: string, token: string, body: Readonly<Record<string, unknown>>) =>
    await routeAnswer(fixture, 'POST', path, token, body);

  const contact = async (fullName: string): Promise<string> => {
    const created = await post('/contacts/create', salespersonToken, command({ firmId, fullName }));
    expect(created.status).toBe(200);
    return String(result(created)['id']);
  };

  const bridgeFor = (token: string, role: 'admin' | 'salesperson', copied: string[] = []) =>
    createSequenceBridge({
      api: desktopClient(fixture, token),
      session: { state: async () => await Promise.resolve({ online: true, mayMutate: true, device: { role } }) },
      copyToClipboard: text => copied.push(text),
      openExternally: async () => {
        await Promise.resolve();
      },
    });

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson, { deviceLabel: 'Sales Mac' }))
      .accessToken;

    const firm = await post(
      '/firms/create',
      adminToken,
      command({ name: 'Northwind Test Holdings', regionCode: 'RI', postalCode: '02903', assignedUserId: fixture.alpha.salesperson.userId }),
    );
    expect(firm.status).toBe(200);
    firmId = String(result(firm)['id']);
    await fixture.db.query(
      `UPDATE firms SET time_zone = 'America/New_York', time_zone_confidence = 'high',
              time_zone_source = 'postal', time_zone_rule_version = 'firm-zone.1'
        WHERE workspace_id = $1 AND id = $2`,
      [fixture.alpha.workspaceId, firmId],
    );
    const opened = await post('/opportunities/open', salespersonToken, command({ firmId }));
    expect(opened.status).toBe(200);
    opportunityId = String(result(opened)['id']);

    const template = await post(
      '/templates/create',
      adminToken,
      command({
        name: 'First touch',
        subject: 'A question about {firm_name}',
        body: `Hello {contact_first_name},\n\nA note about {firm_name}.\n\n${SIGN_OFF}\n${SENDING_STOP_LINE}`,
        footerSignOff: SIGN_OFF,
        requiredVariables: ['firm_name', 'contact_first_name'],
      }),
    );
    templateVersionId = String(result(template)['id']);
    expect((await post('/templates/approve', adminToken, command({ templateVersionId }))).status).toBe(200);

    // The version the editor draws: an email step and a LinkedIn step, published.
    const sequence = await post('/sequences/create', adminToken, command({ name: 'Founding outreach' }));
    sequenceId = String(result(sequence)['id']);
    const draft = await post(
      '/sequences/versions/draft',
      adminToken,
      command({
        sequenceId,
        steps: [
          { ordinal: 1, channel: 'email', delay: { unit: 'elapsed', hours: 0 }, templateVersionId },
          { ordinal: 2, channel: 'linkedin_task', delay: { unit: 'business_days', days: 2 }, linkedInMessage: 'A short note.' },
        ],
      }),
    );
    sequenceVersionId = String(result(draft)['sequenceVersionId']);
    expect((await post('/sequences/versions/publish', adminToken, command({ sequenceVersionId }))).status).toBe(200);

    // Two enrollments: one live, one past the long-hold review threshold (4.3).
    const live = await post(
      '/enrollments/enroll',
      salespersonToken,
      command({ sequenceVersionId, opportunityId, firmId, contactId: await contact('Dana Example') }),
    );
    expect(live.status).toBe(200);
    const held = await post(
      '/enrollments/enroll',
      salespersonToken,
      command({ sequenceVersionId, opportunityId, firmId, contactId: await contact('Robin Example') }),
    );
    expect(held.status).toBe(200);
    heldEnrollmentId = String(result(held)['enrollmentId']);
    await fixture.db.query(
      `UPDATE sequence_enrollments SET state = 'review_required', review_union_milliseconds = $3
        WHERE workspace_id = $1 AND id = $2`,
      [fixture.alpha.workspaceId, heldEnrollmentId, NINE_DAYS],
    );

    // A LinkedIn-first sequence, so a handoff exists to complete.
    const linkedIn = await post('/sequences/create', adminToken, command({ name: 'LinkedIn first' }));
    const linkedInDraft = await post(
      '/sequences/versions/draft',
      adminToken,
      command({
        sequenceId: String(result(linkedIn)['id']),
        steps: [{ ordinal: 1, channel: 'linkedin_task', delay: { unit: 'elapsed', hours: 0 }, linkedInMessage: 'Hello from Callie.' }],
      }),
    );
    const linkedInVersionId = String(result(linkedInDraft)['sequenceVersionId']);
    expect((await post('/sequences/versions/publish', adminToken, command({ sequenceVersionId: linkedInVersionId }))).status).toBe(200);
    const linkedInEnrolled = await post(
      '/enrollments/enroll',
      salespersonToken,
      command({ sequenceVersionId: linkedInVersionId, opportunityId, firmId, contactId: await contact('Lee Example') }),
    );
    const steps = await post('/enrollments/steps', salespersonToken, { enrollmentId: String(result(linkedInEnrolled)['enrollmentId']) });
    linkedInExecutionId = String((steps.body as { steps: { id: string }[] }).steps[0]?.id ?? '');
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('renders the version with both steps and the held enrollment, and nothing unread', async () => {
    const bridge = bridgeFor(adminToken, 'admin');
    await bridge.openSequence({ sequenceId });
    const state = await bridge.state();

    expect(state.readErrors).toEqual({ sequences: null, versions: null, templates: null, enrollments: null });
    expect(state.selectedSequenceId).toBe(sequenceId);
    expect(state.versions.map(version => version.id)).toEqual([sequenceVersionId]);
    expect(state.versions[0]?.steps.map(step => step.sequenceVersionId)).toEqual([sequenceVersionId, sequenceVersionId]);
    expect(state.heldEnrollments.map(entry => entry.id)).toEqual([heldEnrollmentId]);
    expect(state.heldEnrollments[0]).toMatchObject({ opportunityId, firmTimeZone: 'America/New_York' });
    expect(state.asOf).not.toBeNull();

    const screen = sequenceScreen(state);
    expect(screen.unread).toEqual([]);
    expect(screen.versions.map(panel => panel.heading)).toEqual(['Version 1 — published']);
    expect(screen.versions[0]?.steps.map(step => [step.ordinal, step.detail, step.problem])).toEqual([
      [1, 'Template email', null],
      [2, 'LinkedIn task, opened and copied by hand', null],
    ]);
    expect(screen.templates.map(panel => [panel.label, panel.approved])).toEqual([['First touch v1', true]]);
    expect(screen.holdReview.map(row => [row.enrollmentId, row.heldForDays])).toEqual([[heldEnrollmentId, 9]]);
  });

  it('hands off a LinkedIn step through the real route and copies the frozen text', async () => {
    const copied: string[] = [];
    const bridge = bridgeFor(salespersonToken, 'salesperson', copied);
    const state = await bridge.completeLinkedIn({ stepExecutionId: linkedInExecutionId });
    expect(state.notice).toBe('Message copied. This contact has no usable LinkedIn profile to open.');
    expect(copied).toEqual(['Hello from Callie.']);
    expect(state.linkedInCard).toMatchObject({ stepExecutionId: linkedInExecutionId, handedOff: true });
    expect(sequenceScreen(state).linkedIn?.statusLabel).toBe('Handed off — FSS does not know whether it was sent');
  });

  it('holds the desktop’s unit fixtures to the routes: the same keys, the same types, all the way down', async () => {
    const sequences = await routeAnswer(fixture, 'GET', '/sequences', adminToken);
    expect(wireDrift(sequencesResponseSchema, sequences.body)).toEqual([]);
    const summary = (sequences.body as { sequences: unknown[] }).sequences[0];
    expect(shapeOf(summary)).toEqual(shapeOf(sequenceSummaryAnswer()));

    const versions = await routeAnswer(fixture, 'POST', '/sequences/versions', adminToken, { sequenceId });
    expect(wireDrift(sequenceVersionsResponseSchema, versions.body)).toEqual([]);
    const version = (versions.body as { versions: unknown[] }).versions[0];
    expect(shapeOf(version)).toEqual(
      shapeOf(
        sequenceVersionAnswer([emailStepAnswer(templateVersionId), linkedInStepAnswer()], {
          state: 'published',
          publishedAt: '2026-09-25T12:00:00.000Z',
        }),
      ),
    );

    const templates = await routeAnswer(fixture, 'POST', '/templates', adminToken, {});
    expect(wireDrift(templateVersionsResponseSchema, templates.body)).toEqual([]);
    expect(shapeOf((templates.body as { templates: unknown[] }).templates[0])).toEqual(
      shapeOf(templateVersionAnswer({ requiredVariables: ['firm_name', 'contact_first_name'] })),
    );

    const enrollments = await routeAnswer(fixture, 'POST', '/enrollments', salespersonToken, {});
    expect(wireDrift(enrollmentsResponseSchema, enrollments.body)).toEqual([]);
    const rows = (enrollments.body as { enrollments: { id: string; state: string }[] }).enrollments;
    const liveRow = rows.find(row => row.state === 'active');
    const heldRow = rows.find(row => row.id === heldEnrollmentId);
    expect(shapeOf(liveRow)).toEqual(shapeOf(enrollmentAnswer()));
    expect(shapeOf(heldRow)).toEqual(shapeOf(enrollmentAnswer({ state: 'review_required', reviewUnionMilliseconds: NINE_DAYS })));

    // The two fields the defects were about, said outright.
    expect(Object.keys((version as { steps: object[] }).steps[0] ?? {})).toContain('sequenceVersionId');
    expect(Object.keys(liveRow ?? {})).toEqual(expect.arrayContaining(['opportunityId', 'assignedUserId', 'firmTimeZone', 'holidayCalendarVersion']));
  });

  it('holds the handoff fixture to the route’s answer', async () => {
    // A second LinkedIn enrollment, so there is a pending step to complete here too.
    const another = await contact('Kim Example');
    const versions = await routeAnswer(fixture, 'GET', '/sequences', adminToken);
    const linkedInSequence = (versions.body as { sequences: { id: string; name: string }[] }).sequences.find(
      entry => entry.name === 'LinkedIn first',
    );
    const published = await routeAnswer(fixture, 'POST', '/sequences/versions', adminToken, { sequenceId: linkedInSequence?.id ?? '' });
    const versionId = (published.body as { versions: { id: string }[] }).versions[0]?.id ?? '';
    const enrolled = await post('/enrollments/enroll', salespersonToken, command({ sequenceVersionId: versionId, opportunityId, firmId, contactId: another }));
    const steps = await post('/enrollments/steps', salespersonToken, { enrollmentId: String(result(enrolled)['enrollmentId']) });
    const stepExecutionId = String((steps.body as { steps: { id: string }[] }).steps[0]?.id ?? '');

    const handoff = await post('/enrollments/linkedin/complete', salespersonToken, command({ stepExecutionId }));
    expect(handoff.status).toBe(200);
    expect(wireDrift(linkedInHandoffResultSchema, result(handoff))).toEqual([]);
    expect(shapeOf(result(handoff))).toEqual(shapeOf(linkedInHandoffAnswer({ linkedInUrl: null })));
  });

  it('is a build the deployed API accepts', () => {
    expect(mayMutate(CONTAINER_CLIENT_VERSIONS, DESKTOP_VERSION_UNDER_TEST)).toBe(true);
    expect(CONTAINER_CLIENT_VERSIONS.minimum).toBe('1.0.0');
  });
});
