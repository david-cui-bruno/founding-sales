import { describe, expect, it } from 'vitest';
import { createAuthedClient } from '../src/main/authedClient.ts';
import type { HttpAnswer } from '../src/main/apiClient.ts';
import type { DialHandoff } from '../src/main/dialHandoff.ts';
import { guardIdentity, resetBridges } from '../src/main/identityReset.ts';
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
/** The basis of the preview the card showed, which the command carries (review of S3, P1-3). */
const BASIS = {
  anchorAt: '2026-09-30T15:00:00.000Z',
  timeZone: 'America/Los_Angeles',
  calendarVersionId: 'none.1',
  steps: [
    { ordinal: 1, sendAt: '2026-10-02T15:00:00.000Z' },
    { ordinal: 2, sendAt: '2026-10-06T15:00:00.000Z' },
  ],
};

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
      holidayCalendarVersion: 'none.1',
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
    const state = await bridge.recordOutcome(interested({ scope: 'agreed_sequence', sequenceVersionId: PUBLISHED, previewBasis: BASIS }));
    expect(calls.find(call => call.path === '/calls/log')?.body).toMatchObject({
      contactId: CONTACT_ID,
      outcome: 'interested',
      followUpPermission: { scope: 'agreed_sequence', sequenceVersionId: PUBLISHED, previewBasis: BASIS },
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
    const state = await bridge.recordOutcome(interested({ scope: 'agreed_sequence', sequenceVersionId: PUBLISHED, previewBasis: BASIS }));
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
    const state = await bridge.recordOutcome(interested({ scope: 'agreed_sequence', sequenceVersionId: PUBLISHED, previewBasis: BASIS }, null));
    expect(calls.find(call => call.path === '/calls/log')?.body).not.toHaveProperty('followUpPermission');
    expect(state.agreement).toBeNull();
    expect(state.notice).toBe('outcome_recorded');
  });

  it('keeps a stale agreement open, reads the new dates, and records them on POST /calls/follow-up (round 2, P1-B)', async () => {
    const CALL_LOG_ID = 'abababab-abab-4bab-8bab-abababababab';
    const freshPreview = {
      sequenceVersionId: PUBLISHED,
      sequenceName: 'After a good call',
      version: 3,
      firmTimeZone: 'America/Los_Angeles',
      holidayCalendarVersion: 'holidays.2',
      anchoredAt: '2026-09-30T15:05:00.000Z',
      steps: [
        {
          ordinal: 1,
          channel: 'email',
          templateVersionId: '66666666-6666-4666-8666-666666666666',
          templateName: 'The overview',
          subject: 'The overview',
          templateApproved: true,
          dueAt: '2026-10-05T15:00:00.000Z',
          estimatedAt: '2026-10-05T15:00:00.000Z',
        },
      ],
    };
    const { api, calls } = scriptedApi(
      baseAnswers({
        '/calls/log': logged([{ kind: 'follow_up_not_granted', reason: 'stale_preview' }]),
        '/calls/follow-up-preview': { status: 200, body: freshPreview },
        '/calls/follow-up': accepted({
          callLogId: CALL_LOG_ID,
          followUpPermissionId: '99999999-9999-4999-8999-999999999999',
          followUps: [{ kind: 'agreed_sequence_enrolled', reason: 'enrolled', enrollmentId: ENROLLMENT_ID }],
        }),
      }),
    );
    const bridge = createTodayBridge({ api, handoff, session });
    await bridge.expand({ firmId: FIRM_ID });
    const state = await bridge.recordOutcome(
      interested({ scope: 'agreed_sequence', sequenceVersionId: PUBLISHED, previewBasis: BASIS }),
    );
    // Nothing granted; the card keeps this call's agreement open with the new dates.
    expect(state.pendingAgreement).toEqual({
      firmId: FIRM_ID,
      callLogId: CALL_LOG_ID,
      contactId: CONTACT_ID,
      sequenceVersionId: PUBLISHED,
      name: 'After a good call v3',
    });
    expect(state.followUpPreview?.holidayCalendarVersion).toBe('holidays.2');
    expect(buildTodayView(state).banners.map(banner => banner.text)).toContain(
      'The call is recorded, but the sequence “After a good call v3” did not start: its dates changed after you previewed them. Read them the new dates on the card and press Record the agreed dates.',
    );

    const after = await bridge.recordAgreedDates({ firmId: FIRM_ID, callLogId: CALL_LOG_ID });
    expect(calls.find(call => call.path === '/calls/follow-up')?.body).toMatchObject({
      callLogId: CALL_LOG_ID,
      followUpPermission: {
        scope: 'agreed_sequence',
        sequenceVersionId: PUBLISHED,
        previewBasis: {
          anchorAt: '2026-09-30T15:05:00.000Z',
          timeZone: 'America/Los_Angeles',
          calendarVersionId: 'holidays.2',
          steps: [{ ordinal: 1, sendAt: '2026-10-05T15:00:00.000Z' }],
        },
      },
    });
    expect(after.pendingAgreement).toBeNull();
    expect(after.notice).toBe('outcome_recorded_sequence_started');
    expect(buildTodayView(after).banners.map(banner => banner.text)).toContain(
      'Agreed on the call: the sequence “After a good call v3”. It has started.',
    );
  });

  it('forgets a preview still on the wire when another firm’s card is opened, even if that read fails (round 3, P2-a)', async () => {
    const OTHER_FIRM = '22222222-2222-4222-8222-222222222222';
    let release: (() => void) | null = null;
    const answers = baseAnswers();
    const api = createAuthedClient({
      baseUrl: 'https://api.example.test/',
      clientVersion: '1.4.0',
      accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
      send: async (url, init) => {
        const path = new URL(url).pathname;
        if (path === '/today/firm') {
          const body = JSON.parse(init.body ?? '{}') as { firmId: string };
          // The other firm's card is refused: it left today's list.
          if (body.firmId === OTHER_FIRM) return { status: 404, body: { error: 'not_found' } };
        }
        if (path !== '/calls/follow-up-preview') {
          return await Promise.resolve(answers[path] ?? { status: 404, body: { error: 'not_found' } });
        }
        const body = JSON.parse(init.body ?? '{}') as { sequenceVersionId: string };
        await new Promise<void>(resolve => {
          release = resolve;
        });
        return {
          status: 200,
          body: {
            sequenceVersionId: body.sequenceVersionId,
            sequenceName: 'Plan',
            version: 1,
            firmTimeZone: 'America/New_York',
            holidayCalendarVersion: 'none.1',
            anchoredAt: '2026-09-30T15:00:00.000Z',
            steps: [],
          },
        };
      },
    });
    const bridge = createTodayBridge({ api, handoff, session });
    await bridge.expand({ firmId: FIRM_ID });
    const pending = bridge.previewFollowUp({ firmId: FIRM_ID, contactId: CONTACT_ID, sequenceVersionId: PUBLISHED });
    await new Promise(resolve => setTimeout(resolve, 0));
    const refused = await bridge.expand({ firmId: OTHER_FIRM });
    expect(refused.expanded).toBeNull();
    (release as (() => void) | null)?.();
    const landed = await pending;
    expect(landed.followUpPreview ?? null).toBeNull();
  });

  it('keeps a pending agreement when another firm’s card is refused, and offers it again on reopening (round 4, P1-I)', async () => {
    const OTHER_FIRM = '22222222-2222-4222-8222-222222222222';
    const CALL_LOG_ID = 'abababab-abab-4bab-8bab-abababababab';
    const preview = {
      sequenceVersionId: PUBLISHED,
      sequenceName: 'After a good call',
      version: 3,
      firmTimeZone: 'America/Los_Angeles',
      holidayCalendarVersion: 'holidays.2',
      anchoredAt: '2026-09-30T15:05:00.000Z',
      steps: [
        {
          ordinal: 1,
          channel: 'call_task',
          templateVersionId: null,
          templateName: null,
          subject: null,
          templateApproved: null,
          dueAt: '2026-10-01T15:00:00.000Z',
          estimatedAt: '2026-10-01T15:00:00.000Z',
        },
      ],
    };
    const answers = baseAnswers({
      '/calls/log': logged([{ kind: 'follow_up_not_granted', reason: 'stale_preview' }]),
      '/calls/follow-up-preview': { status: 200, body: preview },
    });
    const api = createAuthedClient({
      baseUrl: 'https://api.example.test/',
      clientVersion: '1.4.0',
      accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
      send: async (url, init) => {
        const path = new URL(url).pathname;
        if (path === '/today/firm' && (JSON.parse(init.body ?? '{}') as { firmId: string }).firmId === OTHER_FIRM) {
          return { status: 404, body: { error: 'not_found' } };
        }
        return await Promise.resolve(answers[path] ?? { status: 404, body: { error: 'not_found' } });
      },
    });
    const bridge = createTodayBridge({ api, handoff, session });
    await bridge.expand({ firmId: FIRM_ID });
    const stale = await bridge.recordOutcome(
      interested({ scope: 'agreed_sequence', sequenceVersionId: PUBLISHED, previewBasis: BASIS }),
    );
    expect(stale.pendingAgreement?.callLogId).toBe(CALL_LOG_ID);

    const refused = await bridge.expand({ firmId: OTHER_FIRM });
    expect(refused.expanded).toBeNull();
    expect(refused.pendingAgreement?.callLogId).toBe(CALL_LOG_ID);

    const back = await bridge.expand({ firmId: FIRM_ID });
    expect(back.pendingAgreement).toMatchObject({ firmId: FIRM_ID, callLogId: CALL_LOG_ID, sequenceVersionId: PUBLISHED });
    expect(back.followUpPreview).toMatchObject({ firmId: FIRM_ID, contactId: CONTACT_ID, sequenceVersionId: PUBLISHED, refusal: null });
  });

  describe('the pending agreement’s lifecycle (round 5, P0)', () => {
    const OTHER_FIRM = '22222222-2222-4222-8222-222222222222';
    const CALL_LOG_ID = 'abababab-abab-4bab-8bab-abababababab';
    const preview = {
      sequenceVersionId: PUBLISHED,
      sequenceName: 'After a good call',
      version: 3,
      firmTimeZone: 'America/Los_Angeles',
      holidayCalendarVersion: 'holidays.2',
      anchoredAt: '2026-09-30T15:05:00.000Z',
      steps: [
        {
          ordinal: 1,
          channel: 'call_task',
          templateVersionId: null,
          templateName: null,
          subject: null,
          templateApproved: null,
          dueAt: '2026-10-01T15:00:00.000Z',
          estimatedAt: '2026-10-01T15:00:00.000Z',
        },
      ],
    };

    /** A bridge whose card A holds a stale agreement; `other` says how firm B's card answers. */
    async function staleAt(other: 'ok' | 'offline') {
      const answers = baseAnswers({
        '/calls/log': logged([{ kind: 'follow_up_not_granted', reason: 'stale_preview' }]),
        '/calls/follow-up-preview': { status: 200, body: preview },
      });
      const api = createAuthedClient({
        baseUrl: 'https://api.example.test/',
        clientVersion: '1.4.0',
        accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
        send: async (url, init) => {
          const path = new URL(url).pathname;
          if (path === '/today/firm' && (JSON.parse(init.body ?? '{}') as { firmId: string }).firmId === OTHER_FIRM) {
            if (other === 'offline') throw new Error('the network is down');
            return { status: 200, body: { ...(answers['/today/firm']?.body as object), firmId: OTHER_FIRM } };
          }
          return await Promise.resolve(answers[path] ?? { status: 404, body: { error: 'not_found' } });
        },
      });
      const bridge = createTodayBridge({ api, handoff, session });
      await bridge.expand({ firmId: FIRM_ID });
      const stale = await bridge.recordOutcome(
        interested({ scope: 'agreed_sequence', sequenceVersionId: PUBLISHED, previewBasis: BASIS }),
      );
      expect(stale.pendingAgreement?.callLogId).toBe(CALL_LOG_ID);
      return bridge;
    }

    it('keeps it when the card is closed, and offers it again on reopening', async () => {
      const bridge = await staleAt('ok');
      const closed = await bridge.collapse();
      expect(closed.pendingAgreement?.callLogId).toBe(CALL_LOG_ID);
      const back = await bridge.expand({ firmId: FIRM_ID });
      expect(back.pendingAgreement?.callLogId).toBe(CALL_LOG_ID);
      expect(back.followUpPreview).toMatchObject({ firmId: FIRM_ID, sequenceVersionId: PUBLISHED, refusal: null });
    });

    it('keeps it when another firm’s card cannot be read offline', async () => {
      const bridge = await staleAt('offline');
      const offline = await bridge.expand({ firmId: OTHER_FIRM });
      expect(offline.pendingAgreement?.callLogId).toBe(CALL_LOG_ID);
    });

    it('gives it up when another firm’s card opens', async () => {
      const bridge = await staleAt('ok');
      const other = await bridge.expand({ firmId: OTHER_FIRM });
      expect(other.expanded?.firmId).toBe(OTHER_FIRM);
      expect(other.pendingAgreement ?? null).toBeNull();
    });

    it('drops it, and every id of it, on sign-out or another identity', async () => {
      const bridge = await staleAt('ok');
      const after = await bridge.forget();
      expect(after.pendingAgreement ?? null).toBeNull();
      expect(after.followUpPreview ?? null).toBeNull();
      const carried = JSON.stringify(after);
      for (const id of [CALL_LOG_ID, CONTACT_ID, PUBLISHED]) expect(carried).not.toContain(id);
    });
  });

  it('keeps a late call of the last person’s out of the next person’s card, and does not clear theirs (round 6, P0)', async () => {
    /*
     * Identity A records a call whose answer is held inside the server. A signs out and
     * B signs in; B records a call of their own that keeps an agreement pending. Then
     * A's answer lands, and A's continuation is held again in the list refresh that
     * follows it. B's state is read before A's answer, during A's held refresh, and
     * after A's call has finished: none of A's ids appears, and B's pending agreement
     * is B's throughout — the guard's late clear must not erase it.
     */
    const OTHER_FIRM = '22222222-2222-4222-8222-222222222222';
    const B_CONTACT = 'dededede-dede-4ede-8ede-dededededede';
    const B_ROUTE = '55555555-5555-4555-8555-555555555555';
    const A_CALL = 'abababab-abab-4bab-8bab-abababababab';
    const B_CALL = 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc';
    const answers = baseAnswers();
    const staleLog = (callLogId: string): HttpAnswer => {
      const answer = logged([{ kind: 'follow_up_not_granted', reason: 'stale_preview' }]);
      const body = answer.body as { result: Record<string, unknown> };
      return { ...answer, body: { ...body, result: { ...body.result, callLogId } } };
    };
    let logCalls = 0;
    let releaseLog: (() => void) | null = null;
    let holdRefresh = false;
    let releaseRefresh: (() => void) | null = null;
    const api = createAuthedClient({
      baseUrl: 'https://api.example.test/',
      clientVersion: '1.4.0',
      accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
      send: async (url, init) => {
        const path = new URL(url).pathname;
        const body = JSON.parse(init.body ?? '{}') as { firmId?: string; sequenceVersionId?: string };
        if (path === '/today/firm' && body.firmId === OTHER_FIRM) {
          return {
            status: 200,
            body: {
              ...firmPage,
              firmId: OTHER_FIRM,
              firmName: 'Contoso Test Partners',
              routes: [{ routeId: B_ROUTE, contactId: B_CONTACT, e164: '+14015550142', version: 1, eligibility: 'candidate' }],
            },
          };
        }
        if (path === '/calls/log') {
          logCalls += 1;
          if (logCalls === 1) {
            await new Promise<void>(resolve => {
              releaseLog = resolve;
            });
            return staleLog(A_CALL);
          }
          return staleLog(B_CALL);
        }
        if (path === '/calls/follow-up-preview') {
          return {
            status: 200,
            body: {
              sequenceVersionId: body.sequenceVersionId,
              sequenceName: 'After a good call',
              version: 3,
              firmTimeZone: 'America/New_York',
              holidayCalendarVersion: 'none.1',
              anchoredAt: '2026-09-30T15:00:00.000Z',
              steps: [],
            },
          };
        }
        return await Promise.resolve(answers[path] ?? { status: 404, body: { error: 'not_found' } });
      },
    });
    const heldSession = {
      state: session.state,
      refreshToday: async () => {
        if (holdRefresh) {
          await new Promise<void>(resolve => {
            releaseRefresh = resolve;
          });
        }
        return null;
      },
    };
    const sessionGeneration = { value: 1 };
    const bridge = guardIdentity(createTodayBridge({ api, handoff, session: heldSession }), () => sessionGeneration.value);
    const agreeTo = { scope: 'agreed_sequence' as const, sequenceVersionId: PUBLISHED, previewBasis: BASIS };
    const aIds = [A_CALL, CONTACT_ID, FIRM_ID];
    const expectB = (state: Awaited<ReturnType<typeof bridge.state>>, when: string): void => {
      const carried = JSON.stringify(state);
      for (const id of aIds) expect(carried, `${when}: B's state carries A's ${id}`).not.toContain(id);
      expect(state.pendingAgreement, `${when}: B's pending agreement`).toEqual({
        firmId: OTHER_FIRM,
        callLogId: B_CALL,
        contactId: B_CONTACT,
        sequenceVersionId: PUBLISHED,
        name: 'After a good call v3',
      });
    };

    // A: the card is open, the call is recorded, and its answer is held.
    await bridge.expand({ firmId: FIRM_ID });
    let aSettled = false;
    const late = bridge.recordOutcome(interested(agreeTo)).finally(() => {
      aSettled = true;
    });
    for (let tick = 0; tick < 200 && releaseLog === null; tick += 1) await new Promise(resolve => setTimeout(resolve, 1));
    expect(releaseLog, 'A’s call reached the server').not.toBeNull();

    // A signs out, B signs in: the session moves, the transition's reset runs.
    sessionGeneration.value = 2;
    await resetBridges([bridge]);

    // B records a call of their own, which keeps an agreement pending.
    await bridge.expand({ firmId: OTHER_FIRM });
    const recorded = await bridge.recordOutcome({ ...interested(agreeTo, B_CONTACT), firmId: OTHER_FIRM });
    expectB(recorded, 'B’s own answer');
    expectB(await bridge.state(), 'before A’s answer lands');

    // A's answer lands; its continuation is held in the refresh that would follow it.
    holdRefresh = true;
    (releaseLog as (() => void) | null)?.();
    for (let tick = 0; tick < 200 && !aSettled && releaseRefresh === null; tick += 1) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    expectB(await bridge.state(), 'while A’s call is still finishing');

    (releaseRefresh as (() => void) | null)?.();
    const lateAnswer = await late;
    // A's caller is told nothing of B's either.
    expect(lateAnswer.pendingAgreement ?? null).toBeNull();
    expect(JSON.stringify(lateAnswer)).not.toContain(B_CALL);
    expectB(await bridge.state(), 'after A’s call finished');
  });

  it('forgets a preview still on the wire when the card is closed (round 2, P2)', async () => {
    let release: (() => void) | null = null;
    const answers = baseAnswers();
    const api = createAuthedClient({
      baseUrl: 'https://api.example.test/',
      clientVersion: '1.4.0',
      accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
      send: async (url, init) => {
        const path = new URL(url).pathname;
        if (path !== '/calls/follow-up-preview') {
          return await Promise.resolve(answers[path] ?? { status: 404, body: { error: 'not_found' } });
        }
        const body = JSON.parse(init.body ?? '{}') as { sequenceVersionId: string };
        await new Promise<void>(resolve => {
          release = resolve;
        });
        return {
          status: 200,
          body: {
            sequenceVersionId: body.sequenceVersionId,
            sequenceName: 'Plan',
            version: 1,
            firmTimeZone: 'America/New_York',
            holidayCalendarVersion: 'none.1',
            anchoredAt: '2026-09-30T15:00:00.000Z',
            steps: [],
          },
        };
      },
    });
    const bridge = createTodayBridge({ api, handoff, session });
    await bridge.expand({ firmId: FIRM_ID });
    const pending = bridge.previewFollowUp({ firmId: FIRM_ID, contactId: CONTACT_ID, sequenceVersionId: PUBLISHED });
    await new Promise(resolve => setTimeout(resolve, 0));
    await bridge.collapse();
    (release as (() => void) | null)?.();
    await pending;
    const reopened = await bridge.expand({ firmId: FIRM_ID });
    expect(reopened.followUpPreview ?? null).toBeNull();
  });

  it('drops a preview answer that lands after a newer request (review of S3, P2-b)', async () => {
    // The first request's answer is held until the second has been answered.
    let release: (() => void) | null = null;
    const answers = baseAnswers();
    const calls: string[] = [];
    const api = createAuthedClient({
      baseUrl: 'https://api.example.test/',
      clientVersion: '1.4.0',
      accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
      send: async (url, init) => {
        const path = new URL(url).pathname;
        if (path !== '/calls/follow-up-preview') {
          return await Promise.resolve(answers[path] ?? { status: 404, body: { error: 'not_found' } });
        }
        const body = JSON.parse(init.body ?? '{}') as { sequenceVersionId: string };
        calls.push(body.sequenceVersionId);
        const answer: HttpAnswer = {
          status: 200,
          body: {
            sequenceVersionId: body.sequenceVersionId,
            sequenceName: 'Plan',
            version: 1,
            firmTimeZone: 'America/New_York',
            holidayCalendarVersion: 'none.1',
            anchoredAt: '2026-09-30T15:00:00.000Z',
            steps: [],
          },
        };
        if (calls.length === 1) {
          await new Promise<void>(resolve => {
            release = resolve;
          });
        }
        return answer;
      },
    });
    const bridge = createTodayBridge({ api, handoff, session });
    await bridge.expand({ firmId: FIRM_ID });
    const older = bridge.previewFollowUp({ firmId: FIRM_ID, contactId: CONTACT_ID, sequenceVersionId: DRAFT });
    await new Promise(resolve => setTimeout(resolve, 0));
    const newer = await bridge.previewFollowUp({ firmId: FIRM_ID, contactId: CONTACT_ID, sequenceVersionId: PUBLISHED });
    expect(newer.followUpPreview?.sequenceVersionId).toBe(PUBLISHED);
    (release as (() => void) | null)?.();
    const late = await older;
    expect(late.followUpPreview?.sequenceVersionId).toBe(PUBLISHED);
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
    // The recovery's own refusals read as sentences, not codes (round 4, P2).
    expect(noticeSentence('not_call_actor')).toBe('Only the person who made that call can record what was agreed on it.');
    expect(noticeSentence('call_too_old')).toContain('happened, and been recorded, within the last hour');
    // A single e-mail names the template; a refused grant says so.
    expect(
      agreementSentence({ scope: 'single_email', name: 'The overview', granted: true, started: null, reason: null }),
    ).toBe('Agreed on the call: one e-mail, “The overview”.');
  });
});
