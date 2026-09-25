import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { DEFAULT_ALERT_THRESHOLDS } from '@fss/contracts';
import type { AdminState } from '../../../src/renderer/settingsContract.ts';

/**
 * The generated test server the administration window specs run against.
 *
 * The same substitution G2 made for Today and G6 for the CRM windows: the renderer
 * under test is the shipped file, transpiled with esbuild and served unmodified, and
 * the only thing replaced is the bridge — `globalThis.callieAdmin`, which in Electron
 * comes from the preload script and here comes from a small generated script that
 * posts back to this server.
 *
 * **Two roles, always.** Every fixture exists for an admin and for a salesperson. A
 * suite that only ever ran as an admin would pass with the inert-control logic
 * deleted, which is the thing most worth proving on this page.
 *
 * No real name, address or number appears here. `example.test` is reserved by
 * RFC 6761.
 */

const rendererDirectory = fileURLToPath(new URL('../../../src/renderer/', import.meta.url));

export const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
export const ALERT_ID = '33333333-3333-4333-8333-333333333333';

export interface SettingsTestServer {
  readonly url: string;
  /** Bridge method names in call order, and the arguments they were given. */
  readonly calls: { readonly method: string; readonly argument: unknown }[];
  stop(): Promise<void>;
}

export function settingsSnapshot(overrides: Record<string, unknown> = {}): NonNullable<AdminState['settings']> {
  return {
    settings: [
      {
        settingKey: 'alert_thresholds',
        value: DEFAULT_ALERT_THRESHOLDS,
        version: 0,
        changedAt: null,
        changedByUserId: null,
        changeNote: null,
      },
      // A configured slice, so the page has provenance to render beside a default.
      // This was `postal_footer` until migration 0015 removed that slice; there is no
      // postal footer to administer any more.
      {
        settingKey: 'business_time_zone',
        value: { timeZone: 'America/Chicago' },
        version: 2,
        changedAt: '2026-09-19T10:00:00.000Z',
        changedByUserId: ADMIN_ID,
        changeNote: 'the office moved',
      },
    ],
    elsewhere: [
      { topic: 'Research limits', path: '/research/config', ownedBy: 'G10 research' },
      { topic: 'Sending caps and the ramp', path: '/outbound/cap', ownedBy: 'G7-2 sending' },
    ],
    holidayCalendar: { version: '2026-federal', dates: ['2026-12-25'] },
    deploymentSendingEnabled: false,
    effectiveSendingEnabled: false,
    ...overrides,
  } as NonNullable<AdminState['settings']>;
}

export function dashboard(): NonNullable<AdminState['dashboard']> {
  return {
    window: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
    audience: 'assigned',
    firmsInScope: 3,
    messages: { incomingMatched: 4, human: 2, uncertain: 1, automated: 1, bounces: 0, optOuts: 0 },
    replyHandling: { replies: 2, handled: 1, medianSecondsToHandle: 900, slowestSecondsToHandle: 1800 },
    calls: [{ key: 'voicemail_left', count: 3 }],
    stageMovement: [{ key: 'contacting', count: 1 }],
    holds: { open: 1, byReason: [{ reasonCode: 'scoped_pause', count: 1, oldestAgeSeconds: 60 }] },
    suppressions: [],
    sending: { available: false, owner: 'G7-2', reason: 'the outbound fence is not in this build' },
    enrollments: { available: false, owner: 'G8', reason: 'sequences are not in this build' },
    classifier: { available: false, owner: 'G7b', reason: 'model records are not in this build' },
  } as NonNullable<AdminState['dashboard']>;
}

export function diagnostics(): NonNullable<AdminState['diagnostics']> {
  return {
    restore: { systemGeneration: 1, expectedSystemGeneration: 2, mismatch: true },
    schema: { appliedVersion: 13, declaredRange: { minimum: 13, maximum: 13 }, accepted: true },
    clientVersions: { minimum: '1.0.0', maximum: '1.4.0' },
    sending: { deploymentEnabled: false, adminEnabled: false, effective: false },
    jobs: { runnable: 0, running: 0, retryable: 0, dead: 1, oldestRunnableAgeSeconds: null, oldestDeadAgeSeconds: 4000 },
    heartbeats: [
      { component: 'worker', instanceKey: 'worker-1', ageSeconds: 5, expectedIntervalSeconds: 60, fresh: true },
    ],
    canaryCompletionAgeSeconds: 120,
    alerts: [
      {
        id: ALERT_ID,
        alertKey: 'canary_stale',
        severity: 'critical',
        raisedAt: '2026-09-20T10:00:00.000Z',
        acknowledgedAt: null,
        runbookPath: 'docs/greenfield/runbooks/canary_stale.md',
      },
    ],
    mailboxes: [
      {
        mailboxId: '44444444-4444-4444-8444-444444444444',
        ownerUserId: ADMIN_ID,
        status: 'connected',
        syncState: 'ready',
        coverageWatermarkAt: '2026-09-20T09:00:00.000Z',
        lastSyncedAt: '2026-09-20T09:00:00.000Z',
        lastSyncError: null,
        watchExpiresAt: '2026-09-27T09:00:00.000Z',
        hoursToWatchExpiry: 168,
        automationHeld: false,
      },
    ],
    mailboxVisibility: 'all',
  } as NonNullable<AdminState['diagnostics']>;
}

/** G7-2's posture, as `/outbound/status` would answer it: checklist incomplete. */
export function sendingPosture(): NonNullable<AdminState['sendingAdmin']> {
  return {
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
    personalGmailRecipients: 17,
    ramps: [
      {
        mailboxId: '44444444-4444-4444-8444-444444444444',
        healthySendingDays: 3,
        effectiveCap: 5,
        adminDailyCap: null,
        raisedDailyCap: null,
        lastHealthFailure: null,
      },
    ],
  };
}

export function adminState(overrides: Partial<AdminState> = {}): AdminState {
  return {
    screen: 'settings',
    role: 'admin',
    online: true,
    mayMutate: true,
    notice: null,
    settings: settingsSnapshot(),
    dashboard: null,
    diagnostics: null,
    stages: [
      { key: 'new', displayName: 'New', position: 1, terminalKind: null, retired: false },
      { key: 'won', displayName: 'Won', position: 2, terminalKind: 'won', retired: false },
    ],
    history: null,
    sendingAdmin: null,
    callingNumbers: [],
    ...overrides,
  };
}

/** The bridge the browser gets. The same sixteen methods the preload script exposes. */
const BRIDGE_SCRIPT = `
globalThis.callieAdmin = {
  async state() { return await ask('state'); },
  async show(input) { return await ask('show', input); },
  async saveSetting(input) { return await ask('saveSetting', input); },
  async openHistory(input) { return await ask('openHistory', input); },
  async loadDashboard(input) { return await ask('loadDashboard', input); },
  async createStage(input) { return await ask('createStage', input); },
  async renameStage(input) { return await ask('renameStage', input); },
  async reorderStages(input) { return await ask('reorderStages', input); },
  async retireStage(input) { return await ask('retireStage', input); },
  async acknowledgeAlert(input) { return await ask('acknowledgeAlert', input); },
  async setSendingCap(input) { return await ask('setSendingCap', input); },
  async recordSendingAuthentication(input) { return await ask('recordSendingAuthentication', input); },
  async recordHolidayCalendar(input) { return await ask('recordHolidayCalendar', input); },
  async addCallingNumber(input) { return await ask('addCallingNumber', input); },
  async attestCallingNumber(input) { return await ask('attestCallingNumber', input); },
  async retireCallingNumber(input) { return await ask('retireCallingNumber', input); },
};
async function ask(method, argument) {
  const response = await fetch('/bridge/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(argument ?? null),
  });
  return await response.json();
}
`;

async function transpile(): Promise<string> {
  const bundle = await build({
    entryPoints: [`${rendererDirectory}settingsPage.ts`],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    write: false,
    platform: 'browser',
  });
  return bundle.outputFiles[0]?.text ?? '';
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

export async function startSettingsTestServer(initial: AdminState): Promise<SettingsTestServer> {
  const script = await transpile();
  const html = (await readFile(`${rendererDirectory}settings.html`, 'utf8'))
    .replace('<script type="module"', '<script src="./bridge.js"></script>\n    <script type="module"')
    // The shipped page has `connect-src 'none'` because the real renderer talks to
    // the main process across an IPC bridge, which CSP does not see. Here the bridge
    // is `fetch` to this same server, so the policy is relaxed for the test document
    // only; the file on disk stays strict.
    .replaceAll("connect-src 'none'", "connect-src 'self'");
  const styles = await readFile(`${rendererDirectory}styles.css`, 'utf8');

  let state = initial;
  const calls: { method: string; argument: unknown }[] = [];

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, type: string, body: string): void => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(body);
    };
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (path === '/' || path === '/settings.html') return send(200, 'text/html; charset=utf-8', html);
      if (path === '/settingsPage.js') return send(200, 'text/javascript; charset=utf-8', script);
      if (path === '/bridge.js') return send(200, 'text/javascript; charset=utf-8', BRIDGE_SCRIPT);
      if (path === '/styles.css') return send(200, 'text/css; charset=utf-8', styles);
      if (path.startsWith('/bridge/')) {
        const method = path.slice('/bridge/'.length);
        const argument = await readBody(request);
        calls.push({ method, argument });
        // The scripted outcomes. What each one proves is in the spec that uses it.
        if (method === 'show') {
          const screen = (argument as { screen?: AdminState['screen'] } | null)?.screen ?? 'settings';
          state = {
            ...state,
            screen,
            notice: null,
            dashboard: screen === 'dashboard' ? dashboard() : state.dashboard,
            diagnostics: screen === 'diagnostics' ? diagnostics() : state.diagnostics,
          };
        }
        // An admin-only refusal arrives as its code, which the view turns into one
        // sentence. This is what a salesperson gets.
        if (method === 'saveSetting') {
          state = { ...state, notice: state.role === 'admin' ? null : 'admin_only' };
        }
        if (method === 'acknowledgeAlert') {
          state = {
            ...state,
            diagnostics: {
              ...diagnostics(),
              alerts: diagnostics().alerts.map(alert => ({ ...alert, acknowledgedAt: '2026-09-20T11:00:00.000Z' })),
            },
          };
        }
        return send(200, 'application/json', JSON.stringify(state));
      }
      return send(404, 'text/plain', 'not found');
    })().catch(() => {
      send(500, 'text/plain', 'test server failed');
    });
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}/`,
    calls,
    stop: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}
