import { describe, expect, it } from 'vitest';
import { SENDING_STOP_LINE } from '@fss/contracts';
import type { HttpAnswer } from '../src/main/apiClient.ts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { contactPatchBody, createCrmBridge } from '../src/main/crmBridge.ts';
import { createSequenceBridge } from '../src/main/sequenceBridge.ts';
import type { DraftStep, SequenceState } from '../src/renderer/sequenceContract.ts';
import {
  EMPTY_SEQUENCE_STATE,
  composeTemplateBody,
  draftChanged,
  draftIssues,
  draftStepsOf,
  moveStep,
  newStep,
  removeStep,
  resumeReviewPanel,
  sequenceNotice,
  sequenceScreen,
  stepsForWire,
  suggestedPlan,
  templateFormIssues,
  templateVariablesIn,
  typedBodyOf,
} from '../src/renderer/sequenceView.ts';
import { inertSentence, settingFields, settingSummary, settingValueFrom } from '../src/renderer/settingsView.ts';
import {
  SEQUENCE_IDS,
  emailStepAnswer,
  enrollmentAnswer,
  sequenceSummaryAnswer,
  sequenceVersionAnswer,
  templateVersionAnswer,
} from './support/sequenceAnswers.ts';

/**
 * Lane g88's desktop halves, without Electron: authoring a sequence (audit G03), the
 * resume review (G06), the Firm page's enrolment and number confirmation, the contact
 * patch (C20), and Settings' typed controls (G08).
 *
 * The view models are pure, so what the editor will and will not send is a function call
 * here. The bridges run over the real transport (`createAuthedClient`) against scripted
 * answers, so what is proved is the exact body each command sends and what the window is
 * given back.
 *
 * No real person, firm or number appears: `example.test` is reserved by RFC 6761.
 */

function scriptedApi(answers: Record<string, HttpAnswer | ((body: Record<string, unknown> | null) => HttpAnswer)>) {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  const api = createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: '1.0.6',
    accessToken: async () => await Promise.resolve('token-value'),
    send: async (url, init) => {
      const path = new URL(url).pathname;
      const body = init.body === undefined ? null : (JSON.parse(init.body) as Record<string, unknown>);
      calls.push({ path, body });
      const answer = answers[path];
      return await Promise.resolve(
        answer === undefined ? { status: 404, body: { error: 'not_found' } } : typeof answer === 'function' ? answer(body) : answer,
      );
    },
  });
  return { api, calls };
}

const accepted = (result: unknown): HttpAnswer => ({ status: 200, body: { status: 'accepted', replayed: false, result } });
const session = () => ({
  state: async () => await Promise.resolve({ online: true, mayMutate: true, device: { role: 'admin' as const } }),
});
const sequenceBridge = (api: ReturnType<typeof createAuthedClient>) =>
  createSequenceBridge({ api, session: session() });

const TEMPLATE = SEQUENCE_IDS.template;
const call = (days: number): DraftStep => ({
  channel: 'call_task',
  delay: { unit: 'business_days', days },
  onNoAnswer: 'advance',
  templateVersionId: null,
});
const email = (days: number, templateVersionId: string | null = TEMPLATE): DraftStep => ({
  channel: 'email',
  delay: { unit: 'business_days', days },
  onNoAnswer: null,
  templateVersionId,
});

// ---------------------------------------------------------------- the step editor
describe('the step editor (audit G03)', () => {
  it('adds a step two business days after the last, moves and removes steps, and numbers them on save', () => {
    const first = newStep('call_task', []);
    expect(first).toEqual(call(0));
    const second = newStep('email', [first]);
    expect(second).toEqual(email(2, null));
    const steps = [first, second, newStep('call_task', [first, second])];
    expect(steps[2]?.delay).toEqual({ unit: 'business_days', days: 4 });

    const moved = moveStep(steps, 2, -1);
    expect(moved.map(step => step.channel)).toEqual(['call_task', 'call_task', 'email']);
    expect(moveStep(steps, 0, -1)).toEqual(steps);
    expect(removeStep(steps, 1).map(step => step.channel)).toEqual(['call_task', 'call_task']);

    // Whatever order the person left them in, the ordinals are 1..n, and each step carries
    // only the field its channel takes — the route's step schema is strict.
    expect(stepsForWire([call(0), email(2), { ...call(4), onNoAnswer: 'retry_call' }])).toEqual([
      { ordinal: 1, channel: 'call_task', delay: { unit: 'business_days', days: 0 }, onNoAnswer: 'advance' },
      { ordinal: 2, channel: 'email', delay: { unit: 'business_days', days: 2 }, templateVersionId: TEMPLATE },
      { ordinal: 3, channel: 'call_task', delay: { unit: 'business_days', days: 4 }, onNoAnswer: 'retry_call' },
    ]);
  });

  it('suggests a call, an email and a call, naming the newest approved template', () => {
    const unapproved = templateVersionAnswer({ id: SEQUENCE_IDS.enrollment, approvedAt: null });
    const plan = suggestedPlan([unapproved, templateVersionAnswer()]);
    expect(plan.map(step => [step.channel, step.delay, step.templateVersionId])).toEqual([
      ['call_task', { unit: 'business_days', days: 0 }, null],
      ['email', { unit: 'business_days', days: 2 }, TEMPLATE],
      ['call_task', { unit: 'business_days', days: 4 }, null],
    ]);
    expect(suggestedPlan([unapproved])[1]?.templateVersionId).toBeNull();
  });

  it('says which step needs a template or a delay before saving, and nothing about an unapproved one', () => {
    expect(draftIssues([call(0), email(2, null)]).map(issue => issue.text)).toEqual(['Step 2: choose the template this email sends.']);
    expect(draftIssues([{ ...call(0), delay: { unit: 'business_days', days: 400 } }])[0]?.text).toContain('0 to 365 business days');
    expect(draftIssues([call(0), email(2)])).toEqual([]);
  });

  it('knows when the editor holds something the draft has not saved', () => {
    const version = sequenceVersionAnswer([emailStepAnswer(TEMPLATE, 1, { delay: { unit: 'business_days', days: 2 } })]);
    const steps = draftStepsOf(version);
    expect(steps).toEqual([email(2)]);
    expect(draftChanged(version, steps)).toBe(false);
    expect(draftChanged(version, [...steps, call(4)])).toBe(true);
  });

  it('offers "Edit as a new draft" on a published version only when no draft is open', () => {
    const published = sequenceVersionAnswer([emailStepAnswer(TEMPLATE)], { state: 'published', publishedAt: '2026-09-20T12:00:00.000Z' });
    const base: SequenceState = { ...EMPTY_SEQUENCE_STATE, online: true, mayMutate: true, isAdmin: true, templates: [templateVersionAnswer()] };
    expect(sequenceScreen({ ...base, versions: [published] }).versions[0]?.canStartDraft).toBe(true);
    const draft = sequenceVersionAnswer([], { id: SEQUENCE_IDS.firm, version: 2 });
    expect(sequenceScreen({ ...base, versions: [draft, published] }).versions.find(panel => panel.state === 'published')?.canStartDraft).toBe(false);
    expect(sequenceScreen({ ...base, versions: [published] }).versions[0]?.stopSentence).toContain('Stops by itself');
  });
});

// ------------------------------------------------------------------ the templates
describe('the template form (audit G03)', () => {
  const draft = { templateId: null, name: 'First touch', subject: 'A question for {firm_name}', body: 'Hello {contact_first_name},\n\nA note.', signOff: 'David\nCallie' };

  it('ends the email with the sign-off and the stop line, and gives the person back only what they typed', () => {
    const body = composeTemplateBody(draft.body, draft.signOff);
    expect(body).toBe(`Hello {contact_first_name},\n\nA note.\n\nDavid\nCallie\n${SENDING_STOP_LINE}`);
    expect(typedBodyOf({ body, footerSignOff: 'David\nCallie' })).toBe(draft.body);
    expect(templateVariablesIn(draft.subject, body)).toEqual({ known: ['firm_name', 'contact_first_name'], unknown: [] });
  });

  it('refuses a name-less form, an unknown variable, an unsubscribe link and a long email before sending', () => {
    expect(templateFormIssues(draft)).toEqual([]);
    expect(templateFormIssues({ ...draft, name: ' ' }).map(issue => issue.field)).toEqual(['name']);
    expect(templateFormIssues({ ...draft, body: 'Hi {first}' })[0]?.text).toContain('Callie cannot fill {first}');
    expect(templateFormIssues({ ...draft, body: 'Click to unsubscribe' })[0]?.text).toContain('unsubscribe');
    expect(templateFormIssues({ ...draft, body: 'word '.repeat(90) })[0]?.text).toContain('keep it to 89');
  });

  it('names every issue of a refused approval in words', () => {
    expect(sequenceNotice('template_unapproved:template_footer_missing,template_body_multiple_urls')).toBe(
      'Not approved. The email does not end with the sign-off and the stop line. The email has more than one link.',
    );
    expect(sequenceNotice('draft_saved')).toBe('Draft saved.');
    expect(sequenceNotice('Message copied.')).toBe('Message copied.');
  });
});

// -------------------------------------------------------------- the sequence bridge
describe('the sequence bridge authors through the commands (audit G03)', () => {
  const reads = {
    '/sequences': { status: 200, body: { sequences: [sequenceSummaryAnswer()] } },
    '/sequences/versions': { status: 200, body: { versions: [sequenceVersionAnswer([])] } },
    '/templates': { status: 200, body: { templates: [templateVersionAnswer()] } },
    '/enrollments': { status: 200, body: { asOf: '2026-09-25T13:00:00.000Z', enrollments: [] } },
  } satisfies Record<string, HttpAnswer>;

  it('creates the sequence, then its empty draft, and opens it', async () => {
    const { api, calls } = scriptedApi({
      ...reads,
      '/sequences/create': accepted({ id: SEQUENCE_IDS.sequence, name: 'Founding outreach', description: null, archivedAt: null }),
      '/sequences/versions/draft': accepted({ sequenceVersionId: SEQUENCE_IDS.version, version: 1 }),
    });
    const state = await sequenceBridge(api).createSequence({ name: 'Founding outreach' });
    expect(calls.slice(0, 2).map(entry => [entry.path, entry.body?.['name'] ?? entry.body?.['sequenceId'], entry.body?.['steps']])).toEqual([
      ['/sequences/create', 'Founding outreach', undefined],
      ['/sequences/versions/draft', SEQUENCE_IDS.sequence, []],
    ]);
    expect(state.selectedSequenceId).toBe(SEQUENCE_IDS.sequence);
    expect(state.notice).toBe('sequence_created');
  });

  it('saves a draft as numbered wire steps, and refuses a malformed one without a command', async () => {
    const { api, calls } = scriptedApi({ ...reads, '/sequences/versions/steps': accepted({ steps: 2 }) });
    const bridge = sequenceBridge(api);
    const saved = await bridge.saveDraft({ sequenceVersionId: SEQUENCE_IDS.version, steps: [call(0), email(2)] });
    expect(saved.notice).toBe('draft_saved');
    expect(calls.find(entry => entry.path === '/sequences/versions/steps')?.body).toMatchObject({
      sequenceVersionId: SEQUENCE_IDS.version,
      steps: stepsForWire([call(0), email(2)]),
    });

    calls.length = 0;
    const refused = await bridge.saveDraft({ sequenceVersionId: SEQUENCE_IDS.version, steps: [{ channel: 'fax' }] });
    expect(refused.notice).toBe('invalid_input');
    expect(calls.map(entry => entry.path)).not.toContain('/sequences/versions/steps');
  });

  it('writes a template with its footer and the variables it names', async () => {
    const { api, calls } = scriptedApi({ ...reads, '/templates/create': accepted(templateVersionAnswer({ approvedAt: null })) });
    const state = await sequenceBridge(api).createTemplate({
      templateId: null,
      name: ' First touch ',
      subject: 'A question for {firm_name}',
      body: 'Hello {contact_first_name},',
      signOff: 'David',
    });
    expect(state.notice).toBe('template_created');
    const body = calls.find(entry => entry.path === '/templates/create')?.body;
    expect(body).toMatchObject({
      name: 'First touch',
      subject: 'A question for {firm_name}',
      body: `Hello {contact_first_name},\n\nDavid\n${SENDING_STOP_LINE}`,
      footerSignOff: 'David',
      requiredVariables: ['firm_name', 'contact_first_name'],
    });
    expect(body).not.toHaveProperty('templateId');
  });

  it('reads a refused approval’s issues from its body, past the transport’s 80-character code', async () => {
    const reason = 'template_unapproved:template_body_multiple_urls,template_pricing_or_guarantee_language,template_body_markup';
    const { api } = scriptedApi({ ...reads, '/templates/approve': { status: 409, body: { status: 'refused', reason } } });
    const state = await sequenceBridge(api).approveTemplate({ templateVersionId: TEMPLATE });
    expect(state.notice).toBe(reason);
  });
});

// ------------------------------------------------------------------ the resume review
describe('"Review and resume" shows the review first (audit G06)', () => {
  const preview = {
    asOf: '2026-09-25T13:00:00.000Z',
    preview: {
      enrollmentId: SEQUENCE_IDS.enrollment,
      kind: 'review_required' as const,
      unionMilliseconds: 9 * 86_400_000,
      shiftMilliseconds: 9 * 86_400_000,
      openHoldIds: [],
      firmTimeZone: 'America/New_York',
      holds: [{ reasonCode: 'scoped_pause' as const, startedAt: '2026-09-10T13:00:00.000Z', releasedAt: '2026-09-19T13:00:00.000Z' }],
      steps: [
        {
          stepExecutionId: SEQUENCE_IDS.stepExecution,
          ordinal: 2,
          channel: 'email' as const,
          state: 'held' as const,
          originalDueAt: '2026-09-17T13:00:00.000Z',
          dueAt: '2026-09-17T13:00:00.000Z',
          proposedDueAt: '2026-09-26T13:00:00.000Z',
        },
      ],
    },
  };
  const reads = {
    '/sequences': { status: 200, body: { sequences: [] } },
    '/templates': { status: 200, body: { templates: [] } },
    '/enrollments': {
      status: 200,
      body: { asOf: '2026-09-25T13:00:00.000Z', enrollments: [enrollmentAnswer({ state: 'review_required', reviewUnionMilliseconds: 9 * 86_400_000 })] },
    },
    '/enrollments/resume/preview': { status: 200, body: preview },
  } satisfies Record<string, HttpAnswer>;

  it('opens the review instead of resuming, and resumes only the reviewed enrollment when confirmed', async () => {
    const { api, calls } = scriptedApi({ ...reads, '/enrollments/resume': accepted({ kind: 'resume', shiftMilliseconds: 1, unionMilliseconds: 1, openHoldIds: [], executionsShifted: 1 }) });
    const bridge = sequenceBridge(api);
    const reviewing = await bridge.resumeEnrollment({ enrollmentId: SEQUENCE_IDS.enrollment });
    expect(calls.map(entry => entry.path)).not.toContain('/enrollments/resume');
    expect(reviewing.resumeReview?.preview.enrollmentId).toBe(SEQUENCE_IDS.enrollment);

    const panel = sequenceScreen(reviewing).resumeReview;
    expect(panel?.steps).toEqual([{ label: 'Step 2 · Email (held)', from: 'Thu, Sep 17, 9:00 AM', to: 'Sat, Sep 26, 9:00 AM', moved: true }]);
    expect(panel?.summary).toContain('9 days later');
    expect(panel?.holdLines).toEqual(['scoped pause: Thu, Sep 10, 9:00 AM to Sat, Sep 19, 9:00 AM']);
    expect(panel?.canConfirm).toBe(true);
    expect(sequenceScreen(reviewing).holdReview[0]?.reviewing).toBe(true);

    const resumed = await bridge.resumeEnrollment({ enrollmentId: SEQUENCE_IDS.enrollment });
    expect(calls.filter(entry => entry.path === '/enrollments/resume').map(entry => entry.body?.['enrollmentId'])).toEqual([SEQUENCE_IDS.enrollment]);
    expect(resumed.notice).toBe('resumed');
    expect(resumed.resumeReview).toBeNull();
  });

  it('offers no confirmation while something still holds the enrollment', () => {
    const state: SequenceState = {
      ...EMPTY_SEQUENCE_STATE,
      online: true,
      mayMutate: true,
      resumeReview: { ...preview, preview: { ...preview.preview, kind: 'still_held', shiftMilliseconds: 0, openHoldIds: [SEQUENCE_IDS.firm] } },
    };
    const panel = resumeReviewPanel(state.resumeReview!, state);
    expect(panel.canConfirm).toBe(false);
    expect(panel.summary).toContain('still holding');
  });
});

// ------------------------------------------------------------------- the Firm page
describe('the Firm page enrols, confirms a number, and clears a title (audit G03, C20)', () => {
  const FIRM = '12121212-1212-4212-8212-121212121212';
  const CONTACT = '13131313-1313-4313-8313-131313131313';
  const OPPORTUNITY = '14141414-1414-4414-8414-141414141414';
  const ROUTE = '15151515-1515-4515-8515-151515151515';
  const page = (opportunity: 'open' | 'lost' | null) => ({
    visibility: 'assigned_or_admin',
    read: {
      visibility: 'assigned_or_admin',
      firm: {
        id: FIRM,
        name: 'Aspen Test Wealth',
        website: null,
        locality: null,
        regionCode: null,
        status: 'active',
        assignedUserId: null,
        stageKey: null,
        opportunityStatus: opportunity,
        controlMode: null,
        openedAt: null,
        timeZone: 'America/New_York',
        timeZoneUnresolvedReason: null,
        addressLine: null,
        postalCode: null,
        countryCode: 'US',
        timeZoneConfidence: 'high',
        timeZoneSource: 'recorded',
        contacts: [{ id: CONTACT, fullName: 'Kim Placeholder', title: 'Principal', status: 'active', isPrimary: true }],
        phoneRoutes: [{ id: ROUTE, contactId: CONTACT, value: '+14015550121', eligibility: 'candidate', version: 1 }],
        emailRoutes: [],
        aliases: [],
      },
    },
    opportunity:
      opportunity === null
        ? null
        : {
            id: OPPORTUNITY,
            status: opportunity,
            stageKey: 'new',
            controlMode: 'automated',
            controlModeReason: null,
            openedAt: '2026-09-25T12:00:00.000Z',
            closedAt: opportunity === 'open' ? null : '2026-09-25T12:30:00.000Z',
            closeReason: opportunity === 'open' ? null : 'Chose another provider',
          },
    stageHistory: [],
    holds: [],
  });
  const reads = (opportunity: 'open' | 'lost' | null) => ({
    '/crm/firm-page': { status: 200, body: page(opportunity) },
    '/sequences': { status: 200, body: { sequences: [sequenceSummaryAnswer()] } },
    '/sequences/versions': {
      status: 200,
      body: { versions: [sequenceVersionAnswer([emailStepAnswer(TEMPLATE)], { state: 'published', version: 1, publishedAt: '2026-09-20T12:00:00.000Z' })] },
    },
    '/enrollments': { status: 200, body: { asOf: '2026-09-25T13:00:00.000Z', enrollments: [enrollmentAnswer({ contactId: CONTACT })] } },
  });
  const crm = (api: ReturnType<typeof createAuthedClient>) => createCrmBridge({ api, clientVersion: '1.0.6', session: session() });

  it('lists the published versions by name and the live enrollments, and enrols with the page’s own firm and opportunity', async () => {
    const { api, calls } = scriptedApi({ ...reads('open'), '/enrollments/enroll': accepted({ enrollmentId: SEQUENCE_IDS.enrollment }) });
    const bridge = crm(api);
    const opened = await bridge.openFirm({ firmId: FIRM });
    expect(opened.sequences).toEqual({
      published: [{ sequenceVersionId: SEQUENCE_IDS.version, label: 'Founding outreach v1' }],
      enrollments: [{ enrollmentId: SEQUENCE_IDS.enrollment, contactId: CONTACT, label: 'Founding outreach v1', state: 'active', startedAt: '2026-09-01T12:00:00.000Z' }],
      readError: null,
    });
    const enrolled = await bridge.enroll({ sequenceVersionId: SEQUENCE_IDS.version, contactId: CONTACT });
    expect(enrolled.notice).toBe('enrolled');
    expect(calls.find(entry => entry.path === '/enrollments/enroll')?.body).toMatchObject({
      sequenceVersionId: SEQUENCE_IDS.version,
      opportunityId: OPPORTUNITY,
      firmId: FIRM,
      contactId: CONTACT,
    });
  });

  it('enrols nobody at a firm whose opportunity is closed, and opens one for a firm with none', async () => {
    const closed = scriptedApi(reads('lost'));
    const bridge = crm(closed.api);
    await bridge.openFirm({ firmId: FIRM });
    expect((await bridge.enroll({ sequenceVersionId: SEQUENCE_IDS.version, contactId: CONTACT })).notice).toBe('opportunity_not_open');
    expect(closed.calls.map(entry => entry.path)).not.toContain('/enrollments/enroll');

    const none = scriptedApi({ ...reads(null), '/opportunities/open': accepted({ id: OPPORTUNITY }) });
    const fresh = crm(none.api);
    await fresh.openFirm({ firmId: FIRM });
    const opened = await fresh.openOpportunity();
    expect(opened.notice).toBe('opportunity_opened');
    expect(none.calls.find(entry => entry.path === '/opportunities/open')?.body).toMatchObject({ firmId: FIRM });
  });

  it('says a failed read rather than showing no sequences', async () => {
    const { api } = scriptedApi({ ...reads('open'), '/sequences': { status: 503, body: { error: 'service_unavailable' } } });
    const opened = await crm(api).openFirm({ firmId: FIRM });
    expect(opened.sequences).toEqual({ published: [], enrollments: [], readError: 'service_unavailable' });
  });

  it('confirms a phone number at the version on screen', async () => {
    const { api, calls } = scriptedApi({ ...reads('open'), '/contacts/routes/confirm': accepted({ id: ROUTE }) });
    const bridge = crm(api);
    await bridge.openFirm({ firmId: FIRM });
    const answer = await bridge.confirmRoute({ routeId: ROUTE, routeVersion: 1 });
    expect(answer.notice).toBe('route_confirmed');
    expect(calls.find(entry => entry.path === '/contacts/routes/confirm')?.body).toMatchObject({
      routeKind: 'phone',
      routeId: ROUTE,
      routeVersion: 1,
    });
  });

  it('sends the patch the route reads, with an explicit null for a cleared title (C20)', async () => {
    expect(contactPatchBody({ contactId: CONTACT, fullName: 'Kim Placeholder', title: null, makePrimary: false })).toEqual({
      contactId: CONTACT,
      patch: { fullName: 'Kim Placeholder', title: null },
    });
    expect(contactPatchBody({ contactId: CONTACT, fullName: 'Kim', title: 'Principal', makePrimary: true })).toEqual({
      contactId: CONTACT,
      patch: { fullName: 'Kim', title: 'Principal', isPrimary: true },
    });
    const { api, calls } = scriptedApi({ ...reads('open'), '/contacts/update': accepted({ id: CONTACT }) });
    const bridge = crm(api);
    await bridge.openFirm({ firmId: FIRM });
    expect((await bridge.saveContact({ contactId: CONTACT, fullName: 'Kim Placeholder', title: null, makePrimary: false })).notice).toBe('saved');
    expect(calls.find(entry => entry.path === '/contacts/update')?.body).toMatchObject({
      contactId: CONTACT,
      patch: { fullName: 'Kim Placeholder', title: null },
    });
  });
});

// ---------------------------------------------------------------- Settings' controls
describe('Settings has typed controls, not JSON (audit G08)', () => {
  it('reads each slice into fields and writes the same value back', () => {
    const cases: [string, unknown][] = [
      ['business_time_zone', { timeZone: 'America/Chicago' }],
      ['sending_enabled', { enabled: true, releaseGateReference: 'release-2026-09-25' }],
      ['sending_enabled', { enabled: false, releaseGateReference: null }],
      ['client_version_range', { minimum: '1.0.5', maximum: '1.999.999' }],
    ];
    for (const [key, value] of cases) {
      const fields = settingFields(key, value) ?? [];
      const values = Object.fromEntries(fields.map(field => [field.key, field.kind === 'toggle' ? field.value : String(field.value)]));
      expect(settingValueFrom(key, values), key).toEqual({ ok: true, value });
    }
  });

  it('writes the ten thresholds as numbers, and names the one that is not a number', () => {
    const fields = settingFields('alert_thresholds', undefined) ?? [];
    expect(fields).toHaveLength(10);
    const values = Object.fromEntries(fields.map(field => [field.key, String(field.value)]));
    const written = settingValueFrom('alert_thresholds', values);
    expect(written.ok && (written.value as Record<string, unknown>)['heartbeatMissedChecks']).toBe(3);
    expect(written.ok && (written.value as Record<string, unknown>)['todaySnapshotDeadlineLocalTime']).toBe('05:10');
    expect(settingValueFrom('alert_thresholds', { ...values, canaryStaleSeconds: 'soon' })).toEqual({ ok: false, field: 'canaryStaleSeconds' });
  });

  it('leaves a slice it does not know to JSON, and says why a control is inert in words', () => {
    expect(settingFields('a_slice_from_the_future', {})).toBeNull();
    expect(settingSummary('business_time_zone', { timeZone: 'America/Chicago' })).toBe('Central (Chicago)');
    expect(settingSummary('sending_enabled', { enabled: false })).toBe('Off');
    expect(inertSentence('admin_only')).toBe('Only an admin can change this.');
    expect(inertSentence('a_code_from_the_future')).toBe('a_code_from_the_future');
  });
});
