import { describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_THRESHOLDS } from '@fss/contracts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { ADMIN_IPC_CHANNELS, createAdminBridge } from '../src/main/settingsBridge.ts';
import { adminViewOf } from '../src/renderer/settingsView.ts';
import { windowMenuTemplate } from '../src/main/todayWindow.ts';
import type { AdminState } from '../src/renderer/settingsContract.ts';

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
    {
      settingKey: 'postal_footer',
      value: {
        organizationName: 'Callie',
        addressLine: '1 Example Street',
        locality: 'Providence',
        regionCode: 'RI',
        postalCode: '02903',
        countryCode: 'US',
      },
      version: 2,
      changedAt: '2026-09-19T10:00:00.000Z',
      changedByUserId: '11111111-1111-4111-8111-111111111111',
      changeNote: 'the office moved',
    },
  ],
  elsewhere: [{ topic: 'Research limits', path: '/research/config', ownedBy: 'G10 research' }],
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
  ...overrides,
});

const outboundStatusBody = (overrides: Record<string, unknown> = {}) => ({
  domain: {
    domain: 'sending.example.test',
    spfPass: true,
    dkimPass: true,
    dmarcPass: false,
    postmasterReviewedAt: null,
    authenticationPasses: false,
    automatedSendingEnabled: false,
    personalGmailGuardPer24h: 4000,
    replyOnlyOptOut: true,
  },
  guard: { allowed: true, remaining: 3999 },
  personalGmailRecipients: 1,
  doubt: { unknownTerminal: 0, reconciling: 0 },
  ramp: null,
  fence: null,
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

describe('the administration bridge', () => {
  it('reads the settings and the pipeline on first open', async () => {
    const { api, calls } = scriptedApi({
      '/settings': { status: 200, body: settingsBody() },
      '/pipeline/stages': { status: 200, body: stagesBody },
    });
    const bridge = createAdminBridge({ api, session: { state: async () => await Promise.resolve(session()) } });
    const state = await bridge.state();
    expect(calls.map(call => call.path)).toEqual(['/settings', '/pipeline/stages', '/outbound/status']);
    expect(state.settings?.settings.map(entry => entry.settingKey)).toEqual([
      'alert_thresholds',
      'postal_footer',
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
    ]);
  });

  it("reads G7-2's sending posture for an admin, and not at all for a salesperson", async () => {
    const answers = {
      '/settings': { status: 200, body: settingsBody() },
      '/pipeline/stages': { status: 200, body: stagesBody },
      '/outbound/status': {
        status: 200,
        body: outboundStatusBody({
          ramp: {
            mailboxId: MAILBOX_ID,
            healthySendingDays: 3,
            effectiveCap: 5,
            adminDailyCap: null,
            raisedDailyCap: null,
            lastHealthFailure: null,
          },
        }),
      },
      '/diagnostics': { status: 200, body: diagnosticsBody(MAILBOX_ID) },
    };

    const admin = scriptedApi(answers);
    const state = await createAdminBridge({
      api: admin.api,
      session: { state: async () => await Promise.resolve(session()) },
    }).state();
    expect(state.sendingAdmin?.domain?.domain).toBe('sending.example.test');
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

  it("sends a cap change to G7-2's command and re-reads the posture", async () => {
    const { api, calls } = scriptedApi({
      '/settings': { status: 200, body: settingsBody() },
      '/pipeline/stages': { status: 200, body: stagesBody },
      '/outbound/status': { status: 200, body: outboundStatusBody() },
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
      '/outbound/status': { status: 200, body: outboundStatusBody() },
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

  it('keeps a refusal from the sending commands as the notice, unchanged', async () => {
    const { api } = scriptedApi({
      '/settings': { status: 200, body: settingsBody() },
      '/pipeline/stages': { status: 200, body: stagesBody },
      '/outbound/status': { status: 200, body: outboundStatusBody() },
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

  it('shows a salesperson no sending section at all', () => {
    const view = adminViewOf({ ...withSettings(), role: 'salesperson' });
    expect(view.sendingAdmin).toBeNull();
  });
});

describe('the window menu', () => {
  it('offers the administration window and still works without it', () => {
    const noop = (): void => undefined;
    const withAdmin = windowMenuTemplate({ today: noop, firms: noop, administration: noop });
    expect(withAdmin[0]?.submenu.map(item => item.label)).toEqual(['Today', 'Firms', 'Administration']);
    const without = windowMenuTemplate({ today: noop, firms: noop });
    expect(without[0]?.submenu.map(item => item.label)).toEqual(['Today', 'Firms']);
  });
});
