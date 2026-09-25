import { describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_THRESHOLDS } from '@fss/contracts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { ADMIN_IPC_CHANNELS, createAdminBridge } from '../src/main/settingsBridge.ts';
import { adminViewOf } from '../src/renderer/settingsView.ts';
import { windowMenuTemplate } from '../src/main/windowMenu.ts';
import { requestedScreen } from '../src/renderer/settingsPage.ts';
import type { AdminState, CallingNumberView } from '../src/renderer/settingsContract.ts';
import { outboundRampAnswer, outboundStatusAnswer } from './support/outboundStatus.ts';
import { settingHistoryAnswer } from './support/settingHistory.ts';

/**
 * The administration window: its bridge and its view model
 * (specification 10.1, 13.3, 13.4, 14.2, 16.2).
 *
 * No Electron and no DOM. The bridge is a function of an HTTP client, and the view is
 * a function of a state, which is exactly where the decisions worth asserting are:
 * which controls are offered, which figures say they are unavailable, and whether the
 * page ever computes something the server is supposed to decide.
 */

interface HttpAnswer {
  readonly status: number;
  readonly body: unknown;
}

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
      // The API's `/outbound/*` routes are POST-only, the read included; a GET is refused 405
      // (`apps/api/src/routes/outbound.ts`). The fake refuses it the same way so a read sent
      // without a body cannot pass here and fail in production.
      if (path.startsWith('/outbound/') && init.method !== 'POST') {
        return await Promise.resolve({ status: 405, body: { error: 'method_not_allowed' } });
      }
      return await Promise.resolve(answers[path] ?? { status: 404, body: { error: 'not_found' } });
    },
  });
  return { api, calls };
}

const session = (overrides: Record<string, unknown> = {}) => ({
  online: true,
  mayMutate: true,
  device: { role: 'admin' as const },
  ...overrides,
});

const settingsBody = (overrides: Record<string, unknown> = {}) => ({
  settings: [
    {
      settingKey: 'alert_thresholds',
      value: DEFAULT_ALERT_THRESHOLDS,
      version: 0,
      changedAt: null,
      changedByUserId: null,
      changeNote: null,
    },
    // `postal_footer` until migration 0015 removed that slice; a configured slice is
    // still needed here so the bridge has a version and a note to carry.
    {
      settingKey: 'business_time_zone',
      value: { timeZone: 'America/Chicago' },
      version: 2,
      changedAt: '2026-09-19T10:00:00.000Z',
      changedByUserId: '11111111-1111-4111-8111-111111111111',
      changeNote: 'the office moved',
    },
  ],
  elsewhere: [{ topic: 'Research limits', path: '/research/config', ownedBy: 'G10 research' }],
  holidayCalendar: { version: 'none.1', dates: [] },
  deploymentSendingEnabled: false,
  effectiveSendingEnabled: false,
  ...overrides,
});

const stagesBody = {
  stages: [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', key: 'new', displayName: 'New', position: 1, terminalKind: null, retired: false },
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', key: 'won', displayName: 'Won', position: 2, terminalKind: 'won', retired: false },
  ],
};

const emptyState = (overrides: Partial<AdminState> = {}): AdminState => ({
  screen: 'settings',
  role: 'admin',
  online: true,
  mayMutate: true,
  notice: null,
  settings: null,
  dashboard: null,
  diagnostics: null,
  stages: [],
  history: null,
  sendingAdmin: null,
  sendingReadError: null,
  callingNumbers: null,
  ...overrides,
});

const diagnosticsBody = (mailboxId: string) => ({
  restore: { systemGeneration: 1, expectedSystemGeneration: null, mismatch: false },
  schema: { appliedVersion: 11, declaredRange: { minimum: 11, maximum: 11 }, accepted: true },
  clientVersions: { minimum: '1.0.0', maximum: '2.0.0' },
  sending: { deploymentEnabled: false, adminEnabled: false, effective: false },
  jobs: { runnable: 0, running: 0, retryable: 0, dead: 0, oldestRunnableAgeSeconds: null, oldestDeadAgeSeconds: null },
  heartbeats: [],
  canaryCompletionAgeSeconds: null,
  alerts: [],
  mailboxes: [
    {
      mailboxId,
      ownerUserId: '11111111-1111-4111-8111-111111111111',
      status: 'connected',
      syncState: 'ready',
      coverageWatermarkAt: null,
      lastSyncedAt: null,
      lastSyncError: null,
      generation: 1,
      watchExpiresAt: null,
      hoursToWatchExpiry: null,
      automationHeld: false,
    },
  ],
  mailboxVisibility: 'all',
});

const MAILBOX_ID = '55555555-5555-4555-8555-555555555555';
const IDENTITY_ID = '66666666-6666-4666-8666-666666666666';

/** One calling number as `GET /calling-identities` answers it (lane g60). */
const callingIdentity = (overrides: Record<string, unknown> = {}) => ({
  id: IDENTITY_ID,
  ownerUserId: '11111111-1111-4111-8111-111111111111',
  e164: '+14015550150',
  label: 'Mobile',
  verificationStatus: 'unverified',
  enabled: false,
  verifiedAt: null,
  verifiedByUserId: null,
  verificationMethod: null,
  disabledAt: null,
  usedForCalls: false,
  createdAt: '2026-09-25T12:00:00.000Z',
  ...overrides,
});

/** The same number as the bridge hands the view. */
const numberView = (overrides: Partial<CallingNumberView> = {}): CallingNumberView => ({
  id: IDENTITY_ID,
  e164: '+14015550150',
  label: 'Mobile',
  verificationStatus: 'unverified',
  enabled: false,
  verifiedAt: null,
  verificationMethod: null,
  disabledAt: null,
  usedForCalls: false,
  ...overrides,
});

describe('the administration bridge', () => {
  it('reads the settings and the pipeline on first open', async () => {
    const { api, calls } = scriptedApi({
      '/settings': { status: 200, body: settingsBody() },
      '/pipeline/stages': { status: 200, body: stagesBody },
    });
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    const state = await bridge.state();
    // The calling numbers are read for every role (lane g60); here the route answers
    // 404, as an API older than it would, and the page says so rather than failing.
    expect(calls.map(call => call.path)).toEqual([
      '/settings',
      '/pipeline/stages',
      '/outbound/status',
      '/calling-identities',
    ]);
    expect(state.callingNumbers).toBeNull();
    expect(state.notice).toBeNull();
    expect(state.settings?.settings.map(entry => entry.settingKey)).toEqual([
      'alert_thresholds',
      'business_time_zone',
    ]);
    expect(state.stages.map(stage => stage.key)).toEqual(['new', 'won']);
  });

  it('sends the window the caller asked for and never invents an audience', async () => {
    const { api, calls } = scriptedApi({
      '/settings': { status: 200, body: settingsBody() },
      '/pipeline/stages': { status: 200, body: stagesBody },
      '/dashboard': {
        status: 200,
        body: {
          window: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
          audience: 'assigned',
          firmsInScope: 3,
          messages: { incomingMatched: 4, human: 2, uncertain: 1, automated: 1, bounces: 0, optOuts: 0 },
          replyHandling: { replies: 2, handled: 1, medianSecondsToHandle: 900, slowestSecondsToHandle: 1800 },
          calls: [{ key: 'voicemail_left', count: 3 }],
          stageMovement: [{ key: 'contacting', count: 1 }],
          holds: { open: 1, byReason: [{ reasonCode: 'scoped_pause', count: 1, oldestAgeSeconds: 60 }] },
          suppressions: [],
          sending: { available: false, owner: 'G7-2', reason: 'not in this build' },
          enrollments: { available: false, owner: 'G8', reason: 'not in this build' },
          classifier: { available: false, owner: 'G7b', reason: 'not in this build' },
        },
      },
    });
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    const state = await bridge.loadDashboard({
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
    });
    const request = calls.find(call => call.path === '/dashboard')?.body as { window: unknown };
    expect(request.window).toEqual({ from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' });
    // The audience came back from the server; the client asked for nothing.
    expect(JSON.stringify(request)).not.toContain('audience');
    expect(state.dashboard?.audience).toBe('assigned');
  });

  it('reads Home’s window without moving the screen or the window Administration shows (lane g65)', async () => {
    const answered = (window: { from: string; to: string }): HttpAnswer => ({
      status: 200,
      body: {
        window,
        audience: 'workspace',
        firmsInScope: 3,
        messages: { incomingMatched: 0, human: 0, uncertain: 0, automated: 0, bounces: 0, optOuts: 0 },
        replyHandling: { replies: 0, handled: 0, medianSecondsToHandle: null, slowestSecondsToHandle: null },
        calls: [],
        stageMovement: [],
        holds: { open: 0, byReason: [] },
        suppressions: [],
        sending: { available: false, owner: 'G7-2', reason: 'not in this build' },
        enrollments: { available: false, owner: 'G8', reason: 'not in this build' },
        classifier: { available: false, owner: 'G7b', reason: 'not in this build' },
      },
    });
    const week = { from: '2026-09-18T12:00:00.000Z', to: '2026-09-25T12:00:00.000Z' };
    const month = { from: '2026-08-26T12:00:00.000Z', to: '2026-09-25T12:00:00.000Z' };
    let next = answered(week);
    const { api, calls } = scriptedApi({
      '/settings': { status: 200, body: settingsBody() },
      '/pipeline/stages': { status: 200, body: stagesBody },
      get '/dashboard'() {
        return next;
      },
    });
    const bridge = createAdminBridge({
      api,
      session: { state: async () => await Promise.resolve(session()) },
      now: () => new Date('2026-09-25T12:00:00.000Z'),
    });
    await bridge.state();

    // Home asks for the last seven days while Administration shows Settings.
    const home = await bridge.loadDashboard(week);
    expect(home.dashboard?.window).toEqual(week);
    expect(home.screen).toBe('settings');

    // Administration's own Dashboard still reads its thirty days, not Home's seven.
    next = answered(month);
    const own = await bridge.show({ screen: 'dashboard' });
    const asked = calls.filter(call => call.path === '/dashboard').map(call => (call.body as { window: unknown }).window);
    expect(asked).toEqual([week, month]);
    expect(own.screen).toBe('dashboard');
  });

  it('records a refusal as its code and re-reads rather than patching local state', async () => {
    const { api, calls } = scriptedApi({
      '/settings': { status: 200, body: settingsBody() },
      '/pipeline/stages': { status: 200, body: stagesBody },
      '/settings/update': { status: 409, body: { status: 'refused', reason: 'admin_only' } },
    });
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    await bridge.state();
    const refused = await bridge.saveSetting({
      settingKey: 'alert_thresholds',
      value: DEFAULT_ALERT_THRESHOLDS,
      changeNote: 'trying it on',
    });
    expect(refused.notice).toBe('admin_only');
    // A refused command re-reads nothing: the state on screen is still the one the
    // server last gave, rather than one the client edited optimistically.
    expect(calls.filter(call => call.path === '/settings')).toHaveLength(1);
  });

  it('re-reads the slice after an accepted command', async () => {
    const { api, calls } = scriptedApi({
      '/settings': { status: 200, body: settingsBody() },
      '/pipeline/stages': { status: 200, body: stagesBody },
      '/pipeline/stages/create': { status: 200, body: { status: 'accepted', replayed: false, result: {} } },
    });
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    await bridge.state();
    await bridge.createStage({ key: 'demo', displayName: 'Demo' });
    expect(calls.filter(call => call.path === '/settings')).toHaveLength(2);
    const created = calls.find(call => call.path === '/pipeline/stages/create')?.body as Record<string, unknown>;
    // 5.3's envelope is added by the client, so no caller can forget it.
    expect(typeof created['commandId']).toBe('string');
    expect(created['clientVersion']).toBe('1.4.0');
  });

  it('names one channel per method, and nothing else', () => {
    expect(Object.values(ADMIN_IPC_CHANNELS)).toEqual([
      'callie:admin:state',
      'callie:admin:show',
      'callie:admin:save-setting',
      'callie:admin:open-history',
      'callie:admin:load-dashboard',
      'callie:admin:create-stage',
      'callie:admin:rename-stage',
      'callie:admin:reorder-stages',
      'callie:admin:retire-stage',
      'callie:admin:acknowledge-alert',
      'callie:admin:set-sending-cap',
      'callie:admin:record-sending-authentication',
      'callie:admin:record-holiday-calendar',
      'callie:admin:add-calling-number',
      'callie:admin:attest-calling-number',
      'callie:admin:retire-calling-number',
    ]);
  });

  it("reads G7-2's sending posture for an admin, and not at all for a salesperson", async () => {
    const answers = {
      '/settings': { status: 200, body: settingsBody() },
      '/pipeline/stages': { status: 200, body: stagesBody },
      '/outbound/status': {
        status: 200,
        // The route's own shape (`support/outboundStatus.ts`, held to the route by
        // `test/release/sendingSection.check.ts`): the recipients are an object.
        body: outboundStatusAnswer({
          personalGmailRecipients: { automated: 2, direct: 1, total: 3 },
          ramp: outboundRampAnswer(MAILBOX_ID, { healthySendingDays: 3 }),
        }),
      },
      '/diagnostics': { status: 200, body: diagnosticsBody(MAILBOX_ID) },
    };

    const admin = scriptedApi(answers);
    const state = await createAdminBridge({
      api: admin.api,
      session: { state: async () => await Promise.resolve(session()) },
    }).state();
    expect(state.sendingReadError).toBeNull();
    expect(state.sendingAdmin?.domain?.domain).toBe('sending.example.test');
    // The whole guard — FSS's two and the one direct send — never one half of it.
    expect(state.sendingAdmin?.personalGmailRecipients).toBe(3);
    expect(adminViewOf(state).sendingAdmin?.guard.line).toBe('Personal-Gmail guard: 4000 per 24 hours, 3 used.');
    expect(state.sendingAdmin?.ramps).toEqual([
      {
        mailboxId: MAILBOX_ID,
        healthySendingDays: 3,
        effectiveCap: 5,
        adminDailyCap: null,
        raisedDailyCap: null,
        lastHealthFailure: null,
      },
    ]);
    // The per-mailbox ramp is asked for by id; `/outbound/status` has no list form.
    expect(admin.calls.filter(call => call.path === '/outbound/status').at(-1)?.body).toEqual({
      mailboxId: MAILBOX_ID,
    });

    // Every `/outbound/*` path is admin-only with a redacted 403, so a salesperson's
    // page does not ask: a control that cannot work is not offered, and a request
    // that is going to be refused is not made.
    const salesperson = scriptedApi(answers);
    const theirs = await createAdminBridge({
      api: salesperson.api,
      session: {
        state: async () => await Promise.resolve(session({ device: { role: 'salesperson' as const } })),
      },
    }).state();
    expect(theirs.sendingAdmin).toBeNull();
    expect(salesperson.calls.map(call => call.path)).not.toContain('/outbound/status');
  });

  it('keeps a failed sending read as its code, and asks again on the next state() and on show (lane g69)', async () => {
    // The answer 1.0.2 and 1.0.3 expected and the route never sent: a number where the
    // route sends `{ automated, direct, total }`. Here it stands for any answer this
    // parser cannot read.
    let status: HttpAnswer = {
      status: 200,
      body: { ...outboundStatusAnswer(), personalGmailRecipients: 1 },
    };
    const { api, calls } = scriptedApi({
      '/settings': { status: 200, body: settingsBody() },
      '/pipeline/stages': { status: 200, body: stagesBody },
      get '/outbound/status'() {
        return status;
      },
      '/diagnostics': { status: 200, body: diagnosticsBody(MAILBOX_ID) },
    });
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    const statusReads = (): number => calls.filter(call => call.path === '/outbound/status').length;

    const failed = await bridge.state();
    expect(failed.sendingAdmin).toBeNull();
    expect(failed.sendingReadError).toBe('unreadable_answer');
    // Not a notice: the rest of the page is untouched.
    expect(failed.notice).toBeNull();
    expect(adminViewOf(failed).sendingUnread?.line).toBe(
      'Callie could not read the sending status. The answer was not in the shape this version of Callie reads (unreadable_answer).',
    );

    // Home's focus and Refresh read `state()`: a failed read is asked again there, and
    // only the sending read — the settings it already holds are not.
    status = { status: 500, body: { error: 'internal_error' } };
    const again = await bridge.state();
    expect(statusReads()).toBe(2);
    expect(calls.filter(call => call.path === '/settings')).toHaveLength(1);
    expect(again.sendingReadError).toBe('internal_error');
    expect(adminViewOf(again).sendingUnread?.line).toBe(
      'Callie could not read the sending status. The server answered internal_error.',
    );

    // Retry is the Settings screen shown again, and it recovers.
    status = { status: 200, body: outboundStatusAnswer({ ramp: outboundRampAnswer(MAILBOX_ID) }) };
    const recovered = await bridge.show({ screen: 'settings' });
    expect(recovered.sendingReadError).toBeNull();
    expect(recovered.sendingAdmin?.domain?.domain).toBe('sending.example.test');
    expect(adminViewOf(recovered).sendingUnread).toBeNull();
    expect(adminViewOf(recovered).sendingAdmin).not.toBeNull();

    // And a read that succeeded is not repeated on every focus.
    const before = statusReads();
    await bridge.state();
    expect(statusReads()).toBe(before);
  });

  it('reads the sending posture even when the settings read fails (lane g69)', async () => {
    const { api, calls } = scriptedApi({
      '/settings': { status: 500, body: { error: 'internal_error' } },
      '/outbound/status': { status: 200, body: outboundStatusAnswer() },
      '/diagnostics': { status: 200, body: diagnosticsBody(MAILBOX_ID) },
    });
    const state = await createAdminBridge({
      api,
      session: { state: async () => await Promise.resolve(session()) },
    }).state();
    expect(state.notice).toBe('internal_error');
    expect(state.settings).toBeNull();
    expect(calls.map(call => call.path)).toContain('/outbound/status');
    expect(state.sendingAdmin?.domain?.domain).toBe('sending.example.test');
    expect(state.sendingReadError).toBeNull();
  });

  it('drops what it read under one role when the session comes back with another (lane g69)', async () => {
    let role: 'admin' | 'salesperson' = 'salesperson';
    const month = { from: '2026-08-26T12:00:00.000Z', to: '2026-09-25T12:00:00.000Z' };
    const { api, calls } = scriptedApi({
      '/settings': { status: 200, body: settingsBody() },
      '/pipeline/stages': { status: 200, body: stagesBody },
      '/outbound/status': { status: 200, body: outboundStatusAnswer() },
      '/diagnostics': { status: 200, body: diagnosticsBody(MAILBOX_ID) },
      '/dashboard': {
        status: 200,
        body: {
          window: month,
          audience: 'workspace',
          firmsInScope: 0,
          messages: { incomingMatched: 0, human: 0, uncertain: 0, automated: 0, bounces: 0, optOuts: 0 },
          replyHandling: { replies: 0, handled: 0, medianSecondsToHandle: null, slowestSecondsToHandle: null },
          calls: [],
          stageMovement: [],
          holds: { open: 0, byReason: [] },
          suppressions: [],
          sending: { available: false, owner: 'G7-2', reason: 'not in this build' },
          enrollments: { available: false, owner: 'G8', reason: 'not in this build' },
          classifier: { available: false, owner: 'G7b', reason: 'not in this build' },
        },
      },
    });
    const bridge = createAdminBridge({
      api,
      session: { state: async () => await Promise.resolve(session({ device: { role } })) },
    });

    // Signed in as a salesperson: no sending read, no section, no unread line.
    const before = await bridge.state();
    expect(calls.map(call => call.path)).not.toContain('/outbound/status');
    expect(adminViewOf(before).sendingAdmin).toBeNull();
    expect(adminViewOf(before).sendingUnread).toBeNull();

    // A renewal said admin. The next read asks for the posture it never had.
    role = 'admin';
    const promoted = await bridge.state();
    expect(promoted.role).toBe('admin');
    expect(calls.map(call => call.path)).toContain('/outbound/status');
    expect(promoted.sendingAdmin?.domain?.domain).toBe('sending.example.test');
    await bridge.show({ screen: 'diagnostics' });
    const held = await bridge.loadDashboard(month);
    expect(held.diagnostics).not.toBeNull();
    expect(held.dashboard).not.toBeNull();

    // And back: nothing read as an admin outlives the role it was read under.
    role = 'salesperson';
    const demoted = await bridge.state();
    expect(demoted.role).toBe('salesperson');
    expect(demoted.sendingAdmin).toBeNull();
    expect(demoted.sendingReadError).toBeNull();
    expect(demoted.diagnostics).toBeNull();
    expect(demoted.dashboard).toBeNull();
  });

  it("sends a cap change to G7-2's command and re-reads the posture", async () => {
    const { api, calls } = scriptedApi({
      '/settings': { status: 200, body: settingsBody() },
      '/pipeline/stages': { status: 200, body: stagesBody },
      '/outbound/status': { status: 200, body: outboundStatusAnswer() },
      '/diagnostics': { status: 200, body: diagnosticsBody(MAILBOX_ID) },
      '/outbound/cap': {
        status: 200,
        body: { status: 'accepted', replayed: false, result: { mailboxId: MAILBOX_ID, effectiveCap: 25, healthySendingDays: 3 } },
      },
    });
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    await bridge.state();
    const before = calls.length;
    await bridge.setSendingCap({ mailboxId: MAILBOX_ID, raiseTo: 25 });

    const sent = calls.find(call => call.path === '/outbound/cap')?.body as Record<string, unknown>;
    expect(sent['mailboxId']).toBe(MAILBOX_ID);
    expect(sent['raiseTo']).toBe(25);
    // No `lowerTo` key at all: the command reads an absent key and a null one
    // differently, and null clears the lowering.
    expect('lowerTo' in sent).toBe(false);
    expect(typeof sent['commandId']).toBe('string');
    expect(calls.slice(before).map(call => call.path)).toContain('/outbound/status');
  });

  it("sends the authentication checklist and the per-domain enable to G7-2's command", async () => {
    const { api, calls } = scriptedApi({
      '/settings': { status: 200, body: settingsBody() },
      '/pipeline/stages': { status: 200, body: stagesBody },
      '/outbound/status': { status: 200, body: outboundStatusAnswer() },
      '/diagnostics': { status: 200, body: diagnosticsBody(MAILBOX_ID) },
      '/outbound/authentication': { status: 200, body: { status: 'accepted', replayed: false, result: { domain: 'sending.example.test' } } },
    });
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    await bridge.state();
    await bridge.recordSendingAuthentication({
      domain: 'sending.example.test',
      spfPass: true,
      dkimPass: true,
      dmarcPass: true,
      postmasterReviewed: true,
      automatedSendingEnabled: true,
    });

    expect(calls.find(call => call.path === '/outbound/authentication')?.body).toMatchObject({
      domain: 'sending.example.test',
      spfPass: true,
      dkimPass: true,
      dmarcPass: true,
      postmasterReviewed: true,
      automatedSendingEnabled: true,
    });
  });

  it("sends a new holiday calendar to G8's command and re-reads the settings", async () => {
    const { api, calls } = scriptedApi({
      '/settings': { status: 200, body: settingsBody() },
      '/pipeline/stages': { status: 200, body: stagesBody },
      '/outbound/status': { status: 200, body: outboundStatusAnswer() },
      '/diagnostics': { status: 200, body: diagnosticsBody(MAILBOX_ID) },
      '/sequences/holidays': {
        status: 200,
        body: { status: 'accepted', replayed: false, result: { version: '2027-federal' } },
      },
    });
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    await bridge.state();
    const before = calls.length;
    await bridge.recordHolidayCalendar({ version: '2027-federal', dates: ['2027-01-01'] });

    // G8's path, not one of this lane's: the calendar is a versioned row whose
    // version is frozen onto every due instant computed under it.
    const sent = calls.find(call => call.path === '/sequences/holidays')?.body as Record<string, unknown>;
    expect(sent['version']).toBe('2027-federal');
    expect(sent['dates']).toEqual(['2027-01-01']);
    expect(typeof sent['commandId']).toBe('string');
    // Re-read through `/settings`, which is where the current calendar is carried.
    expect(calls.slice(before).map(call => call.path)).toContain('/settings');
  });

  it('keeps a refusal from the sending commands as the notice, unchanged', async () => {
    const { api } = scriptedApi({
      '/settings': { status: 200, body: settingsBody() },
      '/pipeline/stages': { status: 200, body: stagesBody },
      '/outbound/status': { status: 200, body: outboundStatusAnswer() },
      '/diagnostics': { status: 200, body: diagnosticsBody(MAILBOX_ID) },
      '/outbound/authentication': { status: 409, body: { error: 'authentication_incomplete' } },
    });
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    await bridge.state();
    const state = await bridge.recordSendingAuthentication({
      domain: 'sending.example.test',
      spfPass: true,
      dkimPass: false,
      dmarcPass: true,
      postmasterReviewed: true,
      automatedSendingEnabled: true,
    });
    expect(state.notice).toBe('authentication_incomplete');
  });

  it('adds a calling number and attests it in one press, as two commands in that order (lane g60)', async () => {
    const identity = callingIdentity({ id: IDENTITY_ID });
    const attested = callingIdentity({
      id: IDENTITY_ID,
      verificationStatus: 'verified',
      enabled: true,
      verifiedAt: '2026-09-25T13:00:00.000Z',
      verifiedByUserId: '11111111-1111-4111-8111-111111111111',
      verificationMethod: 'owner_attestation',
      usedForCalls: true,
    });
    const listed: HttpAnswer[] = [
      { status: 200, body: { identities: [] } },
      { status: 200, body: { identities: [attested] } },
    ];
    const calls: { path: string; body: unknown }[] = [];
    const api = createAuthedClient({
      baseUrl: 'https://api.example.test/',
      clientVersion: '1.0.2',
      accessToken: async () => await Promise.resolve('token-value'),
      send: async (url, init) => {
        const path = new URL(url).pathname;
        calls.push({ path, body: init.body === undefined ? null : JSON.parse(init.body) });
        const answers: Record<string, HttpAnswer> = {
          '/settings': { status: 200, body: settingsBody() },
          '/pipeline/stages': { status: 200, body: stagesBody },
          '/calling-identities/register': {
            status: 200,
            body: { status: 'accepted', replayed: false, result: { outcome: 'created', identity } },
          },
          '/calling-identities/attest': {
            status: 200,
            body: { status: 'accepted', replayed: false, result: { outcome: 'verified', identity: attested } },
          },
        };
        if (path === '/calling-identities') return await Promise.resolve(listed.shift() ?? { status: 500, body: {} });
        return await Promise.resolve(answers[path] ?? { status: 404, body: { error: 'not_found' } });
      },
    });
    const bridge = createAdminBridge({
      api,
      session: { state: async () => await Promise.resolve(session({ device: { role: 'salesperson' as const } })) },
    });
    const before = await bridge.state();
    expect(before.callingNumbers).toEqual([]);
    expect(adminViewOf(before).callingNumber.summary).toContain('Today has no Call button');

    const after = await bridge.addCallingNumber({ e164: '+1 401 555 0150', label: 'Mobile', attested: true });
    const sequence = calls.map(call => call.path).filter(path => path.startsWith('/calling-identities'));
    expect(sequence).toEqual([
      '/calling-identities',
      '/calling-identities/register',
      '/calling-identities/attest',
      '/calling-identities',
    ]);
    // The number goes as typed: normalizing it is the server's rule, not the client's.
    expect(calls.find(call => call.path === '/calling-identities/register')?.body).toMatchObject({
      e164: '+1 401 555 0150',
      label: 'Mobile',
      clientVersion: '1.0.2',
    });
    expect(calls.find(call => call.path === '/calling-identities/attest')?.body).toMatchObject({
      identityId: IDENTITY_ID,
      attested: true,
    });
    expect(after.notice).toBeNull();
    expect(after.callingNumbers?.map(number => [number.id, number.usedForCalls])).toEqual([[IDENTITY_ID, true]]);
    expect(adminViewOf(after).callingNumber.summary).toBe('Today calls from +14015550150 (Mobile).');
  });

  it('adds a number without attesting it when the statement is not ticked, and keeps a refusal as the notice', async () => {
    const { api, calls } = scriptedApi({
      '/settings': { status: 200, body: settingsBody() },
      '/pipeline/stages': { status: 200, body: stagesBody },
      '/calling-identities': { status: 200, body: { identities: [] } },
      '/calling-identities/register': { status: 409, body: { status: 'refused', replayed: false, reason: 'number_invalid' } },
    });
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    await bridge.state();
    const refused = await bridge.addCallingNumber({ e164: '401-555-0150', label: '', attested: true });
    expect(refused.notice).toBe('number_invalid');
    // Refused at the registration, so nothing was attested, and no empty label was sent.
    expect(calls.map(call => call.path)).not.toContain('/calling-identities/attest');
    expect(calls.find(call => call.path === '/calling-identities/register')?.body).not.toHaveProperty('label');
    expect(adminViewOf(refused).notice).toContain('+ and your country code');
  });

  it('shows the registered number when its attestation is refused, with the refusal as the notice', async () => {
    const { api, calls } = scriptedApi({
      '/settings': { status: 200, body: settingsBody() },
      '/pipeline/stages': { status: 200, body: stagesBody },
      '/calling-identities': { status: 200, body: { identities: [callingIdentity()] } },
      '/calling-identities/register': {
        status: 200,
        body: { status: 'accepted', replayed: false, result: { outcome: 'created', identity: callingIdentity() } },
      },
      '/calling-identities/attest': { status: 409, body: { status: 'refused', replayed: false, reason: 'owner_not_member' } },
    });
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    await bridge.state();
    const before = calls.filter(call => call.path === '/calling-identities').length;
    const state = await bridge.addCallingNumber({ e164: '+14015550150', label: '', attested: true });
    expect(state.notice).toBe('owner_not_member');
    expect(calls.filter(call => call.path === '/calling-identities').length).toBe(before + 1);
    expect(adminViewOf(state).callingNumber.numbers.map(number => [number.status, number.canAttest])).toEqual([
      ['unverified', true],
    ]);
  });

  it('attests and retires a number through their own commands', async () => {
    const { api, calls } = scriptedApi({
      '/settings': { status: 200, body: settingsBody() },
      '/pipeline/stages': { status: 200, body: stagesBody },
      '/calling-identities': { status: 200, body: { identities: [callingIdentity({ id: IDENTITY_ID })] } },
      '/calling-identities/attest': {
        status: 200,
        body: { status: 'accepted', replayed: false, result: { outcome: 'verified', identity: callingIdentity({ id: IDENTITY_ID }) } },
      },
      '/calling-identities/disable': {
        status: 200,
        body: { status: 'accepted', replayed: false, result: { outcome: 'disabled', identity: callingIdentity({ id: IDENTITY_ID }) } },
      },
    });
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    await bridge.state();
    await bridge.attestCallingNumber({ identityId: IDENTITY_ID });
    await bridge.retireCallingNumber({ identityId: IDENTITY_ID });
    expect(calls.find(call => call.path === '/calling-identities/attest')?.body).toMatchObject({
      identityId: IDENTITY_ID,
      attested: true,
    });
    expect(calls.find(call => call.path === '/calling-identities/disable')?.body).toMatchObject({ identityId: IDENTITY_ID });
    expect(calls.find(call => call.path === '/calling-identities/disable')?.body).not.toHaveProperty('attested');
  });
});

describe('a setting’s history shows what changed, not only when (lane g78, D04)', () => {
  it('keeps the values the route sends, and the value in force now', async () => {
    const { api, calls } = scriptedApi({
      '/settings': { status: 200, body: settingsBody() },
      '/pipeline/stages': { status: 200, body: stagesBody },
      '/settings/history': { status: 200, body: settingHistoryAnswer() },
    });
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    const state = await bridge.openHistory({ settingKey: 'business_time_zone' });
    expect(calls.find(call => call.path === '/settings/history')?.body).toEqual({ settingKey: 'business_time_zone' });
    expect(state.history?.current).toEqual({ value: { timeZone: 'America/Chicago' }, version: 2 });
    expect(state.history?.versions.map(entry => entry.value)).toEqual([
      { timeZone: 'America/Chicago' },
      { timeZone: 'America/Denver' },
    ]);
  });

  it('draws each version from the one before it, and version 1 from the default', () => {
    const view = adminViewOf(emptyState({ history: settingHistoryAnswer() }));
    expect(view.history?.heading).toBe('History of Workspace business zone');
    expect(view.history?.currentLine).toBe('In force now: version 2: {"timeZone":"America/Chicago"}');
    expect(view.history?.versions).toEqual([
      {
        version: 2,
        line: 'Version 2, changed 2026-09-19T10:00:00.000Z: the office moved',
        from: '{"timeZone":"America/Denver"}',
        to: '{"timeZone":"America/Chicago"}',
        current: true,
      },
      {
        version: 1,
        line: 'Version 1, changed 2026-09-18T10:00:00.000Z: first configuration',
        from: '{"timeZone":"America/New_York"} (the default)',
        to: '{"timeZone":"America/Denver"}',
        current: false,
      },
    ]);
  });

  it('says when the version before is older than the list, and names a slice nobody set', () => {
    const [newest] = settingHistoryAnswer().versions;
    const trimmed = adminViewOf(
      emptyState({ history: settingHistoryAnswer({ versions: newest === undefined ? [] : [newest] }) }),
    );
    expect(trimmed.history?.versions[0]?.from).toBe('version 1, older than this list');

    const never = adminViewOf(
      emptyState({
        history: settingHistoryAnswer({ current: { value: { timeZone: 'America/New_York' }, version: 0 }, versions: [] }),
      }),
    );
    expect(never.history?.currentLine).toBe('In force now: the default, never configured: {"timeZone":"America/New_York"}');
  });

  it('reads a ceiling’s published maximum as a release line on Diagnostics (lane g78)', () => {
    const report = diagnosticsBody(MAILBOX_ID);
    const view = adminViewOf(
      emptyState({
        screen: 'diagnostics',
        diagnostics: { ...report, clientVersions: { minimum: '1.0.0', maximum: '1.999.999' } } as AdminState['diagnostics'],
      }),
    );
    expect(JSON.stringify(view.panels)).toContain('Clients 1.0.0 to any 1.x.');
  });
});

describe('the administration view', () => {
  const withSettings = (overrides: Record<string, unknown> = {}): AdminState =>
    emptyState({ settings: settingsBody(overrides) as never });

  it('offers editing to an admin and explains why it is inert to everyone else', () => {
    expect(adminViewOf(withSettings()).settings.every(row => row.editable)).toBe(true);

    const salesperson = adminViewOf(
      emptyState({ role: 'salesperson', settings: settingsBody() as never }),
    );
    expect(salesperson.settings.every(row => !row.editable)).toBe(true);
    expect(salesperson.settings[0]?.notEditableBecause).toBe('admin_only');

    const offline = adminViewOf(emptyState({ online: false, settings: settingsBody() as never }));
    // Offline comes first: an admin who is offline is told that, not "admin only".
    expect(offline.settings[0]?.notEditableBecause).toBe('offline');
    expect(offline.banner).toContain('Offline');

    const outdated = adminViewOf(emptyState({ mayMutate: false, settings: settingsBody() as never }));
    expect(outdated.settings[0]?.notEditableBecause).toBe('upgrade_required');
  });

  it('says whether a slice is a default or a version somebody wrote', () => {
    const view = adminViewOf(withSettings());
    expect(view.settings[0]?.provenance).toBe('Default, never configured');
    expect(view.settings[1]?.provenance).toContain('Version 2');
  });

  it('reads the sending switch out rather than recomputing it', () => {
    expect(adminViewOf(withSettings()).sending?.line).toContain('release process has not enabled');
    expect(
      adminViewOf(withSettings({ deploymentSendingEnabled: true }))?.sending?.line,
    ).toContain('an admin has not enabled it');
    expect(
      adminViewOf(withSettings({ deploymentSendingEnabled: true, effectiveSendingEnabled: true }))?.sending?.line,
    ).toBe('Production sending is enabled.');
  });

  it('refuses to offer stage administration on a terminal stage', () => {
    const view = adminViewOf(
      emptyState({
        settings: settingsBody() as never,
        stages: [
          { key: 'new', displayName: 'New', position: 1, terminalKind: null, retired: false },
          { key: 'won', displayName: 'Won', position: 2, terminalKind: 'won', retired: false },
          { key: 'demo', displayName: 'Demo', position: 3, terminalKind: null, retired: true },
        ],
      }),
    );
    expect(view.stages.map(stage => stage.administrable)).toEqual([true, false, true]);
    expect(view.stages[1]?.note).toContain('terminal');
    // "Retired stages remain readable": still listed, and it says so.
    expect(view.stages[2]?.label).toBe('Demo (retired)');
  });

  it('shows an unavailable figure as unavailable rather than as zero', () => {
    const view = adminViewOf(
      emptyState({
        screen: 'dashboard',
        dashboard: {
          window: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
          audience: 'workspace',
          firmsInScope: 2,
          messages: { incomingMatched: 0, human: 0, uncertain: 0, automated: 0, bounces: 0, optOuts: 0 },
          replyHandling: { replies: 0, handled: 0, medianSecondsToHandle: null, slowestSecondsToHandle: null },
          calls: [],
          stageMovement: [],
          holds: { open: 0, byReason: [] },
          suppressions: [],
          sending: { available: false, owner: 'G7-2', reason: 'the outbound fence is not in this build' },
          enrollments: { available: false, owner: 'G8', reason: 'sequences are not in this build' },
          classifier: { available: false, owner: 'G7b', reason: 'model records are not in this build' },
        } as never,
      }),
    );
    const email = view.panels.find(panel => panel.title === 'Email');
    expect(email?.unavailable).toContain('G7-2');
    const handling = view.panels.find(panel => panel.title === 'Reply handling');
    // This one *is* computable, so it renders numbers rather than an excuse.
    expect(handling?.unavailable).toBeNull();
    expect(handling?.lines[0]).toBe('0 of 0 handled.');
  });

  it('puts a runbook beside every alert whose key is an alarm key', () => {
    const view = adminViewOf(
      emptyState({
        screen: 'diagnostics',
        diagnostics: {
          restore: { systemGeneration: 1, expectedSystemGeneration: 1, mismatch: false },
          schema: { appliedVersion: 13, declaredRange: { minimum: 13, maximum: 13 }, accepted: true },
          clientVersions: { minimum: '1.0.0', maximum: '1.4.0' },
          sending: { deploymentEnabled: false, adminEnabled: false, effective: false },
          jobs: { runnable: 0, running: 0, retryable: 0, dead: 1, oldestRunnableAgeSeconds: null, oldestDeadAgeSeconds: 4000 },
          heartbeats: [],
          canaryCompletionAgeSeconds: null,
          alerts: [
            {
              id: '22222222-2222-4222-8222-222222222222',
              alertKey: 'canary_stale',
              severity: 'critical',
              raisedAt: '2026-09-20T10:00:00.000Z',
              acknowledgedAt: null,
              runbookPath: 'docs/greenfield/runbooks/canary_stale.md',
            },
            {
              id: '33333333-3333-4333-8333-333333333333',
              alertKey: 'something_local',
              severity: 'warning',
              raisedAt: '2026-09-20T10:00:00.000Z',
              acknowledgedAt: '2026-09-20T10:05:00.000Z',
              runbookPath: null,
            },
          ],
          mailboxes: [],
          mailboxVisibility: 'own',
        } as never,
      }),
    );
    expect(view.alerts[0]).toMatchObject({
      runbookPath: 'docs/greenfield/runbooks/canary_stale.md',
      acknowledgeable: true,
    });
    // Already acknowledged: no second acknowledgement to offer.
    expect(view.alerts[1]?.acknowledgeable).toBe(false);
    expect(view.panels.find(panel => panel.title === 'Restore generation')?.lines[1]).toBe('Matches.');
  });

  it("renders G7-2's sending section, with the personal-Gmail guard read-only", () => {
    const view = adminViewOf({
      ...withSettings(),
      sendingAdmin: {
        domain: {
          domain: 'sending.example.test',
          spfPass: true,
          dkimPass: true,
          dmarcPass: false,
          postmasterReviewedAt: null,
          authenticationPasses: false,
          automatedSendingEnabled: false,
          personalGmailGuardPer24h: 4000,
        },
        personalGmailRecipients: 12,
        ramps: [
          {
            mailboxId: '55555555-5555-4555-8555-555555555555',
            healthySendingDays: 3,
            effectiveCap: 5,
            adminDailyCap: null,
            raisedDailyCap: null,
            lastHealthFailure: null,
          },
        ],
      },
    });

    const section = view.sendingAdmin;
    expect(section?.editable).toBe(true);
    expect(section?.domainLine).toContain('sending.example.test');
    // The CHECK forbids enabling without all four, so the page says which is missing
    // rather than offering an enable that the database will refuse.
    expect(section?.domainLine).toContain('dmarc');
    expect(section?.guard.editable).toBe(false);
    expect(section?.guard.readOnlyBecause).toContain('reviewed policy change');
    expect(section?.guard.line).toContain('4000');
    expect(section?.ramps[0]?.line).toContain('5');
    expect(section?.ramps[0]?.editable).toBe(true);
  });

  it('says an admin’s sending read failed, with its code, where the section would be (lane g69)', () => {
    const view = adminViewOf({ ...withSettings(), sendingReadError: 'offline' });
    expect(view.sendingAdmin).toBeNull();
    expect(view.sendingUnread?.line).toBe('Callie could not read the sending status. The server did not answer (offline).');
    // A salesperson's page never asked, so it has nothing to say about it.
    expect(adminViewOf({ ...withSettings(), role: 'salesperson', sendingReadError: 'offline' }).sendingUnread).toBeNull();
    // Nothing failed, nothing to say.
    expect(adminViewOf(withSettings()).sendingUnread).toBeNull();
    // A posture that is held is shown, whatever an earlier read said.
    const held = adminViewOf({
      ...withSettings(),
      sendingAdmin: { domain: null, personalGmailRecipients: 0, ramps: [] },
      sendingReadError: 'offline',
    });
    expect(held.sendingUnread).toBeNull();
    expect(held.sendingAdmin?.domainLine).toBe('No sending domain is configured.');
  });

  it('shows a salesperson no sending section at all', () => {
    const view = adminViewOf({ ...withSettings(), role: 'salesperson' });
    expect(view.sendingAdmin).toBeNull();
    // The calendar is not hidden from them, only made inert: a salesperson whose
    // step was delayed by a holiday is entitled to see which holiday.
    expect(view.holidays?.editable).toBe(false);
    expect(view.holidays?.notEditableBecause).toBe('admin_only');
  });

  it("names G8's calendar and says weekends are not in it", () => {
    const view = adminViewOf(withSettings());
    expect(view.holidays?.line).toContain('No holidays are configured');
    expect(view.holidays?.line).toContain('Weekends are skipped by the rule');

    const configured = adminViewOf(
      withSettings({ holidayCalendar: { version: '2026-federal', dates: ['2026-12-25'] } }),
    );
    expect(configured.holidays?.line).toBe('Version "2026-federal": 1 dates.');
    expect(configured.holidays?.editable).toBe(true);
  });
});

describe('the window menu', () => {
  it('offers the administration window and still works without it', () => {
    const noop = (): void => undefined;
    const withAdmin = windowMenuTemplate({
      today: noop,
      replies: noop,
      firms: noop,
      sequences: noop,
      administration: noop,
    });
    expect(withAdmin[0]?.submenu.map(item => item.label)).toEqual([
      'Today',
      'Replies',
      'Firms',
      'Sequences',
      'Administration',
    ]);
    // ⌘1 to ⌘4 are the windows somebody sells from and they keep them; this one
    // takes the next free key rather than pushing a window used all day along.
    expect(withAdmin[0]?.submenu.map(item => item.accelerator)).toEqual([
      'CmdOrCtrl+1',
      'CmdOrCtrl+2',
      'CmdOrCtrl+3',
      'CmdOrCtrl+4',
      'CmdOrCtrl+5',
    ]);
    const without = windowMenuTemplate({ today: noop, replies: noop, firms: noop, sequences: noop });
    expect(without[0]?.submenu.map(item => item.label)).toEqual([
      'Today',
      'Replies',
      'Firms',
      'Sequences',
    ]);
  });
});

describe('the screen the window opens on (lane g65)', () => {
  it('is the one the opener named — ⌘5 Settings, ⌘6 Dashboard — and the last one shown otherwise', () => {
    expect(requestedScreen('?screen=settings')).toBe('settings');
    expect(requestedScreen('?screen=dashboard')).toBe('dashboard');
    expect(requestedScreen('?screen=diagnostics')).toBe('diagnostics');
    for (const search of ['', '?', '?screen=', '?screen=Dashboard', '?screen=history', '?other=dashboard']) {
      expect(requestedScreen(search), search).toBeNull();
    }
  });
});

describe('Your calling number (lane g60)', () => {
  it('is offered to a salesperson as well as an admin, and is inert only offline or out of date', () => {
    for (const role of ['admin', 'salesperson'] as const) {
      const section = adminViewOf(emptyState({ role, callingNumbers: [] })).callingNumber;
      expect(section.canAdd, role).toBe(true);
      expect(section.notEditableBecause, role).toBeNull();
    }
    expect(adminViewOf(emptyState({ online: false, callingNumbers: [] })).callingNumber).toMatchObject({
      canAdd: false,
      notEditableBecause: 'offline',
    });
    expect(adminViewOf(emptyState({ mayMutate: false, callingNumbers: [] })).callingNumber).toMatchObject({
      canAdd: false,
      notEditableBecause: 'upgrade_required',
    });
  });

  it('says why there is no Call button, and never shows an unread list as an empty one', () => {
    expect(adminViewOf(emptyState({ callingNumbers: [] })).callingNumber.summary).toBe(
      'You have no calling number yet, so Today has no Call button. Add the number you place your calls from.',
    );
    const unread = adminViewOf(emptyState({ callingNumbers: null })).callingNumber;
    expect(unread.summary).toContain('could not read your calling numbers');
    // Adding blind could register a second number beside one the page cannot see.
    expect(unread.canAdd).toBe(false);
    expect(adminViewOf(emptyState({ callingNumbers: [numberView()] })).callingNumber.summary).toContain(
      'None of your numbers is attested',
    );
  });

  it('shows the server’s choice of number, and offers the controls each state allows', () => {
    const section = adminViewOf(
      emptyState({
        callingNumbers: [
          numberView({
            id: '66666666-6666-4666-8666-000000000001',
            verificationStatus: 'verified',
            enabled: true,
            verifiedAt: '2026-09-25T13:00:00.000Z',
            verificationMethod: 'owner_attestation',
            usedForCalls: true,
          }),
          numberView({
            id: '66666666-6666-4666-8666-000000000002',
            e164: '+14015550151',
            label: null,
            verificationStatus: 'verified',
            enabled: true,
            verifiedAt: '2026-09-24T13:00:00.000Z',
            verificationMethod: 'admin_attestation',
          }),
          numberView({ id: '66666666-6666-4666-8666-000000000003', e164: '+14015550152', label: null }),
          numberView({
            id: '66666666-6666-4666-8666-000000000004',
            e164: '+14015550153',
            label: 'Old desk',
            verificationStatus: 'verified',
            disabledAt: '2026-09-20T09:00:00.000Z',
          }),
        ],
      }),
    ).callingNumber;
    expect(section.summary).toBe('Today calls from +14015550150 (Mobile).');
    expect(section.numbers.map(number => [number.status, number.canAttest, number.canRetire])).toEqual([
      ['in_use', false, true],
      ['verified', false, true],
      ['unverified', true, true],
      ['retired', true, false],
    ]);
    expect(section.numbers[0]?.line).toBe(
      '+14015550150 (Mobile): you attested it on 2026-09-25. Today calls from this number.',
    );
    expect(section.numbers[1]?.line).toContain('an admin attested it for you on 2026-09-24');
    expect(section.numbers[3]?.line).toContain('retired on 2026-09-20');
    expect(section.statement).toBe('This is the number I place my calls from.');
  });

  it('turns a calling-number refusal into a sentence and leaves every other code as it was', () => {
    expect(adminViewOf(emptyState({ notice: 'number_invalid', callingNumbers: [] })).notice).toBe(
      'Callie cannot call from that. Type the number with the + and your country code.',
    );
    expect(adminViewOf(emptyState({ notice: 'admin_only', callingNumbers: [] })).notice).toBe('admin_only');
  });
});
