import { describe, expect, it } from 'vitest';
import { createAuthedClient } from '../src/main/authedClient.ts';
import type { HttpAnswer } from '../src/main/apiClient.ts';
import type { DialHandoff } from '../src/main/dialHandoff.ts';
import { createTodayBridge, outcomeNotice } from '../src/main/todayBridge.ts';
import { agreementSentence } from '../src/renderer/today/followUpView.ts';
import type { OutcomeRequest } from '../src/renderer/todayContract.ts';
import { buildTodayView, noticeSentence } from '../src/renderer/todayView.ts';

/**
 * The Today bridge's half of the call card's agreed sequence (send-path v2, slice S3).
 *
 * The bridge is where the card's three follow-up answers meet the server: it reads the
 * published sequences a call may agree to with the expansion, asks
 * `POST /calls/follow-up-preview` for the one chosen, sends the agreed version on
 * `POST /calls/log`, and turns the answer's follow-ups into a notice that names what was
 * agreed and whether the sequence started — or why not.
 *
 * A scripted API, as `today.test.ts` uses: every call recorded, every answer chosen.
 * No real person or business appears; `example.test` is reserved by RFC 6761 and the
 * numbers are in the NANP 555-01XX block.
 */

const FIRM_ID = '11111111-1111-4111-8111-111111111111';
const CONTACT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ROUTE_ID = '44444444-4444-4444-8444-444444444444';
const SEQUENCE_ID = '12121212-1212-4212-8212-121212121212';
const ARCHIVED_SEQUENCE_ID = '13131313-1313-4313-8313-131313131313';
const PUBLISHED = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const DRAFT = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const RETIRED = 'dddddddd-4444-4444-8444-dddddddddddd';
const WITH_REMOVED_STEP = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const ENROLLMENT_ID = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0';

function scriptedApi(answers: Readonly<Record<string, HttpAnswer>>): {
  readonly api: ReturnType<typeof createAuthedClient>;
  readonly calls: { path: string; body: unknown }[];
} {
  const calls: { path: string; body: unknown }[] = [];
  const api = createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: '1.4.0',
    accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
    send: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: init.body === undefined ? null : JSON.parse(init.body) });
      return await Promise.resolve(answers[path] ?? { status: 404, body: { error: 'not_found' } });
    },
  });
  return { api, calls };
}

const session = {
  state: async () =>
    await Promise.resolve({
      online: true,
      stale: false,
      asOf: '2026-09-30T13:00:00.000Z',
      mayMutate: true,
      device: { role: 'salesperson' as const },
      today: { snapshotDate: '2026-09-30', businessTimeZone: 'America/New_York', cards: [] },
    }),
  refreshToday: async () => await Promise.resolve(null),
};

const handoff: DialHandoff = {
  checkSetup: async () => await Promise.resolve({ ready: true }),
  open: async input => await Promise.resolve({ status: 'opened', e164: input.e164 }),
};

const firmPage = {
  firmId: FIRM_ID,
  firmName: 'Northwind Test Holdings',
  snapshotDate: '2026-09-30',
  lane: 'due_work',
  counts: { replies: 0, emailsDue: 0, callsDue: 1 },
  tasks: [],
  routes: [{ routeId: ROUTE_ID, contactId: CONTACT_ID, e164: '+14015550187', version: 1, eligibility: 'candidate' }],
  callingIdentityId: null,
};

const step = (versionId: string, ordinal: number, channel: 'email' | 'call_task') => ({
  id: `${String(ordinal)}${versionId.slice(1)}`,
  sequenceVersionId: versionId,
  ordinal,
  channel,
  delay: { unit: 'business_days', days: ordinal },
  onNoAnswer: channel === 'call_task' ? 'advance' : null,
  templateVersionId: null,
});

const version = (id: string, number: number, state: string, steps: readonly unknown[]) => ({
  id,
  sequenceId: SEQUENCE_ID,
  version: number,
  state,
  stopConditions: [],
  publishedAt: state === 'draft' ? null : '2026-09-20T12:00:00.000Z',
  retiredAt: state === 'retired' ? '2026-09-25T12:00:00.000Z' : null,
  steps,
});

const accepted = (result: unknown): HttpAnswer => ({ status: 200, body: { status: 'accepted', replayed: false, result } });

const logged = (followUps: readonly unknown[]) =>
  accepted({
    callLogId: 'abababab-abab-4bab-8bab-abababababab',
    outcome: 'interested',
    stepEffect: 'none',
    occurredAt: '2026-09-30T13:05:00.000Z',
    setManual: true,
    suggestedStageKey: null,
    suppressionEventIds: [],
    retiredRouteId: null,
    successorExecutionId: null,
    stepExecutionId: null,
    stepApplication: null,
    callbackId: null,
    completedCallbackId: null,
    followUpPermissionId: '99999999-9999-4999-8999-999999999999',
    followUps,
  });

const baseAnswers = (extra: Readonly<Record<string, HttpAnswer>> = {}): Record<string, HttpAnswer> => ({
  '/today/firm': { status: 200, body: firmPage },
  '/templates': { status: 200, body: { templates: [] } },
  '/sequences': {
    status: 200,
    body: {
      sequences: [
        { id: SEQUENCE_ID, name: 'After a good call', description: null, archivedAt: null },
        { id: ARCHIVED_SEQUENCE_ID, name: 'Old plan', description: null, archivedAt: '2026-09-01T12:00:00.000Z' },
      ],
    },
  },
  '/sequences/versions': {
    status: 200,
    body: {
      versions: [
        version(DRAFT, 4, 'draft', [step(DRAFT, 1, 'email')]),
        version(PUBLISHED, 3, 'published', [step(PUBLISHED, 1, 'email'), step(PUBLISHED, 2, 'call_task')]),
        version(RETIRED, 2, 'retired', [step(RETIRED, 1, 'email')]),
        version(WITH_REMOVED_STEP, 1, 'published', [
          {
            id: '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e',
            sequenceVersionId: WITH_REMOVED_STEP,
            ordinal: 1,
            channel: 'removed',
            removedChannel: 'linkedin',
            delay: { unit: 'elapsed', hours: 0 },
            onNoAnswer: null,
            templateVersionId: null,
          },
        ]),
      ],
    },
  },
  ...extra,
});

const interested = (
  followUpPermission: OutcomeRequest['followUpPermission'],
  contactId: string | null = CONTACT_ID,
): OutcomeRequest => ({
    firmId: FIRM_ID,
    contactId,
    routeId: null,
    itemId: null,
    outcome: 'interested',
    note: '',
    callback: null,
    doNotCallCoversAllContact: false,
    followUpPermission,
  });

describe('the Today bridge and an agreed sequence', () => {
  it('offers only the published, enrollable versions of unarchived sequences, by name and version', async () => {
    const { api, calls } = scriptedApi(baseAnswers());
    const bridge = createTodayBridge({ api, handoff, session });
    const state = await bridge.expand({ firmId: FIRM_ID });
    expect(state.followUpSequences).toEqual([{ sequenceVersionId: PUBLISHED, name: 'After a good call v3' }]);
    // The archived sequence's versions were never read.
    expect(calls.filter(call => call.path === '/sequences/versions').map(call => call.body)).toEqual([
      { sequenceId: SEQUENCE_ID },
    ]);
  });

  it('asks the server for the preview and keeps its steps, and keeps a refusal as its code', async () => {
    const preview = {
      sequenceVersionId: PUBLISHED,
      sequenceName: 'After a good call',
      version: 3,
      firmTimeZone: 'America/Los_Angeles',
      holidayCalendarVersion: 'none.1',
      anchoredAt: '2026-09-30T15:00:00.000Z',
      steps: [
        {
          ordinal: 1,
          channel: 'email',
          templateVersionId: '66666666-6666-4666-8666-666666666666',
          templateName: 'The overview',
          subject: 'The overview for {firm_name}',
          templateApproved: true,
          dueAt: '2026-10-02T15:00:00.000Z',
          estimatedAt: '2026-10-02T15:00:00.000Z',
        },
        {
          ordinal: 2,
          channel: 'call_task',
          templateVersionId: null,
          templateName: null,
          subject: null,
          templateApproved: null,
          dueAt: '2026-10-06T15:00:00.000Z',
          estimatedAt: '2026-10-06T15:00:00.000Z',
        },
      ],
    };
    const { api, calls } = scriptedApi(baseAnswers({ '/calls/follow-up-preview': { status: 200, body: preview } }));
    const bridge = createTodayBridge({ api, handoff, session });
    await bridge.expand({ firmId: FIRM_ID });
    const state = await bridge.previewFollowUp({ firmId: FIRM_ID, contactId: CONTACT_ID, sequenceVersionId: PUBLISHED });
    expect(calls.find(call => call.path === '/calls/follow-up-preview')?.body).toEqual({
      firmId: FIRM_ID,
      contactId: CONTACT_ID,
      sequenceVersionId: PUBLISHED,
    });
    expect(state.followUpPreview).toEqual({
      firmId: FIRM_ID,
      contactId: CONTACT_ID,
      sequenceVersionId: PUBLISHED,
      sequenceName: 'After a good call',
      firmTimeZone: 'America/Los_Angeles',
      anchoredAt: '2026-09-30T15:00:00.000Z',
      steps: [
        {
          ordinal: 1,
          channel: 'email',
          templateName: 'The overview',
          subject: 'The overview for {firm_name}',
          estimatedAt: '2026-10-02T15:00:00.000Z',
        },
        { ordinal: 2, channel: 'call_task', templateName: null, subject: null, estimatedAt: '2026-10-06T15:00:00.000Z' },
      ],
      refusal: null,
    });

    const refusing = scriptedApi(
      baseAnswers({ '/calls/follow-up-preview': { status: 409, body: { status: 'refused', reason: 'firm_zone_unknown' } } }),
    );
    const other = createTodayBridge({ api: refusing.api, handoff, session });
    await other.expand({ firmId: FIRM_ID });
    const refused = await other.previewFollowUp({ firmId: FIRM_ID, contactId: CONTACT_ID, sequenceVersionId: PUBLISHED });
    expect(refused.followUpPreview?.refusal).toBe('firm_zone_unknown');
    expect(refused.followUpPreview?.steps).toEqual([]);
  });

  it('sends the agreed version and says the sequence started, by name', async () => {
    const { api, calls } = scriptedApi(
      baseAnswers({ '/calls/log': logged([{ kind: 'agreed_sequence_enrolled', reason: 'enrolled', enrollmentId: ENROLLMENT_ID }]) }),
    );
    const bridge = createTodayBridge({ api, handoff, session });
    await bridge.expand({ firmId: FIRM_ID });
    const state = await bridge.recordOutcome(interested({ scope: 'agreed_sequence', sequenceVersionId: PUBLISHED }));
    expect(calls.find(call => call.path === '/calls/log')?.body).toMatchObject({
      contactId: CONTACT_ID,
      outcome: 'interested',
      followUpPermission: { scope: 'agreed_sequence', sequenceVersionId: PUBLISHED },
    });
    expect(state.notice).toBe('outcome_recorded_sequence_started');
    expect(state.agreement).toEqual({
      scope: 'agreed_sequence',
      name: 'After a good call v3',
      granted: true,
      started: true,
      reason: null,
    });
    const banners = buildTodayView(state).banners.map(banner => banner.text);
    expect(banners).toContain(noticeSentence('outcome_recorded_sequence_started'));
    expect(banners).toContain('Agreed on the call: the sequence “After a good call v3”. It has started.');
  });

  it('says the sequence did not start, and why, when the enrolment was refused', async () => {
    const { api } = scriptedApi(
      baseAnswers({ '/calls/log': logged([{ kind: 'follow_up_not_enrolled', reason: 'firm_zone_unknown' }]) }),
    );
    const bridge = createTodayBridge({ api, handoff, session });
    await bridge.expand({ firmId: FIRM_ID });
    const state = await bridge.recordOutcome(interested({ scope: 'agreed_sequence', sequenceVersionId: PUBLISHED }));
    expect(state.notice).toBe('outcome_recorded_sequence_not_started');
    expect(state.agreement).toMatchObject({ started: false, granted: true, reason: 'firm_zone_unknown' });
    const banners = buildTodayView(state).banners.map(banner => banner.text);
    expect(banners).toContain(
      'Agreed on the call: the sequence “After a good call v3”. It did not start: the firm’s time zone is not known yet. Start it from the firm’s page.',
    );
  });

  it('never sends an agreement that names nobody, and then claims none', async () => {
    const { api, calls } = scriptedApi(baseAnswers({ '/calls/log': logged([]) }));
    const bridge = createTodayBridge({ api, handoff, session });
    await bridge.expand({ firmId: FIRM_ID });
    const state = await bridge.recordOutcome(interested({ scope: 'agreed_sequence', sequenceVersionId: PUBLISHED }, null));
    expect(calls.find(call => call.path === '/calls/log')?.body).not.toHaveProperty('followUpPermission');
    expect(state.agreement).toBeNull();
    expect(state.notice).toBe('outcome_recorded');
  });

  it('ranks the notices so the one a person must act on comes first', () => {
    const result = (followUps: readonly { kind: string; reason: string }[]) =>
      ({ followUps }) as unknown as Parameters<typeof outcomeNotice>[0];
    expect(outcomeNotice(result([{ kind: 'agreed_sequence_enrolled', reason: 'enrolled' }]))).toBe(
      'outcome_recorded_sequence_started',
    );
    expect(outcomeNotice(result([{ kind: 'follow_up_not_enrolled', reason: 'opportunity_unknown' }]))).toBe(
      'outcome_recorded_sequence_not_started',
    );
    expect(
      outcomeNotice(
        result([
          { kind: 'effects_not_applied', reason: 'invalid_input' },
          { kind: 'agreed_sequence_enrolled', reason: 'enrolled' },
        ]),
      ),
    ).toBe('outcome_recorded_effects_not_applied');
    // A single e-mail names the template; a refused grant says so.
    expect(
      agreementSentence({ scope: 'single_email', name: 'The overview', granted: true, started: null, reason: null }),
    ).toBe('Agreed on the call: one e-mail, “The overview”.');
  });
});
