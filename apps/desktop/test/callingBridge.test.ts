import { describe, expect, it, vi } from 'vitest';
import { CALL_ANNOUNCEMENT, DEFAULT_VOICEMAIL_SCRIPT } from '@fss/contracts';
import { createTodayBridge } from '../src/main/todayBridge.ts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { createCallActivity } from '../src/main/callActivity.ts';
import type { HttpAnswer } from '../src/main/apiClient.ts';
import type { DialHandoff } from '../src/main/dialHandoff.ts';
import { OPERATIONS } from '../src/shared/operations.ts';
import type { TodayFirm } from '../src/renderer/todayContract.ts';

/**
 * The dial path with `calling_provider = twilio` (slice C1), in the main process.
 *
 * Session first, then the token, and the page is handed those two and nothing else — the
 * number stays on the server. The next outcome for the firm names the session. A refusal
 * comes back as its code for the page to put into words, and "tel" is what every doubt
 * falls back to. No real business, person or number appears (NANP 555-01XX).
 */

const FIRM_ID = '11111111-1111-4111-8111-111111111111';
const ROUTE_ID = '44444444-4444-4444-8444-444444444444';
const CONTACT_ID = '77777777-7777-4777-8777-777777777777';
const IDENTITY_ID = '55555555-5555-4555-8555-555555555555';
const SESSION_ID = '88888888-8888-4888-8888-888888888888';
const USER_ID = '99999999-9999-4999-8999-999999999999';
const PROSPECT = '+14015550187';
const CALLER = '+14015550100';

const firmPage = (): TodayFirm => ({
  firmId: FIRM_ID,
  firmName: 'Northwind Test Holdings',
  snapshotDate: '2026-09-21',
  lane: 'due_work',
  counts: { replies: 0, emailsDue: 0, callsDue: 1 },
  tasks: [
    {
      itemId: '33333333-3333-4333-8333-333333333333',
      contactId: CONTACT_ID,
      contactName: 'Dana Example',
      kind: 'call_due',
      lane: 'due_work',
      dueAt: '2026-09-21T13:00:00.000Z',
      status: 'open',
      automated: false,
      snoozeUntil: null,
    },
  ],
  routes: [{ routeId: ROUTE_ID, contactId: CONTACT_ID, e164: PROSPECT, version: 3, eligibility: 'usable' }],
  callingIdentityId: IDENTITY_ID,
});

const calling = (nextAttempt: number | null = 1): HttpAnswer => ({
  status: 200,
  body: {
    provider: 'twilio',
    cadence: {
      unansweredAttempts: nextAttempt === null ? 4 : nextAttempt - 1,
      nextAttempt,
      limit: 4,
      parked: nextAttempt === null,
      refusal: nextAttempt === null ? 'call_attempts_exhausted' : null,
    },
    voicemailTemplate: DEFAULT_VOICEMAIL_SCRIPT,
    callerName: 'Sam Example',
    callbackNumber: CALLER,
  },
});
const accepted = (result: unknown): HttpAnswer => ({ status: 200, body: { status: 'accepted', replayed: false, result } });
const refused = (reason: string): HttpAnswer => ({ status: 409, body: { status: 'refused', replayed: false, reason } });
const tokenAnswer: HttpAnswer = {
  status: 200,
  body: { token: 'twilio.voice.jwt', identity: USER_ID, expiresAt: '2026-09-21T15:00:00.000Z' },
};

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly body: Record<string, unknown> | null;
}

function world(answers: Record<string, HttpAnswer>) {
  return worldWith(() => undefined, answers);
}

function worldWith(
  dynamic: (path: string) => HttpAnswer | Promise<HttpAnswer> | undefined,
  answers: Record<string, HttpAnswer>,
) {
  const sent: Sent[] = [];
  const api = createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: '1.4.0',
    accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
    send: async (url, init) => {
      const parsed = new URL(url);
      sent.push({
        method: init.method,
        path: parsed.pathname,
        query: parsed.search,
        body: init.body === undefined ? null : (JSON.parse(init.body) as Record<string, unknown>),
      });
      if (parsed.pathname === '/today/firm') return await Promise.resolve({ status: 200, body: firmPage() });
      return await Promise.resolve(dynamic(parsed.pathname) ?? answers[parsed.pathname] ?? { status: 404, body: { error: 'not_found' } });
    },
  });
  const opened: string[] = [];
  const handoff: DialHandoff = {
    checkSetup: async () => await Promise.resolve({ ready: true }),
    open: async input => {
      opened.push(input.telUri);
      return await Promise.resolve({ status: 'opened', e164: input.e164 });
    },
  };
  const activity = createCallActivity();
  const bridge = createTodayBridge({
    api,
    handoff,
    callActivity: activity,
    session: {
      state: async () =>
        await Promise.resolve({
          online: true,
          stale: false,
          asOf: '2026-09-21T13:00:00.000Z',
          mayMutate: true,
          device: { role: 'salesperson' as const },
          today: { snapshotDate: '2026-09-21', businessTimeZone: 'America/New_York', cards: [] },
        }),
      refreshToday: async () => await Promise.resolve(null),
    },
  });
  return { bridge, sent, opened, activity };
}

describe('calling from Callie, in the main process', () => {
  it('creates the session, then fetches the token, and hands the page only those', async () => {
    const w = world({
      '/calls/calling': calling(1),
      '/calls/session': accepted({ sessionId: SESSION_ID, expiresAt: '2026-09-21T14:01:00.000Z' }),
      '/calls/access-token': tokenAnswer,
    });
    await w.bridge.expand({ firmId: FIRM_ID });
    w.sent.length = 0;

    const started = await w.bridge.startCall({ firmId: FIRM_ID, contactId: CONTACT_ID, routeId: ROUTE_ID });

    expect(w.sent.map(entry => `${entry.method} ${entry.path}`)).toEqual([
      'GET /calls/calling',
      'POST /calls/session',
      'POST /calls/access-token',
    ]);
    expect(w.sent[1]?.body).toMatchObject({
      firmId: FIRM_ID,
      contactId: CONTACT_ID,
      routeId: ROUTE_ID,
      routeVersion: 3,
      callingIdentityId: IDENTITY_ID,
    });
    expect(w.sent[1]?.body).not.toHaveProperty('e164');
    expect(started).toEqual({
      ok: true,
      sessionId: SESSION_ID,
      token: 'twilio.voice.jwt',
      attempt: 1,
      voicemailScript: `Hi Dana, this is Sam Example from Callie. I'm calling about how Northwind Test Holdings handles maintenance requests after hours. I'll try you again, or you can reach me at ${CALLER}. Thanks.`,
    });
    // What crosses to the page parses, and carries no number of the prospect's.
    const parsed = OPERATIONS['calling.start'].output.parse(started);
    expect(JSON.stringify(parsed)).not.toContain(PROSPECT);
    expect(w.opened).toEqual([]);
    expect(CALL_ANNOUNCEMENT.length).toBeGreaterThan(0);
  });

  it('names the session on the outcome recorded next for that firm and number, once', async () => {
    const w = world({
      '/calls/calling': calling(2),
      '/calls/session': accepted({ sessionId: SESSION_ID, expiresAt: '2026-09-21T14:01:00.000Z' }),
      '/calls/access-token': tokenAnswer,
      '/calls/log': accepted({ callLogId: '12121212-1212-4212-8212-121212121212', followUps: [] }),
    });
    await w.bridge.expand({ firmId: FIRM_ID });
    const started = await w.bridge.startCall({ firmId: FIRM_ID, contactId: null, routeId: ROUTE_ID });
    expect(started).toMatchObject({ ok: true, attempt: 2, voicemailScript: null });
    // The outcome form names this call: the number the card already shows.
    expect((await w.bridge.state()).lastCall).toMatchObject({ firmId: FIRM_ID, routeId: ROUTE_ID, e164: PROSPECT });

    const outcome = {
      firmId: FIRM_ID,
      itemId: null,
      contactId: null,
      routeId: null,
      outcome: 'no_answer' as const,
      note: '',
      callback: null,
      doNotCallCoversAllContact: false,
      followUpPermission: null,
    };
    await w.bridge.recordOutcome(outcome);
    const logs = w.sent.filter(entry => entry.path === '/calls/log');
    expect(logs[0]?.body).toMatchObject({ callSessionId: SESSION_ID, routeId: ROUTE_ID, outcome: 'no_answer' });
    await w.bridge.recordOutcome(outcome);
    expect(w.sent.filter(entry => entry.path === '/calls/log')[1]?.body).not.toHaveProperty('callSessionId');
  });

  it('a start cancelled while its token was pending never becomes the outcome target, even after a second start', async () => {
    const SESSION_B = '66666666-6666-4666-8666-666666666666';
    let sessions = 0;
    let firstToken: ((answer: HttpAnswer) => void) | null = null;
    const w = worldWith(
      path => {
        if (path === '/calls/session') {
          sessions += 1;
          return accepted({ sessionId: sessions === 1 ? SESSION_ID : SESSION_B, expiresAt: '2026-09-21T14:01:00.000Z' });
        }
        if (path === '/calls/access-token' && firstToken === null) {
          return new Promise<HttpAnswer>(resolve => {
            firstToken = resolve;
          });
        }
        return undefined;
      },
      {
        '/calls/calling': calling(2),
        '/calls/access-token': tokenAnswer,
        '/calls/log': accepted({ callLogId: '12121212-1212-4212-8212-121212121212', followUps: [] }),
      },
    );
    await w.bridge.expand({ firmId: FIRM_ID });
    // A: its token request is on the wire when David hangs up.
    const a = w.bridge.startCall({ firmId: FIRM_ID, contactId: null, routeId: ROUTE_ID });
    await vi.waitFor(() => {
      expect(firstToken).not.toBeNull();
    });
    await w.bridge.cancelCall();
    // B, to the same firm and number, completes.
    expect(await w.bridge.startCall({ firmId: FIRM_ID, contactId: null, routeId: ROUTE_ID })).toMatchObject({
      ok: true,
      sessionId: SESSION_B,
    });
    // A's token arrives late: A binds nothing.
    (firstToken as unknown as (answer: HttpAnswer) => void)(tokenAnswer);
    expect(await a).toEqual({ ok: false, reason: 'call_cancelled' });
    await w.bridge.recordOutcome({
      firmId: FIRM_ID,
      itemId: null,
      contactId: null,
      routeId: null,
      outcome: 'voicemail_left',
      note: '',
      callback: null,
      doNotCallCoversAllContact: false,
      followUpPermission: null,
    });
    expect(w.sent.find(entry => entry.path === '/calls/log')?.body).toMatchObject({ callSessionId: SESSION_B });
  });

  it('a start cancelled after it bound its session unbinds it: the next outcome names no session', async () => {
    const w = world({
      '/calls/calling': calling(1),
      '/calls/session': accepted({ sessionId: SESSION_ID, expiresAt: '2026-09-21T14:01:00.000Z' }),
      '/calls/access-token': tokenAnswer,
      '/calls/log': accepted({ callLogId: '12121212-1212-4212-8212-121212121212', followUps: [] }),
    });
    await w.bridge.expand({ firmId: FIRM_ID });
    expect((await w.bridge.startCall({ firmId: FIRM_ID, contactId: null, routeId: ROUTE_ID })).ok).toBe(true);
    await w.bridge.cancelCall();
    expect((await w.bridge.state()).lastCall).toBeNull();
    await w.bridge.recordOutcome({
      firmId: FIRM_ID,
      itemId: null,
      contactId: null,
      routeId: null,
      outcome: 'no_answer',
      note: '',
      callback: null,
      doNotCallCoversAllContact: false,
      followUpPermission: null,
    });
    expect(w.sent.find(entry => entry.path === '/calls/log')?.body).not.toHaveProperty('callSessionId');
  });

  it('answers a session refusal as its code and asks for no token', async () => {
    for (const reason of ['firm_suppressed', 'outside_calling_window', 'telephony_budget_exhausted', 'call_attempts_exhausted']) {
      const w = world({ '/calls/calling': calling(1), '/calls/session': refused(reason), '/calls/access-token': tokenAnswer });
      await w.bridge.expand({ firmId: FIRM_ID });
      expect(await w.bridge.startCall({ firmId: FIRM_ID, contactId: null, routeId: ROUTE_ID })).toEqual({ ok: false, reason });
      expect(w.sent.some(entry => entry.path === '/calls/access-token')).toBe(false);
      expect((await w.bridge.state()).lastCall).toBeNull();
    }
  });

  it('answers tel only for the server’s calling-off answer; no answer, a 503 or another refusal is unavailable', async () => {
    const off = world({});
    expect(await off.bridge.callingStatus({ firmId: FIRM_ID })).toEqual({ provider: 'tel', cadence: null });
    const down = world({ '/calls/calling': { status: 503, body: {} } });
    expect(await down.bridge.callingStatus({ firmId: FIRM_ID })).toEqual({ provider: 'unavailable', cadence: null });
    const notYours = world({ '/calls/calling': { status: 404, body: { error: 'firm_unknown' } } });
    expect(await notYours.bridge.callingStatus({ firmId: FIRM_ID })).toEqual({ provider: 'unavailable', cadence: null });
    const on = world({ '/calls/calling': calling(3) });
    expect(await on.bridge.callingStatus({ firmId: FIRM_ID })).toMatchObject({ provider: 'twilio', cadence: { nextAttempt: 3 } });
    expect(on.sent[0]?.query).toBe(`?firmId=${FIRM_ID}`);
  });

  it('reads the open card’s dial advice again after Resume calling', async () => {
    // `/dial/check` answers "not callable" while parked, "callable" once resumed.
    let callable = false;
    const dialCheck = (): HttpAnswer => ({
      status: 200,
      body: {
        advice: {
          firmId: FIRM_ID,
          callable,
          reasons: callable ? [] : ['scoped_pause'],
          routeId: ROUTE_ID,
          e164: PROSPECT,
          telUri: callable ? `tel:${PROSPECT}` : null,
          firmTimeZone: 'America/New_York',
          firmLocalTime: '10:05',
          at: '2026-09-21T14:05:00.000Z',
        },
      },
    });
    const dynamic = worldWith(path => (path === '/dial/check' ? dialCheck() : undefined), {
      '/calls/calling': calling(1),
      '/calls/cadence/resume': accepted({ firmId: FIRM_ID, releasedHoldId: SESSION_ID }),
    });
    await dynamic.bridge.expand({ firmId: FIRM_ID });
    expect((await dynamic.bridge.state()).dialAdvice[0]?.callable).toBe(false);
    callable = true;
    await dynamic.bridge.resumeCalling({ firmId: FIRM_ID });
    expect((await dynamic.bridge.state()).dialAdvice[0]?.callable).toBe(true);
    expect(dynamic.sent.map(entry => `${entry.method} ${entry.path}`).slice(-3)).toEqual([
      'POST /calls/cadence/resume',
      'GET /calls/calling',
      'POST /dial/check',
    ]);
  });

  it('keeps the live-call flag the updater waits on, and tells it when the call ends', async () => {
    const w = world({});
    let ended = 0;
    w.activity.onEnded(() => {
      ended += 1;
    });
    expect(await w.bridge.setCallActive({ active: true })).toEqual({ active: true });
    expect(w.activity.active()).toBe(true);
    expect(await w.bridge.setCallActive({ active: false })).toEqual({ active: false });
    expect(ended).toBe(1);
  });

  it('reads the history and a recording through the API, never Twilio', async () => {
    const w = world({
      '/calls/history': { status: 200, body: { calls: [] } },
      '/calls/recording': { status: 200, body: { sessionId: SESSION_ID, contentType: 'audio/mpeg', audioBase64: 'AAAA' } },
    });
    expect(await w.bridge.callHistory({ firmId: FIRM_ID })).toEqual({ calls: [] });
    expect(await w.bridge.callRecording({ sessionId: SESSION_ID })).toMatchObject({ recording: { audioBase64: 'AAAA' }, reason: null });
    expect(w.sent.every(entry => entry.method === 'GET')).toBe(true);
    const none = world({});
    expect(await none.bridge.callRecording({ sessionId: SESSION_ID })).toEqual({ recording: null, reason: 'not_found' });
  });
});
