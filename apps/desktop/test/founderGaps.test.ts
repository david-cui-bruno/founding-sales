import { describe, expect, it } from 'vitest';
import { NO_OPTOUT_LINK_RULE, SENDING_STOP_LINE } from '@fss/contracts';
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
  sequenceNotice,
  sequenceScreen,
  stepsForWire,
  suggestedPlan,
  templateFormIssues,
  templateFormWarnings,
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
    accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
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

  /**
   * Wave 2, S3: a published version is edited in place, and the edit reaches the
   * enrollments running in it. "Edit as a new draft" is gone — a second version was
   * never what a person editing a live sequence meant — so a published version is
   * editable and a retired one is not, whatever else is open.
   */
  it('edits a published version in place, however many versions there are', () => {
    const published = sequenceVersionAnswer([emailStepAnswer(TEMPLATE)], { state: 'published', publishedAt: '2026-09-20T12:00:00.000Z' });
    const base: SequenceState = { ...EMPTY_SEQUENCE_STATE, online: true, mayMutate: true, isAdmin: true, templates: [templateVersionAnswer()] };
    expect(sequenceScreen({ ...base, versions: [published] }).versions[0]?.editable).toBe(true);
    const draft = sequenceVersionAnswer([], { id: SEQUENCE_IDS.firm, version: 2 });
    expect(sequenceScreen({ ...base, versions: [draft, published] }).versions.find(panel => panel.state === 'published')?.editable).toBe(true);
    expect(sequenceScreen({ ...base, versions: [published] }).versions[0]?.stopSentence).toContain('Stops by itself');
  });
});

// ------------------------------------------------------------------ the templates
describe('the template form (audit G03)', () => {
  const draft = { templateVersionId: null, name: 'First touch', subject: 'A question for {firm_name}', body: 'Hello {contact_first_name},\n\nA note.', signOff: 'David\nCallie' };

  it('ends the email with the sign-off, and gives the person back only what they typed', () => {
    const body = composeTemplateBody(draft.body, draft.signOff);
    expect(body).toBe('Hello {contact_first_name},\n\nA note.\n\nDavid\nCallie');
    expect(typedBodyOf({ body, footerSignOff: 'David\nCallie' })).toBe(draft.body);
    // A template approved before 29 September 2026 still opens showing only the words.
    expect(typedBodyOf({ body: `${body}\n${SENDING_STOP_LINE}`, footerSignOff: 'David\nCallie' })).toBe(draft.body);
    // And the footer is a complete separate block, never a word suffix: editing the
    // valid footerless body `Hi David` under the sign-off `David` must not hand the form
    // `Hi` (review of PR 311, P1-4). It round-trips instead.
    expect(typedBodyOf({ body: 'Hi David', footerSignOff: 'David' })).toBe('Hi David');
    // Trailing whitespace after the footer is still the footer — the panel says so, and
    // an extraction that disagreed would hand the form its own footer back and save a
    // second sign-off under the first (review of PR 311, third round).
    for (const trailing of ['\n', '\n\n', ' \n', '\t']) {
      const stored = `${body}${trailing}`;
      expect(typedBodyOf({ body: stored, footerSignOff: 'David\nCallie' }), trailing).toBe(draft.body);
      expect(composeTemplateBody(typedBodyOf({ body: stored, footerSignOff: 'David\nCallie' }), 'David\nCallie')).toBe(
        body,
      );
    }
    expect(composeTemplateBody(typedBodyOf({ body: 'Hi David', footerSignOff: 'David' }), 'David')).toBe(
      'Hi David\n\nDavid',
    );
    expect(templateVariablesIn(draft.subject, body)).toEqual({ known: ['firm_name', 'contact_first_name'], unknown: [] });
  });

  it('refuses a name-less form, an unknown variable and an opt-out link before sending', () => {
    expect(templateFormIssues(draft)).toEqual([]);
    expect(templateFormIssues({ ...draft, name: ' ' }).map(issue => issue.field)).toEqual(['name']);
    expect(templateFormIssues({ ...draft, body: 'Hi {first}' })[0]?.text).toContain('Callie cannot fill {first}');
    expect(templateFormIssues({ ...draft, body: 'Click https://x.example.test/unsubscribe' })[0]?.text).toBe(
      NO_OPTOUT_LINK_RULE,
    );
    // The word on its own is not a link, and the form says nothing about it.
    expect(templateFormIssues({ ...draft, body: "Just reply unsubscribe and I'll stop." })).toEqual([]);
    // Subject and body are two columns, not one line: this is what the server accepts.
    expect(templateFormIssues({ ...draft, subject: 'Unsubscribe', body: 'https://firm.example is our site.' })).toEqual(
      [],
    );
    // But the body *with its sign-off* — the bytes that get stored — is checked as one:
    // a link in the sign-off is a link in the email.
    expect(
      templateFormIssues({ ...draft, signOff: 'Sam\nUnsubscribe: https://x.example/a' })[0]?.text,
    ).toBe(NO_OPTOUT_LINK_RULE);
  });

  it('warns about a long email and still lets it be saved (wave 1)', () => {
    const long = { ...draft, body: 'word '.repeat(90) };
    expect(templateFormIssues(long)).toEqual([]);
    expect(templateFormWarnings(long)[0]).toMatch(/^The email is \d+ words with its sign-off\. /u);
    expect(templateFormWarnings(draft)).toEqual([]);
  });

  it('names every issue of a refused approval in words', () => {
    expect(sequenceNotice('template_unapproved:template_footer_missing,template_body_multiple_urls')).toBe(
      'Not approved. Callie cannot tell where the sign-off starts: the email does not end with it. The email has more than one link.',
    );
    // The server's newest rule (migration 0024): a visible opt-out link.
    expect(sequenceNotice('template_unapproved:template_optout_link')).toBe(`Not approved. ${NO_OPTOUT_LINK_RULE}`);
    expect(sequenceNotice('steps_saved')).toBe('Saved.');
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

  it('saves the steps as numbered wire steps, and refuses a malformed one without a command', async () => {
    const { api, calls } = scriptedApi({ ...reads, '/sequences/versions/steps': accepted({ steps: 2 }) });
    const bridge = sequenceBridge(api);
    const saved = await bridge.saveSteps({ sequenceVersionId: SEQUENCE_IDS.version, steps: [call(0), email(2)] });
    expect(saved.notice).toBe('steps_saved');
    expect(calls.find(entry => entry.path === '/sequences/versions/steps')?.body).toMatchObject({
      sequenceVersionId: SEQUENCE_IDS.version,
      steps: stepsForWire([call(0), email(2)]),
    });

    calls.length = 0;
    const refused = await bridge.saveSteps({
      sequenceVersionId: SEQUENCE_IDS.version,
      steps: [{ channel: 'fax' } as unknown as DraftStep],
    });
    expect(refused.notice).toBe('invalid_input');
    expect(calls.map(entry => entry.path)).not.toContain('/sequences/versions/steps');
  });

  /**
   * Wave 2, S3 and D5: one press writes the version and approves it.
   *
   * `approve: true` goes with the text, and the command refuses the whole of it with
   * every issue when the text does not pass — so a version is never written that
   * cannot be approved, and `/templates/approve` has no caller.
   */
  it('writes a template with its footer, its variables and its approval in one command', async () => {
    const { api, calls } = scriptedApi({ ...reads, '/templates/create': accepted(templateVersionAnswer()) });
    const state = await sequenceBridge(api).saveTemplate({
      templateVersionId: null,
      name: ' First touch ',
      subject: 'A question for {firm_name}',
      body: 'Hello {contact_first_name},',
      signOff: 'David',
    });
    expect(state.notice).toBe('template_saved');
    const body = calls.find(entry => entry.path === '/templates/create')?.body;
    expect(body).toMatchObject({
      name: 'First touch',
      subject: 'A question for {firm_name}',
      body: 'Hello {contact_first_name},\n\nDavid',
      footerSignOff: 'David',
      requiredVariables: ['firm_name', 'contact_first_name'],
      approve: true,
    });
    expect(body).not.toHaveProperty('templateVersionId');
    expect(calls.map(entry => entry.path)).not.toContain('/templates/approve');
    // A server before lane W1-C answers the version alone: no warnings.
    expect(state.warnings).toEqual([]);
  });

  it('edits an existing version in place, naming it rather than superseding it', async () => {
    const { api, calls } = scriptedApi({ ...reads, '/templates/update': accepted(templateVersionAnswer()) });
    const state = await sequenceBridge(api).saveTemplate({
      templateVersionId: TEMPLATE,
      name: 'First touch',
      subject: 'A question',
      body: 'Hello,',
      signOff: 'David',
    });
    expect(state.notice).toBe('template_saved');
    expect(calls.find(entry => entry.path === '/templates/update')?.body).toMatchObject({
      templateVersionId: TEMPLATE,
      approve: true,
    });
    expect(calls.map(entry => entry.path)).not.toContain('/templates/create');
  });

  it('shows the copy warnings a save answered, until the next act (wave 1)', async () => {
    const { api } = scriptedApi({
      ...reads,
      '/templates/create': accepted({ ...templateVersionAnswer(), warnings: ['template_body_too_long', 'template_new_advice'] }),
      '/sequences/versions/publish': accepted({}),
    });
    const bridge = sequenceBridge(api);
    const saved = await bridge.saveTemplate({ templateVersionId: null, name: 'Long', subject: 'Hi', body: 'word '.repeat(90), signOff: 'David' });
    expect(saved.notice).toBe('template_saved');
    expect(saved.warnings).toEqual(['template_body_too_long', 'template_new_advice']);
    expect(sequenceScreen(saved).warnings).toEqual(['The email is longer than 89 words, sign-off included.', 'template_new_advice']);
    // A read keeps them on screen; the next act clears them.
    expect((await bridge.state()).warnings).toHaveLength(2);
    expect((await bridge.publish({ sequenceVersionId: SEQUENCE_IDS.version })).warnings).toEqual([]);
  });

  it('reads a refused save’s issues from its body, past the transport’s 80-character code', async () => {
    const reason = 'template_unapproved:template_body_multiple_urls,template_pricing_or_guarantee_language,template_body_markup';
    const { api } = scriptedApi({ ...reads, '/templates/create': { status: 409, body: { status: 'refused', reason } } });
    const state = await sequenceBridge(api).saveTemplate({
      templateVersionId: null,
      name: 'First touch',
      subject: 'A question',
      body: 'Hello,',
      signOff: 'David',
    });
    expect(state.notice).toBe(reason);
  });
});

// ------------------------------------------------------------ the long hold, wave 2
/**
 * "Review and resume" is gone (wave 2, S4.1; audit G06 closed).
 *
 * An enrollment held a long time resumes by itself, the server never sends
 * `review_required`, and neither `/enrollments/resume/preview` nor `/enrollments/resume`
 * has a caller on this Mac. `/enrollments` is still read, for the count of who is in
 * flight, and that read asks for nothing to be confirmed.
 */
describe('a long hold resumes by itself (wave 2, S4.1)', () => {
  const reads = {
    '/sequences': { status: 200, body: { sequences: [sequenceSummaryAnswer()] } },
    '/sequences/versions': { status: 200, body: { versions: [sequenceVersionAnswer([])] } },
    '/templates': { status: 200, body: { templates: [] } },
    '/enrollments': {
      status: 200,
      body: { asOf: '2026-09-25T13:00:00.000Z', enrollments: [enrollmentAnswer()] },
    },
  } satisfies Record<string, HttpAnswer>;

  it('reads who is in flight and asks neither resume route', async () => {
    const { api, calls } = scriptedApi(reads);
    const state = await sequenceBridge(api).state();
    expect(state.enrollments.map(entry => entry.state)).toEqual(['active']);
    expect(calls.map(entry => entry.path)).not.toContain('/enrollments/resume');
    expect(calls.map(entry => entry.path)).not.toContain('/enrollments/resume/preview');
    const screen = sequenceScreen(state);
    expect(screen.enrollments?.summary).toBe('One person is working through this sequence.');
    expect(screen.enrollments?.rows).toEqual([
      { sequenceVersionId: SEQUENCE_IDS.version, line: 'Version 2 — 1 running' },
    ]);
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
            controlModeOrigin: null,
            openedAt: '2026-09-25T12:00:00.000Z',
            closedAt: opportunity === 'open' ? null : '2026-09-25T12:30:00.000Z',
            closeReason: opportunity === 'open' ? null : 'Chose another provider',
          },
    stageHistory: [],
    holds: [],
    followUpPermissions: [],
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
      published: [
        {
          sequenceVersionId: SEQUENCE_IDS.version,
          label: 'Founding outreach v1',
          // The bytes the version's steps send, which the Mac matches a follow-up
          // permission against before it offers one (migration 0025).
          templateVersionIds: [SEQUENCE_IDS.template],
          // How many steps the version has in all, which is not the number of templates
          // in it: the Mac needs both to tell "one e-mail" from "an e-mail and a call".
          stepCount: 1,
        },
      ],
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

  /**
   * Wave 2, S4.4: a phone number is callable the moment it is entered.
   *
   * "Confirm this number" and `/contacts/routes/confirm` went with the prompt — the
   * person who typed the number has already said it reaches them — so the only route
   * check left is "Check again" on an *address*, which is a different route.
   */
  it('checks an address again at the version on screen, and confirms no number', async () => {
    const { api, calls } = scriptedApi({ ...reads('open'), '/contacts/routes/check': accepted({ id: ROUTE }) });
    const bridge = crm(api);
    await bridge.openFirm({ firmId: FIRM });
    const answer = await bridge.checkRoute({ routeId: ROUTE, routeVersion: 1 });
    expect(answer.notice).toBe('route_check_queued');
    expect(calls.find(entry => entry.path === '/contacts/routes/check')?.body).toMatchObject({
      routeKind: 'email',
      routeId: ROUTE,
      routeVersion: 1,
    });
    expect(calls.map(entry => entry.path)).not.toContain('/contacts/routes/confirm');
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
    ];
    for (const [key, value] of cases) {
      const fields = settingFields(key, value) ?? [];
      const values = Object.fromEntries(fields.map(field => [field.key, field.kind === 'toggle' ? field.value : String(field.value)]));
      expect(settingValueFrom(key, values), key).toEqual({ ok: true, value });
    }
  });

  it('has no controls for the two slices wave 1 deleted on the server', () => {
    expect(settingFields('alert_thresholds', {})).toBeNull();
    expect(settingFields('client_version_range', {})).toBeNull();
  });

  it('leaves a slice it does not know to JSON, and says why a control is inert in words', () => {
    expect(settingFields('a_slice_from_the_future', {})).toBeNull();
    expect(settingSummary('business_time_zone', { timeZone: 'America/Chicago' })).toBe('Central (Chicago)');
    expect(settingSummary('sending_enabled', { enabled: false })).toBe('Off');
    expect(inertSentence('admin_only')).toBe('Only an admin can change this.');
    expect(inertSentence('a_code_from_the_future')).toBe('a_code_from_the_future');
  });
});
