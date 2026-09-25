import { describe, expect, it } from 'vitest';
import { NO_CALLING_NUMBER, countsLabel, buildTodayView, noticeSentence } from '../src/renderer/todayView.ts';
import { todayStateSchema, type TodayFirm, type TodayState } from '../src/renderer/todayContract.ts';
import { createTodayBridge, localToInstant, TODAY_IPC_CHANNELS } from '../src/main/todayBridge.ts';
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
    counts: { replies: 0, emailsDue: 2, callsDue: 1, linkedInDue: 0 },
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
        counts: { replies: 0, emailsDue: 2, callsDue: 1, linkedInDue: 0 },
      },
      {
        firmId: OTHER_FIRM_ID,
        firmName: 'Larkspur Test Foundry',
        lane: 'new_firm',
        dueAt: '2026-09-01T12:00:00.000Z',
        counts: { replies: 0, emailsDue: 0, callsDue: 0, linkedInDue: 0 },
      },
    ],
    expanded: null,
    online: true,
    stale: false,
    asOf: '2026-09-21T13:00:00.000Z',
    mayMutate: true,
    role: 'salesperson',
    notice: null,
    handoffNotice: 'Once a call is handed to the phone app, Callie cannot recall it.',
    ...overrides,
  });
}

describe('the Today view model', () => {
  it('labels the aggregate counts a card shows', () => {
    expect(countsLabel({ replies: 1, emailsDue: 2, callsDue: 1, linkedInDue: 0 })).toBe(
      '1 reply, 2 emails, 1 call',
    );
    expect(countsLabel({ replies: 0, emailsDue: 0, callsDue: 0, linkedInDue: 0 })).toBe('Nothing outstanding');
  });

  it('shows a stale list and lets nothing on it be pressed', () => {
    const view = buildTodayView(state({ stale: true, expanded: firmPage() }));
    expect(view.cards).toHaveLength(2);
    expect(view.showingCachedList).toBe(true);
    expect(view.actionsEnabled).toBe(false);
    expect(view.expandEnabled).toBe(false);
    expect(view.tasks.every(task => !task.enabled)).toBe(true);
    expect(view.dialableRoutes).toEqual([]);
    expect(view.banners.map(banner => banner.tone)).toContain('warning');
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

  it('offers a hold for an automated send and a snooze for a manual task', () => {
    const view = buildTodayView(state({ expanded: firmPage() }));
    expect(view.tasks.map(task => task.delayLabel)).toEqual(['Snooze', 'Hold this send']);
  });

  it('offers only a usable route, and none at all without a verified identity', () => {
    expect(buildTodayView(state({ expanded: firmPage() })).dialableRoutes.map(route => route.routeId)).toEqual([
      ROUTE_ID,
    ]);
    expect(
      buildTodayView(state({ expanded: firmPage({ callingIdentityId: null }) })).dialableRoutes,
    ).toEqual([]);
  });

  it('says where to add a calling number when a card has a number to dial and nothing to dial it from (lane g60)', () => {
    const missing = buildTodayView(state({ expanded: firmPage({ callingIdentityId: null }) }));
    expect(missing.banners).toContainEqual({ tone: 'info', text: NO_CALLING_NUMBER });
    expect(NO_CALLING_NUMBER).toContain('Window › Administration');
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

  it('never puts a token, a ticket or a command id in the state it returns', async () => {
    const { api } = scriptedApi({ '/today/firm': { status: 200, body: firmPage() } });
    const bridge = createTodayBridge({
      api,
      handoff: { checkSetup: async () => await Promise.resolve({ ready: true }), dial: async () => await Promise.resolve({ status: 'opened', e164: '+14015550187' }) },
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
      handoff: { checkSetup: async () => await Promise.resolve({ ready: false, reason: 'no_tel_handler' }), dial: async () => await Promise.resolve({ status: 'refused', reason: 'no_tel_handler' }) },
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
      handoff: { checkSetup: async () => await Promise.resolve({ ready: true }), dial: async () => await Promise.resolve({ status: 'opened', e164: '+14015550187' }) },
      session: { state: async () => await Promise.resolve(sessionState()), refreshToday: async () => await Promise.resolve(null) },
    });
    // The window sent a snooze. The item was automated, so the server held it (8.2).
    expect((await bridge.snooze({ itemId: ITEM_ID, reason: 'Closed this week', returnAt: '2026-09-24T09:00' })).notice).toBe('held');
  });

  it('refuses to dial before the card has told it whose number to call from', async () => {
    const { api } = scriptedApi({});
    let dialled = 0;
    const bridge = createTodayBridge({
      api,
      handoff: {
        checkSetup: async () => await Promise.resolve({ ready: true }),
        dial: async () => {
          dialled += 1;
          return await Promise.resolve({ status: 'opened', e164: '+14015550187' });
        },
      },
      session: { state: async () => await Promise.resolve(sessionState()), refreshToday: async () => await Promise.resolve(null) },
    });
    const answer = await bridge.dial({ firmId: FIRM_ID, contactId: null, routeId: ROUTE_ID, routeVersion: 3 });
    expect(answer.notice).toBe('identity_not_verified');
    expect(dialled).toBe(0);
  });

  it('sends the displayed route version, and two command ids for the two commands', async () => {
    const { api } = scriptedApi({ '/today/firm': { status: 200, body: firmPage() } });
    const seen: { commandId: string; consumeCommandId: string; routeVersion: number; callingIdentityId: string }[] = [];
    const bridge = createTodayBridge({
      api,
      handoff: {
        checkSetup: async () => await Promise.resolve({ ready: true }),
        dial: async input => {
          seen.push({
            commandId: input.commandId,
            consumeCommandId: input.consumeCommandId,
            routeVersion: input.routeVersion,
            callingIdentityId: input.callingIdentityId,
          });
          return await Promise.resolve({ status: 'opened', e164: '+14015550187' });
        },
      },
      session: { state: async () => await Promise.resolve(sessionState()), refreshToday: async () => await Promise.resolve(null) },
    });
    await bridge.expand({ firmId: FIRM_ID });
    const answer = await bridge.dial({ firmId: FIRM_ID, contactId: null, routeId: ROUTE_ID, routeVersion: 3 });
    expect(answer.notice).toBe('dial_opened');
    expect(seen[0]?.routeVersion).toBe(3);
    expect(seen[0]?.callingIdentityId).toBe(IDENTITY_ID);
    // 5.3: two commands, two receipts. One id would make the second a replay.
    expect(seen[0]?.commandId).not.toBe(seen[0]?.consumeCommandId);
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
      handoff: { checkSetup: async () => await Promise.resolve({ ready: false, reason: 'no_tel_handler' }), dial: async () => await Promise.resolve({ status: 'refused', reason: 'no_tel_handler' }) },
      session: { state: async () => await Promise.resolve(sessionState({ online: false, stale: true })), refreshToday: async () => await Promise.resolve(null) },
    });
    const answer = await bridge.expand({ firmId: FIRM_ID });
    expect(answer.expanded).toBeNull();
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

  it('answers the six methods G3b’s contract declares, and names six channels', async () => {
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
      session: { state: async () => await Promise.resolve(sessionState()) },
    });
    const answer = await bridge.state();
    expect(answer.screen).toBe('pipeline');
    expect(answer.role).toBe('salesperson');
    expect(calls.map(call => call.path)).toEqual(['/pipeline/board']);
    expect(Object.values(CRM_IPC_CHANNELS)).toHaveLength(6);
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
      const bridge = createCrmBridge({ api, session: { state: async () => await Promise.resolve(sessionState()) } });
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
    const bridge = createCrmBridge({ api, session: { state: async () => await Promise.resolve(sessionState()) } });
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
