import { describe, expect, it } from 'vitest';
import { NO_CALLING_NUMBER, countsLabel, buildTodayView, noticeSentence } from '../src/renderer/todayView.ts';
import { todayStateSchema, type TodayFirm, type TodayState } from '../src/renderer/todayContract.ts';
import { createTodayBridge, localToInstant, TODAY_IPC_CHANNELS } from '../src/main/todayBridge.ts';
import type { DialHandoff } from '../src/main/dialHandoff.ts';
import { CRM_IPC_CHANNELS, createCrmBridge, pipelineViewOf } from '../src/main/crmBridge.ts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import type { ApiOutcome, HttpAnswer } from '../src/main/apiClient.ts';
import { heldAnswer, snoozedAnswer } from './support/todayAnswers.ts';

/**
 * The Today window and the two bridges behind it (specification 8.2, 9.2, 14.2).
 *
 * Three layers, three kinds of test, none of them needing Electron.
 *
 * The **view model** is pure, so the rules of 4.2 — "shows its unexpired cached Today
 * view marked stale" and "mutations fail closed" — are assertions rather than
 * screenshots.
 *
 * The **bridges** are given a scripted API and a scripted session, so what is proved
 * is the wiring: that the window is never handed a token, that a local wall-clock
 * instant is resolved against the workspace zone before it leaves the Mac, and that
 * the outcome of a snooze is the server's word and not the client's guess.
 *
 * No real business name or number appears; `example.test` is reserved by RFC 6761 and
 * the numbers are in the NANP 555-01XX fictional block.
 */

const FIRM_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_FIRM_ID = '22222222-2222-4222-8222-222222222222';
const ITEM_ID = '33333333-3333-4333-8333-333333333333';
const ROUTE_ID = '44444444-4444-4444-8444-444444444444';
const IDENTITY_ID = '55555555-5555-4555-8555-555555555555';

function firmPage(overrides: Partial<TodayFirm> = {}): TodayFirm {
  return {
    firmId: FIRM_ID,
    firmName: 'Northwind Test Holdings',
    snapshotDate: '2026-09-21',
    lane: 'callback',
    counts: { replies: 0, emailsDue: 2, callsDue: 1 },
    tasks: [
      {
        itemId: ITEM_ID,
        contactId: null,
        contactName: 'Dana Example',
        kind: 'call_due',
        lane: 'due_work',
        dueAt: '2026-09-21T13:00:00.000Z',
        status: 'open',
        automated: false,
        snoozeUntil: null,
      },
      {
        itemId: '66666666-6666-4666-8666-666666666666',
        contactId: null,
        contactName: 'Robin Placeholder',
        kind: 'email_due',
        lane: 'due_work',
        dueAt: '2026-09-21T14:00:00.000Z',
        status: 'open',
        automated: true,
        snoozeUntil: null,
      },
    ],
    routes: [
      { routeId: ROUTE_ID, contactId: null, e164: '+14015550187', version: 3, eligibility: 'usable' },
      { routeId: OTHER_FIRM_ID, contactId: null, e164: '+14015550188', version: 1, eligibility: 'candidate' },
    ],
    callingIdentityId: IDENTITY_ID,
    ...overrides,
  };
}

function state(overrides: Partial<TodayState> = {}): TodayState {
  return todayStateSchema.parse({
    snapshotDate: '2026-09-21',
    businessTimeZone: 'America/New_York',
    cards: [
      {
        firmId: FIRM_ID,
        firmName: 'Northwind Test Holdings',
        lane: 'callback',
        dueAt: '2026-09-21T18:00:00.000Z',
        counts: { replies: 0, emailsDue: 2, callsDue: 1 },
      },
      {
        firmId: OTHER_FIRM_ID,
        firmName: 'Larkspur Test Foundry',
        lane: 'new_firm',
        dueAt: '2026-09-01T12:00:00.000Z',
        counts: { replies: 0, emailsDue: 0, callsDue: 0 },
      },
    ],
    expanded: null,
    online: true,
    stale: false,
    asOf: '2026-09-21T13:00:00.000Z',
    mayMutate: true,
    role: 'salesperson',
    dialAdvice: [],
    notice: null,
    handoffNotice: 'Once a call is handed to the phone app, Callie cannot recall it.',
    ...overrides,
  });
}

describe('the Today view model', () => {
  it('labels the aggregate counts a card shows', () => {
    expect(countsLabel({ replies: 1, emailsDue: 2, callsDue: 1 })).toBe(
      '1 reply, 2 emails, 1 call',
    );
    expect(countsLabel({ replies: 0, emailsDue: 0, callsDue: 0 })).toBe('Nothing outstanding');
  });

  it('shows a stale list with a banner and disables nothing for it (wave 1)', () => {
    const view = buildTodayView(state({ stale: true, online: false, expanded: firmPage() }));
    expect(view.cards).toHaveLength(2);
    expect(view.showingCachedList).toBe(true);
    expect(view.actionsEnabled).toBe(true);
    expect(view.tasks.some(task => task.enabled)).toBe(true);
    expect(view.banners.map(banner => banner.tone)).toContain('warning');
    expect(view.banners.map(banner => banner.text).join(' ')).toContain('Changes will fail until Callie reconnects.');
  });

  it('disables actions only below the supported version or signed out', () => {
    const view = buildTodayView(state({ mayMutate: false, expanded: firmPage() }));
    expect(view.actionsEnabled).toBe(false);
    expect(view.tasks.every(task => !task.enabled)).toBe(true);
    expect(view.dialRoutes.every(entry => !entry.enabled)).toBe(true);
  });

  it('says the offline reason in one fixed sentence', () => {
    const view = buildTodayView(state({ online: false, cards: [] }));
    expect(view.banners[0]?.text).toBe(noticeSentence('offline'));
    expect(view.emptyMessage).toBe('Callie has no saved list for today.');
  });

  it('never re-sorts the server’s order', () => {
    // The new firm's instant is three weeks earlier and it stays second, because the
    // snapshot decided and this file does not.
    expect(buildTodayView(state()).cards.map(entry => entry.card.firmId)).toEqual([FIRM_ID, OTHER_FIRM_ID]);
  });

  it('offers a pause for an automated send and a snooze for a manual task', () => {
    const view = buildTodayView(state({ expanded: firmPage() }));
    // Lane g79 (C22): "Pause", because it lasts until Resume, not until a time.
    expect(view.tasks.map(task => task.delayLabel)).toEqual(['Snooze', 'Pause sending']);
    expect(view.tasks.map(task => task.paused)).toEqual([false, false]);
  });

  it('shows a paused send as paused, and a callback that needs a time as one (lane g79)', () => {
    const page = firmPage();
    const [call, email] = page.tasks;
    if (call === undefined || email === undefined) throw new Error('fixture');
    const view = buildTodayView(
      state({
        expanded: firmPage({
          tasks: [
            { ...call, kind: 'callback', lane: 'callback', callLogId: '77777777-7777-4777-8777-777777777777' },
            { ...email, pauseHoldId: '88888888-8888-4888-8888-888888888888' },
          ],
        }),
      }),
    );
    expect(view.tasks.map(task => task.label)).toEqual(['Callback — needs a time', 'Email due']);
    expect(view.tasks.map(task => task.needsTime)).toEqual([true, false]);
    expect(view.tasks.map(task => task.paused)).toEqual([false, true]);
    // The outcome form defaults to the one task a call can be recorded against.
    expect(view.outcomeItemId).toBe(ITEM_ID);
  });

  it('defaults the outcome to the task of the contact just called', () => {
    const contact = '99999999-9999-4999-8999-999999999999';
    const page = firmPage();
    const [call] = page.tasks;
    if (call === undefined) throw new Error('fixture');
    const second = { ...call, itemId: '12121212-1212-4121-8121-121212121212', contactId: contact };
    const view = buildTodayView(
      state({
        expanded: firmPage({ tasks: [call, second] }),
        lastCall: { firmId: FIRM_ID, routeId: ROUTE_ID, contactId: contact, e164: '+14015550187' },
      }),
    );
    expect(view.outcomeItemId).toBe(second.itemId);
  });

  it('shows only a usable route, and disables one the server has not advised', () => {
    // A candidate or retired number is shown on the Firm page and is not offered here.
    const card = buildTodayView(state({ expanded: firmPage() }));
    expect(card.dialRoutes.map(entry => entry.route.routeId)).toEqual([ROUTE_ID]);
    // No advice yet — the read failed, or the card came from the cache — so the button
    // is not offered and the card says why rather than pretending it is callable.
    expect(card.dialRoutes[0]?.enabled).toBe(false);
    expect(card.dialRoutes[0]?.reasons).toEqual([
      'Callie could not check whether this number may be called. Try again.',
    ]);

    const advised = buildTodayView(
      state({
        expanded: firmPage(),
        dialAdvice: [{ routeId: ROUTE_ID, callable: true, reasons: [], e164: '+14015550187', firmLocalTime: '10:05' }],
      }),
    );
    expect(advised.dialRoutes[0]?.enabled).toBe(true);
    expect(advised.dialRoutes[0]?.reasons).toEqual([]);
  });

  it('says where to add a calling number when a card has a number to dial and nothing to dial it from (lane g60)', () => {
    const missing = buildTodayView(state({ expanded: firmPage({ callingIdentityId: null }) }));
    expect(missing.banners).toContainEqual({ tone: 'info', text: NO_CALLING_NUMBER });
    expect(NO_CALLING_NUMBER).toContain('Settings (⌘,)');
    // Not when the card has a number to call from, nor when there is nothing to dial.
    expect(buildTodayView(state({ expanded: firmPage() })).banners.map(banner => banner.text)).not.toContain(
      NO_CALLING_NUMBER,
    );
    expect(
      buildTodayView(
        state({
          expanded: firmPage({
            callingIdentityId: null,
            routes: [{ routeId: ROUTE_ID, contactId: null, e164: '+14015550187', version: 1, eligibility: 'candidate' }],
          }),
        }),
      ).banners.map(banner => banner.text),
    ).not.toContain(NO_CALLING_NUMBER);
    // And said once when the bridge's own refusal already says it.
    expect(noticeSentence('identity_not_verified')).toBe(NO_CALLING_NUMBER);
    const refused = buildTodayView(
      state({ expanded: firmPage({ callingIdentityId: null }), notice: 'identity_not_verified' }),
    );
    expect(refused.banners.filter(banner => banner.text === NO_CALLING_NUMBER)).toHaveLength(1);
  });
});

describe('a local wall-clock instant becomes UTC in the main process', () => {
  it('resolves against the zone, on both sides of a DST boundary', () => {
    // 2026-01-15 is EST (-05:00); 2026-07-15 is EDT (-04:00). A fixed offset would
    // get one of them wrong.
    expect(localToInstant('2026-01-15T09:00', 'America/New_York')).toBe('2026-01-15T14:00:00.000Z');
    expect(localToInstant('2026-07-15T09:00', 'America/New_York')).toBe('2026-07-15T13:00:00.000Z');
  });

  it('refuses anything that is not a wall clock', () => {
    expect(localToInstant('tomorrow', 'America/New_York')).toBeNull();
    expect(localToInstant('2026-09-21T09:00', 'Mars/Olympus')).toBeNull();
  });

  it('resolves a DST gap forward, as the domain does, never to the hour before (lane g79, C18)', () => {
    // The old two-step correction put 02:30 on 8 March 2026 at 01:30 EST.
    expect(localToInstant('2026-03-08T02:30', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z');
    // And a fold is its first reading, still on daylight time.
    expect(localToInstant('2026-11-01T01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
  });
});

/** A scripted API. Every call is recorded; every answer is chosen by the test. */
function scriptedApi(answers: Readonly<Record<string, HttpAnswer>>): {
  readonly api: ReturnType<typeof createAuthedClient>;
  readonly calls: { path: string; body: unknown }[];
} {
  const calls: { path: string; body: unknown }[] = [];
  const api = createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: '1.4.0',
    accessToken: async () => await Promise.resolve('token-value'),
    send: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: init.body === undefined ? null : JSON.parse(init.body) });
      return await Promise.resolve(answers[path] ?? { status: 404, body: { error: 'not_found' } });
    },
  });
  return { api, calls };
}

const sessionState = (overrides: Record<string, unknown> = {}) => ({
  online: true,
  stale: false,
  asOf: '2026-09-21T13:00:00.000Z',
  mayMutate: true,
  device: { role: 'salesperson' as const },
  today: {
    snapshotDate: '2026-09-21',
    businessTimeZone: 'America/New_York',
    cards: state().cards,
  },
  ...overrides,
});

describe('the Today bridge', () => {
  const accepted = (result: unknown): HttpAnswer => ({
    status: 200,
    body: { status: 'accepted', replayed: false, result },
  });

  /** `POST /dial/check` saying yes for this fixture's usable number. */
  const advice = (overrides: Record<string, unknown> = {}): HttpAnswer => ({
    status: 200,
    body: {
      advice: {
        firmId: FIRM_ID,
        callable: true,
        reasons: [],
        routeId: ROUTE_ID,
        e164: '+14015550187',
        telUri: 'tel:+14015550187',
        firmTimeZone: 'America/New_York',
        firmLocalTime: '10:05',
        at: '2026-09-21T14:05:00.000Z',
        ...overrides,
      },
    },
  });

  /** A handoff that opens whatever it is handed, for the tests that are not about it. */
  const opening = (opened: string[] = []): DialHandoff => ({
    checkSetup: async () => await Promise.resolve({ ready: true }),
    open: async input => {
      opened.push(input.telUri);
      return await Promise.resolve({ status: 'opened', e164: input.e164 });
    },
  });

  const unavailable = (): DialHandoff => ({
    checkSetup: async () => await Promise.resolve({ ready: false, reason: 'no_tel_handler' }),
    open: async () => await Promise.resolve({ status: 'refused', reason: 'no_tel_handler' }),
  });

  describe('an expansion while the server is away (wave 1)', () => {
    const handoff = opening();
    /** `/today/firm` answering, down, or refusing, as the test says. */
    function switchable(): { readonly api: ReturnType<typeof createAuthedClient>; mode: 'up' | 'down' | 'not_found' | 'failing' } {
      const world = {
        mode: 'up' as 'up' | 'down' | 'not_found' | 'failing',
        api: createAuthedClient({
          baseUrl: 'https://api.example.test/',
          clientVersion: '1.4.0',
          accessToken: async () => await Promise.resolve('token-value'),
          send: async () => {
            if (world.mode === 'down') throw new Error('the server did not answer');
            if (world.mode === 'not_found') return await Promise.resolve({ status: 404, body: { error: 'not_found' } });
            if (world.mode === 'failing') return await Promise.resolve({ status: 503, body: {} });
            return await Promise.resolve({ status: 200, body: firmPage() });
          },
        }),
      };
      return world;
    }

    it('opens the card this Mac last read, and keeps it when the read fails', async () => {
      const world = switchable();
      const bridge = createTodayBridge({
        api: world.api,
        handoff,
        session: { state: async () => await Promise.resolve(sessionState()), refreshToday: async () => await Promise.resolve(null) },
      });
      expect((await bridge.expand({ firmId: FIRM_ID })).expanded?.tasks).toHaveLength(2);
      await bridge.collapse();

      world.mode = 'down';
      const offline = await bridge.expand({ firmId: FIRM_ID });
      expect(offline.expanded?.firmId).toBe(FIRM_ID);
      expect(offline.expanded?.tasks).toHaveLength(2);
      expect(offline.notice).toBe('offline');
      // A refresh that fails again keeps it open, rather than closing the card.
      expect((await bridge.refresh()).expanded?.tasks).toHaveLength(2);

      world.mode = 'failing';
      expect((await bridge.expand({ firmId: FIRM_ID })).expanded?.tasks).toHaveLength(2);
    });

    it('opens the list’s own card when this Mac never read the firm, with nothing to dial', async () => {
      const world = switchable();
      world.mode = 'down';
      const bridge = createTodayBridge({
        api: world.api,
        handoff,
        session: { state: async () => await Promise.resolve(sessionState()), refreshToday: async () => await Promise.resolve(null) },
      });
      const answer = await bridge.expand({ firmId: OTHER_FIRM_ID });
      expect(answer.expanded).toMatchObject({ firmId: OTHER_FIRM_ID, firmName: 'Larkspur Test Foundry', tasks: [], routes: [], callingIdentityId: null });
      expect(buildTodayView(answer).dialRoutes).toEqual([]);
    });

    it('closes the card and forgets it when the server says the firm is not found', async () => {
      const world = switchable();
      const bridge = createTodayBridge({
        api: world.api,
        handoff,
        session: { state: async () => await Promise.resolve(sessionState()), refreshToday: async () => await Promise.resolve(null) },
      });
      await bridge.expand({ firmId: FIRM_ID });
      world.mode = 'not_found';
      const gone = await bridge.expand({ firmId: FIRM_ID });
      expect(gone.expanded).toBeNull();
      expect(gone.notice).toBe('not_found');
      world.mode = 'down';
      // Forgotten: offline now, it is the list's card, not the page read before.
      expect((await bridge.expand({ firmId: FIRM_ID })).expanded?.tasks).toEqual([]);
    });

    it('starts empty for another sign-in on the same Mac', async () => {
      const world = switchable();
      let deviceId = '33333333-3333-4333-8333-333333333333';
      const bridge = createTodayBridge({
        api: world.api,
        handoff,
        session: {
          state: async () => await Promise.resolve(sessionState({ device: { role: 'salesperson' as const, deviceId } })),
          refreshToday: async () => await Promise.resolve(null),
        },
      });
      await bridge.expand({ firmId: FIRM_ID });
      deviceId = '44444444-4444-4444-8444-444444444444';
      world.mode = 'down';
      expect((await bridge.expand({ firmId: FIRM_ID })).expanded?.tasks).toEqual([]);
    });
  });

  it('never puts a token, a URI or a command id in the state it returns', async () => {
    const { api } = scriptedApi({ '/today/firm': { status: 200, body: firmPage() }, '/dial/check': advice() });
    const bridge = createTodayBridge({
      api,
      handoff: opening(),
      session: { state: async () => await Promise.resolve(sessionState()), refreshToday: async () => await Promise.resolve(null) },
    });
    const answer = await bridge.expand({ firmId: FIRM_ID });
    // `todayStateSchema` is strict; a field that could hold one does not exist, and
    // the parse in the bridge is what makes that a runtime guarantee too.
    expect(JSON.stringify(answer)).not.toContain('token-value');
    expect(answer.expanded?.tasks).toHaveLength(2);
  });

  it('resolves a datetime-local snooze against the workspace zone before it leaves', async () => {
    const { api, calls } = scriptedApi({
      '/today/firm': { status: 200, body: firmPage() },
      '/today/snooze': accepted(snoozedAnswer()),
    });
    const bridge = createTodayBridge({
      api,
      handoff: unavailable(),
      session: { state: async () => await Promise.resolve(sessionState()), refreshToday: async () => await Promise.resolve(null) },
    });
    const answer = await bridge.snooze({ itemId: ITEM_ID, reason: 'Waiting on their board', returnAt: '2026-09-24T09:00' });
    expect(answer.notice).toBe('snoozed');
    const sent = calls.find(call => call.path === '/today/snooze')?.body as Record<string, unknown>;
    expect(sent['returnAt']).toBe('2026-09-24T13:00:00.000Z');
    expect(sent['commandId']).toEqual(expect.any(String));
  });

  it('reports the outcome the server chose, not the one the window asked for', async () => {
    const { api } = scriptedApi({
      '/today/firm': { status: 200, body: firmPage() },
      '/today/snooze': accepted(heldAnswer()),
    });
    const bridge = createTodayBridge({
      api,
      handoff: opening(),
      session: { state: async () => await Promise.resolve(sessionState()), refreshToday: async () => await Promise.resolve(null) },
    });
    // The window sent a snooze. The item was automated, so the server held it (8.2).
    expect((await bridge.snooze({ itemId: ITEM_ID, reason: 'Closed this week', returnAt: '2026-09-24T09:00' })).notice).toBe('held');
  });

  it('keeps the notice through a read Home makes by itself, and clears it on Refresh (lane g84)', async () => {
    const { api, calls } = scriptedApi({
      '/today/firm': { status: 200, body: firmPage() },
      '/today/snooze': accepted(snoozedAnswer()),
    });
    let reads = 0;
    const bridge = createTodayBridge({
      api,
      handoff: opening(),
      session: {
        state: async () => await Promise.resolve(sessionState()),
        refreshToday: async () => {
          reads += 1;
          return await Promise.resolve(null);
        },
      },
    });
    await bridge.expand({ firmId: FIRM_ID });
    expect((await bridge.snooze({ itemId: ITEM_ID, reason: 'Waiting on their board', returnAt: '2026-09-24T09:00' })).notice).toBe('snoozed');

    const quiet = await bridge.refresh({ quiet: true });
    expect(reads).toBe(1);
    expect(quiet.notice).toBe('snoozed');
    // The expansion is read again with the list, so its route versions stay current.
    expect(quiet.expanded?.firmId).toBe(FIRM_ID);
    expect(calls.filter(call => call.path === '/today/firm')).toHaveLength(3);

    const pressed = await bridge.refresh();
    expect(reads).toBe(2);
    expect(pressed.notice).toBeNull();
  });

  it('refuses to dial when this Mac has no phone app, and opens nothing', async () => {
    const { api, calls } = scriptedApi({ '/today/firm': { status: 200, body: firmPage() }, '/dial/check': advice() });
    const bridge = createTodayBridge({
      api,
      handoff: unavailable(),
      session: { state: async () => await Promise.resolve(sessionState()), refreshToday: async () => await Promise.resolve(null) },
    });
    await bridge.expand({ firmId: FIRM_ID });
    const answer = await bridge.dial({ firmId: FIRM_ID, contactId: null, routeId: ROUTE_ID });
    expect(answer.notice).toBe('no_tel_handler');
    // The setup proof comes first, so a Mac with no phone app never asks the server.
    expect(calls.filter(call => call.path === '/dial/check')).toHaveLength(1);
  });

  it('reads the advice again at the press, and refuses with the server’s own reasons', async () => {
    const opened: string[] = [];
    const { api, calls } = scriptedApi({ '/today/firm': { status: 200, body: firmPage() }, '/dial/check': advice() });
    const bridge = createTodayBridge({
      api,
      handoff: opening(opened),
      session: { state: async () => await Promise.resolve(sessionState()), refreshToday: async () => await Promise.resolve(null) },
    });
    const card = await bridge.expand({ firmId: FIRM_ID });
    // The card says callable, with the firm's own clock beside the number.
    expect(card.dialAdvice).toEqual([
      { routeId: ROUTE_ID, callable: true, reasons: [], e164: '+14015550187', firmLocalTime: '10:05' },
    ]);
    expect(buildTodayView(card).dialRoutes.map(entry => entry.enabled)).toEqual([true]);

    // The calling window closed while the card was open.
    calls.length = 0;
    const refusing = scriptedApi({
      '/today/firm': { status: 200, body: firmPage() },
      '/dial/check': advice({ callable: false, reasons: ['outside_calling_window', 'posture_missing'], telUri: null }),
    });
    const second = createTodayBridge({
      api: refusing.api,
      handoff: opening(opened),
      session: { state: async () => await Promise.resolve(sessionState()), refreshToday: async () => await Promise.resolve(null) },
    });
    await second.expand({ firmId: FIRM_ID });
    const answer = await second.dial({ firmId: FIRM_ID, contactId: null, routeId: ROUTE_ID });
    expect(answer.notice).toBe('outside_calling_window');
    expect(answer.dialAdvice[0]?.reasons).toEqual(['outside_calling_window', 'posture_missing']);
    // Every reason is on the card, not only the first.
    expect(buildTodayView(answer).dialRoutes[0]?.reasons).toEqual([
      'It is outside this firm’s calling hours.',
      'This firm’s state is not on your “OK to call” list.',
    ]);
    expect(opened).toEqual([]);
    expect(answer.lastCall ?? null).toBeNull();
  });

  it('opens the URI the advice carried, and never lets the window see it', async () => {
    const opened: string[] = [];
    const { api, calls } = scriptedApi({ '/today/firm': { status: 200, body: firmPage() }, '/dial/check': advice() });
    const bridge = createTodayBridge({
      api,
      handoff: opening(opened),
      session: { state: async () => await Promise.resolve(sessionState()), refreshToday: async () => await Promise.resolve(null) },
    });
    await bridge.expand({ firmId: FIRM_ID });
    const answer = await bridge.dial({ firmId: FIRM_ID, contactId: null, routeId: ROUTE_ID });

    expect(answer.notice).toBe('dial_opened');
    expect(opened).toEqual(['tel:+14015550187']);
    // The advice is read once for the card and again at the press: the window closes at
    // a wall-clock time and a suppression can be recorded while a card is open.
    expect(calls.filter(call => call.path === '/dial/check')).toHaveLength(2);
    expect(calls.filter(call => call.path === '/dial/authorize')).toHaveLength(0);
    expect(calls.filter(call => call.path === '/dial/consume')).toHaveLength(0);
    // The window is told which number, never the URI.
    expect(answer.lastCall).toEqual({ firmId: FIRM_ID, routeId: ROUTE_ID, contactId: null, e164: '+14015550187' });
    expect(JSON.stringify(answer)).not.toContain('tel:');
  });

  it('asks for the second card version, which carries each task’s step, callback and pause (lane g79)', async () => {
    const { api, calls } = scriptedApi({ '/today/firm': { status: 200, body: firmPage() } });
    const bridge = createTodayBridge({
      api,
      handoff: opening(),
      session: { state: async () => await Promise.resolve(sessionState()), refreshToday: async () => await Promise.resolve(null) },
    });
    await bridge.expand({ firmId: FIRM_ID });
    expect(calls.find(call => call.path === '/today/firm')?.body).toEqual({ firmId: FIRM_ID, cardVersion: 2 });
  });

  it('records the outcome against its task and the number the call used, on the server’s clock (C04, C15)', async () => {
    const { api, calls } = scriptedApi({
      '/today/firm': { status: 200, body: firmPage() },
      '/dial/check': advice(),
      '/calls/log': accepted({
        callLogId: 'abababab-abab-4bab-8bab-abababababab',
        outcome: 'voicemail_left',
        stepEffect: 'complete_and_advance',
        occurredAt: '2026-09-21T13:05:00.000Z',
        setManual: false,
        suggestedStageKey: null,
        suppressionEventIds: [],
        retiredRouteId: null,
        successorExecutionId: null,
        stepExecutionId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
        stepApplication: 'completed',
        callbackId: null,
        completedCallbackId: null,
        followUps: [],
      }),
    });
    const bridge = createTodayBridge({
      api,
      handoff: opening(),
      session: { state: async () => await Promise.resolve(sessionState()), refreshToday: async () => await Promise.resolve(null) },
    });
    await bridge.expand({ firmId: FIRM_ID });
    const dialled = await bridge.dial({ firmId: FIRM_ID, contactId: null, routeId: ROUTE_ID });
    expect(dialled.lastCall).toEqual({ firmId: FIRM_ID, routeId: ROUTE_ID, contactId: null, e164: '+14015550187' });

    const answer = await bridge.recordOutcome({
      firmId: FIRM_ID,
      contactId: null,
      routeId: null,
      itemId: ITEM_ID,
      outcome: 'voicemail_left',
      note: '',
      callback: null,
      doNotCallCoversAllContact: false,
    });
    expect(answer.notice).toBe('outcome_recorded');
    const sent = calls.find(call => call.path === '/calls/log')?.body as Record<string, unknown>;
    expect(sent).toMatchObject({ firmId: FIRM_ID, itemId: ITEM_ID, routeId: ROUTE_ID, outcome: 'voicemail_left' });
    // No ticket and no calling identity: `POST /dial/authorize` and `POST /dial/consume`
    // are not called any more, and logging a call never needed either of them.
    expect(sent).not.toHaveProperty('ticketId');
    expect(sent).not.toHaveProperty('callingIdentityId');
    // "Just now" is the server's clock: the Mac sends none of its own.
    expect(sent).not.toHaveProperty('occurredAt');
    expect(sent).not.toHaveProperty('retryBehaviour');
    // The call is recorded once; the next outcome is history unless another is made.
    expect(answer.lastCall).toBeNull();
  });

  it('says what a recorded call still needs, from the server’s follow-ups (C13)', async () => {
    const { api, calls } = scriptedApi({
      '/calls/log': accepted({
        callLogId: 'abababab-abab-4bab-8bab-abababababab',
        outcome: 'callback_requested',
        stepEffect: 'complete_and_advance',
        occurredAt: '2026-09-21T13:05:00.000Z',
        setManual: false,
        suggestedStageKey: null,
        suppressionEventIds: [],
        retiredRouteId: null,
        successorExecutionId: null,
        stepExecutionId: null,
        stepApplication: null,
        callbackId: null,
        completedCallbackId: null,
        followUps: [{ kind: 'callback_time_needed', reason: 'no_instant' }],
      }),
    });
    const bridge = createTodayBridge({
      api,
      handoff: opening(),
      session: { state: async () => await Promise.resolve(sessionState()), refreshToday: async () => await Promise.resolve(null) },
    });
    const answer = await bridge.recordOutcome({
      firmId: FIRM_ID,
      contactId: null,
      routeId: null,
      itemId: null,
      outcome: 'callback_requested',
      note: '',
      callback: null,
      doNotCallCoversAllContact: false,
    });
    expect(answer.notice).toBe('outcome_recorded_callback_time_needed');
    expect(noticeSentence('outcome_recorded_callback_time_needed')).toContain('needs a time');
    expect(calls.find(call => call.path === '/calls/log')?.body).not.toHaveProperty('callback');
  });

  it('sends a callback’s local fields with the instant the domain clock gives them (C18)', async () => {
    const { api, calls } = scriptedApi({ '/calls/log': accepted(null) });
    const bridge = createTodayBridge({
      api,
      handoff: opening(),
      session: { state: async () => await Promise.resolve(sessionState()), refreshToday: async () => await Promise.resolve(null) },
    });
    await bridge.recordOutcome({
      firmId: FIRM_ID,
      contactId: null,
      routeId: null,
      itemId: null,
      outcome: 'callback_requested',
      note: '',
      callback: { localDate: '2026-03-08', localTime: '02:30', dueAt: '', sourceTimeZone: '' },
      doNotCallCoversAllContact: false,
    });
    const sent = calls.find(call => call.path === '/calls/log')?.body as Record<string, unknown>;
    expect(sent['callback']).toEqual({
      localDate: '2026-03-08',
      localTime: '02:30',
      sourceTimeZone: 'America/New_York',
      dueAt: '2026-03-08T07:30:00.000Z',
    });
  });

  it('sets a needs-a-time callback’s time, and releases a pause (C13, C22)', async () => {
    const { api, calls } = scriptedApi({
      '/callbacks/schedule': accepted({ id: 'efefefef-efef-4fef-8fef-efefefefefef' }),
      '/today/pause/release': accepted({
        holdId: '88888888-8888-4888-8888-888888888888',
        releasedAt: '2026-09-21T13:10:00.000Z',
        resume: 'resume',
      }),
    });
    const bridge = createTodayBridge({
      api,
      handoff: opening(),
      session: { state: async () => await Promise.resolve(sessionState()), refreshToday: async () => await Promise.resolve(null) },
    });
    const scheduled = await bridge.scheduleCallback({
      callLogId: 'abababab-abab-4bab-8bab-abababababab',
      localDate: '2026-09-22',
      localTime: '14:00',
    });
    expect(scheduled.notice).toBe('callback_scheduled');
    expect(calls.find(call => call.path === '/callbacks/schedule')?.body).toMatchObject({
      callLogId: 'abababab-abab-4bab-8bab-abababababab',
      localDate: '2026-09-22',
      localTime: '14:00',
      sourceTimeZone: 'America/New_York',
      dueAt: '2026-09-22T18:00:00.000Z',
    });

    const released = await bridge.releasePause({ holdId: '88888888-8888-4888-8888-888888888888' });
    expect(released.notice).toBe('pause_released');
    expect(calls.find(call => call.path === '/today/pause/release')?.body).toMatchObject({
      holdId: '88888888-8888-4888-8888-888888888888',
    });
  });

  it('pauses an automated send with no return time at all (C22)', async () => {
    const { api, calls } = scriptedApi({
      '/today/snooze': accepted({
        outcome: 'held',
        holdId: '88888888-8888-4888-8888-888888888888',
        blockedActionKind: 'email_send',
        scope: 'enrollment',
      }),
    });
    const bridge = createTodayBridge({
      api,
      handoff: opening(),
      session: { state: async () => await Promise.resolve(sessionState()), refreshToday: async () => await Promise.resolve(null) },
    });
    const answer = await bridge.snooze({ itemId: ITEM_ID, reason: 'Their office is closed', returnAt: '' });
    expect(answer.notice).toBe('held');
    expect(noticeSentence('held')).toContain('Resume');
    expect(calls.find(call => call.path === '/today/snooze')?.body).not.toHaveProperty('returnAt');
  });

  it('turns an offline read into a state a person can still look at', async () => {
    const api = createAuthedClient({
      baseUrl: 'https://api.example.test/',
      clientVersion: '1.4.0',
      accessToken: async () => await Promise.resolve('token-value'),
      send: async () => {
        await Promise.resolve();
        throw new Error('no network');
      },
    });
    const bridge = createTodayBridge({
      api,
      handoff: unavailable(),
      session: { state: async () => await Promise.resolve(sessionState({ online: false, stale: true })), refreshToday: async () => await Promise.resolve(null) },
    });
    const answer = await bridge.expand({ firmId: FIRM_ID });
    // The card opens from the cached list (wave 1), with nothing on it to dial.
    expect(answer.expanded).toMatchObject({ firmId: FIRM_ID, tasks: [], routes: [] });
    expect(answer.notice).toBe('offline');
    expect(answer.cards).toHaveLength(2);
  });

  it('names one channel per method, and nothing else', () => {
    expect(Object.values(TODAY_IPC_CHANNELS)).toEqual([
      'callie:today:state',
      'callie:today:refresh',
      'callie:today:expand',
      'callie:today:collapse',
      'callie:today:snooze',
      'callie:today:dial',
      'callie:today:outcome',
      'callie:today:schedule-callback',
      'callie:today:release-pause',
    ]);
  });
});

describe('the CRM bridge G3b was waiting for', () => {
  const stage = (key: string, displayName: string, position: number) => ({
    id: `eeeeeeee-eeee-4eee-8eee-${String(position).padStart(12, '0')}`,
    key,
    displayName,
    position,
    terminalKind: null,
    retired: false,
  });

  it('puts each firm in its own stage’s column', () => {
    const view = pipelineViewOf(
      [stage('new', 'New', 1), stage('contacting', 'Contacting', 2)],
      [
        { ...state().cards[0], id: FIRM_ID, stageKey: 'contacting' } as never,
        { ...state().cards[1], id: OTHER_FIRM_ID, stageKey: 'new' } as never,
      ],
      { [FIRM_ID]: '77777777-7777-4777-8777-777777777777' },
    );
    expect(view.columns.map(column => column.firms.length)).toEqual([1, 1]);
    expect(view.opportunityIdByFirmId[FIRM_ID]).toBe('77777777-7777-4777-8777-777777777777');
    // A firm whose opportunity id nobody has told us renders G3b's
    // `stage-change-unavailable`, rather than a control that cannot name its target.
    expect(view.opportunityIdByFirmId[OTHER_FIRM_ID]).toBeUndefined();
  });

  it('answers the methods G3b’s contract declares, and names fifteen channels (six, lane g84’s five, lane g88’s three, lane g90’s one)', async () => {
    // Lane G9 replaced the two reads this used to make with one board read that
    // carries the open opportunity id per firm the caller may change
    // (docs/decisions/g9-pipeline-board-read.md).
    const { api, calls } = scriptedApi({
      '/pipeline/board': {
        status: 200,
        body: {
          columns: [{ stage: stage('new', 'New', 1), firms: [] }],
          opportunityIdByFirmId: {},
          unplacedFirms: [],
        },
      },
    });
    const bridge = createCrmBridge({
      api,
      clientVersion: '1.0.5',
      session: { state: async () => await Promise.resolve(sessionState()) },
    });
    const answer = await bridge.state();
    expect(answer.screen).toBe('pipeline');
    expect(answer.role).toBe('salesperson');
    expect(calls.map(call => call.path)).toEqual(['/pipeline/board']);
    expect(Object.values(CRM_IPC_CHANNELS)).toHaveLength(15);
    expect(new Set(Object.values(CRM_IPC_CHANNELS)).size).toBe(15);
  });

  it('offers a stage change only for the firms the board read named', async () => {
    const opportunityId = '77777777-7777-4777-8777-777777777777';
    const identity = (id: string, name: string) => ({
      id,
      name,
      website: null,
      locality: null,
      regionCode: null,
      status: 'active' as const,
      assignedUserId: null,
      stageKey: 'new',
      opportunityStatus: 'open' as const,
      controlMode: 'automated' as const,
      openedAt: '2026-09-01T12:00:00.000Z',
      timeZone: 'America/New_York',
      timeZoneUnresolvedReason: null,
    });
    const { api } = scriptedApi({
      '/pipeline/board': {
        status: 200,
        body: {
          columns: [
            {
              stage: stage('new', 'New', 1),
              firms: [identity(FIRM_ID, 'Northwind Test Holdings'), identity(OTHER_FIRM_ID, 'Southwind Test Partners')],
            },
          ],
          // Only the caller's own firm. The colleague's column renders G3b's
          // `stage-change-unavailable`, which is honest: the mutation would be
          // refused under the firm's row lock anyway.
          opportunityIdByFirmId: { [FIRM_ID]: opportunityId },
          unplacedFirms: [],
        },
      },
    });
    const bridge = createCrmBridge({
      api,
      clientVersion: '1.0.5',
      session: { state: async () => await Promise.resolve(sessionState()) },
    });
    const answer = await bridge.state();
    expect(answer.pipeline?.opportunityIdByFirmId[FIRM_ID]).toBe(opportunityId);
    expect(answer.pipeline?.opportunityIdByFirmId[OTHER_FIRM_ID]).toBeUndefined();
  });

  it('falls back to the two older reads when the board endpoint does not answer', async () => {
    const { api, calls } = scriptedApi({
      '/pipeline/stages': { status: 200, body: { stages: [stage('new', 'New', 1)] } },
      '/firms': { status: 200, body: { firms: [] } },
    });
    const bridge = createCrmBridge({
      api,
      clientVersion: '1.0.5',
      session: { state: async () => await Promise.resolve(sessionState()) },
    });
    const answer = await bridge.state();
    expect(answer.screen).toBe('pipeline');
    // Showing the columns with no stage controls beats showing nothing; an older
    // API that has not been deployed yet is a deployment order, not an outage.
    expect(calls.map(call => call.path)).toEqual(['/pipeline/board', '/pipeline/stages', '/firms']);
    expect(answer.pipeline?.opportunityIdByFirmId).toEqual({});
  });

  it('records a refusal as its code, so G3b’s view maps it to one sentence', async () => {
    const { api } = scriptedApi({
      '/pipeline/stages': { status: 200, body: { stages: [] } },
      '/firms': { status: 200, body: { firms: [] } },
      '/contacts/update': { status: 409, body: { status: 'refused', reason: 'not_assigned' } },
    });
    const bridge = createCrmBridge({
      api,
      clientVersion: '1.0.5',
      session: { state: async () => await Promise.resolve(sessionState()) },
    });
    const answer = await bridge.saveContact({
      contactId: ITEM_ID,
      fullName: 'Robin Placeholder-Jones',
      title: null,
      makePrimary: false,
    });
    expect(answer.notice).toBe('not_assigned');
  });
});

describe('a refused merge reaches the conflict screen (lane g78, D05)', () => {
  const SOURCE_ID = '88888888-8888-4888-8888-888888888888';
  const conflicts = [
    { field: 'website', source: 'https://dup.example.test', target: 'https://northwind.example.test' },
    { field: 'locality', source: null, target: 'Providence' },
  ];
  const identity = (id: string, name: string) => ({
    id,
    name,
    website: null,
    locality: null,
    regionCode: null,
    status: 'active' as const,
    assignedUserId: null,
    stageKey: null,
    opportunityStatus: null,
    controlMode: null,
    openedAt: null,
    timeZone: null,
    timeZoneUnresolvedReason: null,
  });

  for (const replayed of [false, true]) {
    it(`opens the screen from a ${replayed ? 'replayed' : 'fresh'} refusal, with both firms named`, async () => {
      const { api } = scriptedApi({
        '/merges/firms': { status: 409, body: { status: 'refused', replayed, reason: 'merge_conflicts', conflicts } },
        '/firms': { status: 200, body: { firms: [identity(FIRM_ID, 'Northwind Test Holdings'), identity(SOURCE_ID, 'Northwind (dup)')] } },
      });
      const bridge = createCrmBridge({ api, clientVersion: '1.0.5', session: { state: async () => await Promise.resolve(sessionState()) } });
      const answer = await bridge.resolveMerge({ sourceFirmId: SOURCE_ID, targetFirmId: FIRM_ID, resolutions: {} });
      expect(answer.notice).toBe('merge_conflicts');
      expect(answer.screen).toBe('merge');
      expect(answer.merge).toEqual({
        sourceFirmId: SOURCE_ID,
        sourceName: 'Northwind (dup)',
        targetFirmId: FIRM_ID,
        targetName: 'Northwind Test Holdings',
        conflicts,
      });
    });
  }

  it('stays where it was for a refusal that carries no conflicts', async () => {
    const { api } = scriptedApi({
      '/merges/firms': { status: 409, body: { status: 'refused', replayed: false, reason: 'merge_same_record' } },
    });
    const bridge = createCrmBridge({ api, clientVersion: '1.0.5', session: { state: async () => await Promise.resolve(sessionState()) } });
    const answer = await bridge.resolveMerge({ sourceFirmId: FIRM_ID, targetFirmId: FIRM_ID, resolutions: {} });
    expect(answer.notice).toBe('merge_same_record');
    expect(answer.merge).toBeNull();
    expect(answer.screen).not.toBe('merge');
  });

  it('keeps the refusal’s body on the transport’s answer, and only there', async () => {
    const body = { status: 'refused', replayed: true, reason: 'merge_conflicts', conflicts };
    const api = createAuthedClient({
      baseUrl: 'https://api.example.test/',
      clientVersion: '1.4.0',
      accessToken: async () => await Promise.resolve('token'),
      send: async () => await Promise.resolve({ status: 409, body }),
    });
    const outcome = await api.command('/merges/firms', {}, value => value);
    expect(outcome).toEqual({ ok: false, reason: 'merge_conflicts', offline: false, refusal: body });
  });
});

describe('the authenticated client', () => {
  it('refuses to call anything at all without a session', async () => {
    const api = createAuthedClient({
      baseUrl: 'https://api.example.test/',
      clientVersion: '1.4.0',
      accessToken: async () => await Promise.resolve(null),
      send: async () => {
        await Promise.resolve();
        throw new Error('the client must not reach the network without a token');
      },
    });
    const outcome: ApiOutcome<unknown> = await api.read('/today', value => value);
    expect(outcome).toEqual({ ok: false, reason: 'not_signed_in', offline: false });
  });
});
