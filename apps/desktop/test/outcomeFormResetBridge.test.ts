import { DEFAULT_VOICEMAIL_SCRIPT, logCallOutcomeCommandSchema } from '@fss/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createTodayBridge } from '../src/main/todayBridge.ts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { createCallActivity } from '../src/main/callActivity.ts';
import type { HttpAnswer } from '../src/main/apiClient.ts';
import type { DialHandoff } from '../src/main/dialHandoff.ts';
import type { TodayFirm } from '../src/renderer/todayContract.ts';

/**
 * The outcome form reset (X1F rule 1), in the main process: a request that carries the form's
 * command id is forwarded as it is. The follow-up review's bridge probes, made permanent, and
 * the two retries the coordinator named: a lost answer, a new call on the same number, then
 * Record again; and a success whose IPC answer was lost, retried against a server that keeps
 * receipts. No real business, person or number appears (NANP 555-01XX).
 */

const FIRM_ID = '11111111-1111-4111-8111-111111111111';
const ROUTE_ID = '44444444-4444-4444-8444-444444444444';
const CONTACT_ID = '77777777-7777-4777-8777-777777777777';
const IDENTITY_ID = '55555555-5555-4555-8555-555555555555';
const SESSION_ID = '88888888-8888-4888-8888-888888888888';
const USER_ID = '99999999-9999-4999-8999-999999999999';
const REQUEST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
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


const CMD_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CMD_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const recordInput = {firmId:FIRM_ID, routeId:ROUTE_ID, contactId:CONTACT_ID, itemId:null, outcome:'no_answer' as const, note:'', callback:null, doNotCallCoversAllContact:false, followUpPermission:null, commandId:CMD_A};
// The request the form sends for "the call just placed" since the reset: the session it
// resolved when it opened is in the request (the probe's own input left it to the bridge).
const resolvedInput = {...recordInput, callSessionId: SESSION_ID};
const answers = {
  '/calls/calling':calling(1),
  '/calls/session':accepted({sessionId:SESSION_ID, expiresAt:'2026-09-21T14:01:00.000Z'}),
  '/calls/access-token':tokenAnswer,
  '/calls/log':accepted(null),
};
describe('X1 bridge follow-up probes', () => {
  it('an IPC-lost success retry keeps exactly the same HTTP body', async () => {
    const w = world(answers);
    await w.bridge.expand({firmId:FIRM_ID});
    expect((await w.bridge.startCall({firmId:FIRM_ID, contactId:CONTACT_ID, routeId:ROUTE_ID, requestId:REQUEST_A})).ok).toBe(true);
    // The API's success reached main, but the returned TodayState never reached the form.
    await w.bridge.recordOutcome(resolvedInput);
    await w.bridge.recordOutcome(resolvedInput);
    const sent = w.sent.filter(s=>s.path==='/calls/log');
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body!['callSessionId']).toBe(SESSION_ID);
    expect(sent[1]!.body).toEqual(sent[0]!.body);
  });
  it('a retry after another same-route call still names the original session', async () => {
    let sessions = 0;
    const w = worldWith(path => {
      if(path==='/calls/session') return accepted({sessionId: sessions++===0 ? SESSION_ID : REQUEST_B, expiresAt:'2026-09-21T14:01:00.000Z'});
      if(path==='/calls/log') return {status:503, body:{}};
      return undefined;
    }, answers);
    await w.bridge.expand({firmId:FIRM_ID});
    await w.bridge.startCall({firmId:FIRM_ID, contactId:CONTACT_ID, routeId:ROUTE_ID, requestId:REQUEST_A});
    await w.bridge.recordOutcome(resolvedInput);
    await w.bridge.startCall({firmId:FIRM_ID, contactId:CONTACT_ID, routeId:ROUTE_ID, requestId:REQUEST_B});
    await w.bridge.recordOutcome(resolvedInput);
    const sent = w.sent.filter(s=>s.path==='/calls/log');
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body!['callSessionId']).toBe(SESSION_ID);
    // Byte for byte: the same JSON under the same id, whatever was dialled since.
    expect(JSON.stringify(sent[1]!.body)).toBe(JSON.stringify(sent[0]!.body));
    expect(sent[1]!.body!['commandId']).toBe(CMD_A);
  });
  it('overlapping answers belong to their submitted command ids', async () => {
    const pending:((answer:HttpAnswer)=>void)[] = [];
    const w = worldWith(path=> path==='/calls/log' ? new Promise(resolve=>pending.push(resolve)) : undefined, answers);
    const a = w.bridge.recordOutcome({...recordInput, callSessionId:REQUEST_A});
    const b = w.bridge.recordOutcome({...recordInput, callSessionId:REQUEST_B, commandId:CMD_B});
    await vi.waitFor(()=>expect(pending).toHaveLength(2));
    pending[1]!(refused('step_ineligible'));
    expect((await b).outcomeAnswer).toEqual({commandId:CMD_B, recorded:false, reason:'step_ineligible'});
    pending[0]!(accepted(null));
    expect((await a).outcomeAnswer).toEqual({commandId:CMD_A, recorded:true, reason:null});
  });
  it('an answer crossing sign-out has no outcomeAnswer', async () => {
    let finish!:(answer:HttpAnswer)=>void;
    const w = worldWith(path=> path==='/calls/log' ? new Promise(resolve=>finish=resolve) : undefined, answers);
    const pending = w.bridge.recordOutcome(recordInput);
    await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
    await w.bridge.forget();
    finish(accepted(null));
    expect((await pending).outcomeAnswer).toBeUndefined();
  });
  it('new and omitted renderer command ids both satisfy the current calls/log schema', async () => {
    const w = world(answers);
    await w.bridge.recordOutcome(recordInput);
    const { commandId: _omitted, ...old } = recordInput;
    await w.bridge.recordOutcome(old);
    const sent = w.sent.filter(s=>s.path==='/calls/log');
    for(const s of sent) expect(logCallOutcomeCommandSchema.safeParse(s.body).success).toBe(true);
    expect(sent[0]!.body!['commandId']).toBe(CMD_A);
    expect(sent[1]!.body!['commandId']).not.toBe(CMD_A);
  });

  it('a success whose IPC answer was lost is answered from the stored receipt on retry, never command_payload_mismatch', async () => {
    // A server that keeps receipts by command id, as runCommand does: the same body replays the
    // stored answer; a different body under the same id is refused.
    const receipts = new Map<string, string>();
    const replays: boolean[] = [];
    const sent: Sent[] = [];
    let sessions = 0;
    const w = worldWith(path => {
      if (path === '/calls/session') return accepted({ sessionId: sessions++ === 0 ? SESSION_ID : REQUEST_B, expiresAt: '2026-09-21T14:01:00.000Z' });
      if (path !== '/calls/log') return undefined;
      const body = sent.at(-1)!.body!;
      const id = String(body['commandId']);
      const bytes = JSON.stringify(body);
      const stored = receipts.get(id);
      if (stored === undefined) {
        receipts.set(id, bytes);
        replays.push(false);
        return accepted(null);
      }
      if (stored !== bytes) return refused('command_payload_mismatch');
      replays.push(true);
      return { status: 200, body: { status: 'accepted', replayed: true, result: null } };
    }, answers);
    // The world records every request before answering it; the server above reads the last one.
    const push = w.sent.push.bind(w.sent);
    w.sent.push = (...entries: Sent[]): number => {
      sent.push(...entries);
      return push(...entries);
    };
    await w.bridge.expand({ firmId: FIRM_ID });
    await w.bridge.startCall({ firmId: FIRM_ID, contactId: CONTACT_ID, routeId: ROUTE_ID, requestId: REQUEST_A });
    // The first answer reaches main and is lost on the way to the window; then another call is
    // placed on the same number before David presses Record again.
    const first = await w.bridge.recordOutcome(resolvedInput);
    expect(first.outcomeAnswer?.recorded).toBe(true);
    await w.bridge.startCall({ firmId: FIRM_ID, contactId: CONTACT_ID, routeId: ROUTE_ID, requestId: REQUEST_B });
    const retry = await w.bridge.recordOutcome(resolvedInput);
    expect(replays).toEqual([false, true]);
    expect(retry.outcomeAnswer).toEqual({ commandId: CMD_A, recorded: true, reason: null });
  });

  it('with a command id nothing is filled in from the last call or the last session', async () => {
    const w = world(answers);
    await w.bridge.expand({ firmId: FIRM_ID });
    await w.bridge.startCall({ firmId: FIRM_ID, contactId: CONTACT_ID, routeId: ROUTE_ID, requestId: REQUEST_A });
    // The form resolved no call (it opened before this call was placed): the request says so.
    await w.bridge.recordOutcome({ ...recordInput, routeId: null, contactId: null });
    const body = w.sent.filter(entry => entry.path === '/calls/log')[0]!.body!;
    expect(body).not.toHaveProperty('callSessionId');
    expect(body).not.toHaveProperty('routeId');
    expect(body).not.toHaveProperty('contactId');
  });

  it('the last call carries its session, and recording that call clears it; a newer call on the same number stays', async () => {
    let sessions = 0;
    const w = worldWith(path => {
      if (path === '/calls/session') return accepted({ sessionId: sessions++ === 0 ? SESSION_ID : REQUEST_B, expiresAt: '2026-09-21T14:01:00.000Z' });
      return undefined;
    }, answers);
    await w.bridge.expand({ firmId: FIRM_ID });
    await w.bridge.startCall({ firmId: FIRM_ID, contactId: CONTACT_ID, routeId: ROUTE_ID, requestId: REQUEST_A });
    expect((await w.bridge.refresh({})).lastCall?.callSessionId).toBe(SESSION_ID);
    // Call B is placed on the same number before A's retry lands: A's success leaves B.
    await w.bridge.startCall({ firmId: FIRM_ID, contactId: CONTACT_ID, routeId: ROUTE_ID, requestId: REQUEST_B });
    expect((await w.bridge.recordOutcome(resolvedInput)).lastCall?.callSessionId).toBe(REQUEST_B);
    // B recorded: it is no longer "the call just placed".
    expect((await w.bridge.recordOutcome({ ...resolvedInput, callSessionId: REQUEST_B, commandId: CMD_B })).lastCall ?? null).toBeNull();
  });
});
