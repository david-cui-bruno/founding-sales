import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { DesktopState, MailboxState } from '../../../src/shared/contract.ts';
import type { UpdateStatus } from '../../../src/shared/updateContract.ts';
import type { AdminState, CallingNumberView } from '../../../src/renderer/settingsContract.ts';
import type { TodayFirm, TodayState } from '../../../src/renderer/todayContract.ts';
import { adminState, dashboard, diagnostics, sendingPosture } from './settingsTestServer.ts';

/**
 * The generated test server Home's specs run against (lane g65).
 *
 * The same substitution every window's specs make: the renderer under test is the
 * shipped `renderer.ts` with `index.html` and `styles.css`, transpiled with esbuild and
 * served unmodified, and only the bridges are replaced. Home is the first page that
 * reads four of them, so this server stands in for all four — `callie`, `callieMailbox`,
 * `callieToday` and `callieAdmin` — each as a small generated script that posts back
 * here, and any of the last three can be left out to see the page degrade.
 *
 * The scripted answers are the ones G6's Today window specs used, so the lanes are
 * driven through exactly the scenarios that window was: scenario 33's five people at one
 * firm, the snooze that comes back a hold, the one usable route, the outcome form.
 *
 * No real business name, address or number appears here. `example.test` is reserved by
 * RFC 6761 and the numbers are in the NANP 555-01XX fictional block.
 */

const rendererDirectory = fileURLToPath(new URL('../../../src/renderer/', import.meta.url));

export const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
export const FIRM_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_FIRM_ID = '22222222-2222-4222-8222-222222222222';
export const REPLY_FIRM_ID = '77777777-7777-4777-8777-000000000001';
export const DUE_FIRM_ID = '77777777-7777-4777-8777-000000000002';
export const MANUAL_ITEM_ID = '33333333-3333-4333-8333-333333333333';
export const AUTOMATED_ITEM_ID = '66666666-6666-4666-8666-666666666666';
export const ROUTE_ID = '44444444-4444-4444-8444-444444444444';
export const IDENTITY_ID = '55555555-5555-4555-8555-555555555555';
export const MAILBOX_ADDRESS = 'sales@example.test';

/** Signed in, online, a supported version, and the cached list the session holds. */
export function desktopState(overrides: Partial<DesktopState> = {}): DesktopState {
  return {
    screen: 'today',
    clientVersion: '1.0.3',
    supportedClientVersions: { minimum: '1.0.0', maximum: '1.0.3' },
    device: {
      deviceId: '33333333-3333-4333-8333-333333333333',
      deviceLabel: "David's MacBook",
      workspaceId: WORKSPACE_ID,
      role: 'admin',
      registeredAt: '2026-09-21T09:00:00.000Z',
    },
    online: true,
    stale: false,
    asOf: '2026-09-21T13:00:00.000Z',
    mayMutate: true,
    notice: null,
    today: {
      workspaceId: WORKSPACE_ID,
      snapshotDate: '2026-09-21',
      businessTimeZone: 'America/New_York',
      cards: todayState().cards.map(card => ({ ...card })),
    },
    ...overrides,
  };
}

/** Scenario 33's Today half: five people at one firm, and one card for them. */
export function expandedFirm(overrides: Partial<TodayFirm> = {}): TodayFirm {
  return {
    firmId: FIRM_ID,
    firmName: 'Northwind Test Holdings',
    snapshotDate: '2026-09-21',
    lane: 'callback',
    counts: { replies: 0, emailsDue: 3, callsDue: 1, linkedInDue: 1 },
    tasks: [
      {
        itemId: '77777777-7777-4777-8777-777777777777',
        contactId: '88888888-8888-4888-8888-888888888888',
        contactName: 'Dana Example',
        kind: 'callback',
        lane: 'callback',
        dueAt: '2026-09-21T18:00:00.000Z',
        status: 'open',
        automated: false,
        snoozeUntil: null,
      },
      {
        itemId: MANUAL_ITEM_ID,
        contactId: '99999999-9999-4999-8999-999999999999',
        contactName: 'Robin Placeholder',
        kind: 'call_due',
        lane: 'due_work',
        dueAt: '2026-09-21T13:00:00.000Z',
        status: 'open',
        automated: false,
        snoozeUntil: null,
      },
      {
        itemId: AUTOMATED_ITEM_ID,
        contactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        contactName: 'Alex Placeholder',
        kind: 'email_due',
        lane: 'due_work',
        dueAt: '2026-09-21T14:00:00.000Z',
        status: 'open',
        automated: true,
        snoozeUntil: null,
      },
      {
        itemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        contactId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        contactName: 'Bailey Placeholder',
        kind: 'email_due',
        lane: 'due_work',
        dueAt: '2026-09-21T15:00:00.000Z',
        status: 'snoozed',
        automated: false,
        snoozeUntil: '2026-09-24T13:00:00.000Z',
      },
      {
        itemId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        contactId: null,
        contactName: null,
        kind: 'linkedin_due',
        lane: 'due_work',
        dueAt: '2026-09-21T16:00:00.000Z',
        status: 'open',
        automated: false,
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

/**
 * Four firms, one per lane, in the order the snapshot put them. The new firm's instant
 * is three weeks earlier than every other and it is still last: the lane decides, and
 * the page never re-sorts what the snapshot ordered.
 */
export function todayState(overrides: Partial<TodayState> = {}): TodayState {
  return {
    snapshotDate: '2026-09-21',
    businessTimeZone: 'America/New_York',
    cards: [
      {
        firmId: REPLY_FIRM_ID,
        firmName: 'Ashgrove Test Partners',
        lane: 'reply',
        dueAt: '2026-09-21T11:42:00.000Z',
        counts: { replies: 1, emailsDue: 0, callsDue: 0, linkedInDue: 0 },
      },
      {
        firmId: FIRM_ID,
        firmName: 'Northwind Test Holdings',
        lane: 'callback',
        dueAt: '2026-09-21T18:00:00.000Z',
        counts: { replies: 0, emailsDue: 3, callsDue: 1, linkedInDue: 1 },
      },
      {
        firmId: DUE_FIRM_ID,
        firmName: 'Copperline Test Holdings',
        lane: 'due_work',
        dueAt: '2026-09-21T13:00:00.000Z',
        counts: { replies: 0, emailsDue: 1, callsDue: 0, linkedInDue: 0 },
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
    role: 'admin',
    notice: null,
    handoffNotice:
      'Once a call is handed to the phone app, Callie cannot recall it. A suppression recorded after that point applies to the next call, not this one.',
    ...overrides,
  };
}

export function connectedMailbox(overrides: Partial<MailboxState> = {}): MailboxState {
  return {
    status: { connected: true, mailbox: { emailAddress: MAILBOX_ADDRESS, status: 'connected', syncState: 'ready' } },
    connecting: false,
    mayConnect: true,
    notice: null,
    ...overrides,
  };
}

export function notConnectedMailbox(overrides: Partial<MailboxState> = {}): MailboxState {
  return { status: { connected: false, mailbox: null }, connecting: false, mayConnect: true, notice: null, ...overrides };
}

/** The number Today calls from: verified, enabled, and chosen by the server. */
export function callingNumber(overrides: Partial<CallingNumberView> = {}): CallingNumberView {
  return {
    id: IDENTITY_ID,
    e164: '+16175550100',
    label: 'Mobile',
    verificationStatus: 'verified',
    enabled: true,
    verifiedAt: '2026-09-25T12:00:00.000Z',
    verificationMethod: 'owner_attestation',
    disabledAt: null,
    usedForCalls: true,
    ...overrides,
  };
}

/**
 * Everything in order: an admin with a calling number, a domain whose checklist passes,
 * and no alert open. Each spec takes one thing away.
 */
export function readyAdmin(overrides: Partial<AdminState> = {}): AdminState {
  const posture = sendingPosture();
  return adminState({
    callingNumbers: [callingNumber()],
    sendingAdmin: {
      ...posture,
      domain: posture.domain === null ? null : { ...posture.domain, dmarcPass: true, postmasterReviewedAt: '2026-09-24T12:00:00.000Z', authenticationPasses: true },
    },
    ...overrides,
  });
}

export { dashboard, diagnostics, sendingPosture };

export type Bridge = 'callieMailbox' | 'callieToday' | 'callieAdmin';

export interface HomeServerOptions {
  readonly desktop?: DesktopState;
  readonly mailbox?: MailboxState;
  readonly today?: TodayState;
  readonly admin?: AdminState;
  /** Bridges the page is built without, as a page without the preload would be. */
  readonly without?: readonly Bridge[];
  /** `loadDashboard` answers with no figures for the window asked, as a refused read does. */
  readonly figuresFail?: boolean;
  /** Lane g83: install `callieUpdate`, answering this state. Absent: the page has no update bridge. */
  readonly update?: UpdateStatus;
}

export interface HomeTestServer {
  readonly url: string;
  /** `bridge.method` in call order, with its argument. */
  readonly calls: { readonly method: string; readonly argument: unknown }[];
  /** Lane g83: what `callieUpdate.state` answers from now on. The page hears of it on `onChange`. */
  setUpdate(status: UpdateStatus): void;
  stop(): Promise<void>;
}

const BRIDGES: Readonly<Record<'callie' | Bridge, string>> = {
  callie: `
globalThis.callie = {
  async state() { return await ask('callie.state'); },
  async signIn(input) { return await ask('callie.signIn', input); },
  async signOut() { return await ask('callie.signOut'); },
  async refreshToday() { return await ask('callie.refreshToday'); },
  async openWindow(input) { return await ask('callie.openWindow', input); },
};`,
  callieMailbox: `
globalThis.callieMailbox = {
  async state() { return await ask('mailbox.state'); },
  async refresh() { return await ask('mailbox.refresh'); },
  async connect() { return await ask('mailbox.connect'); },
};`,
  callieToday: `
globalThis.callieToday = {
  async state() { return await ask('today.state'); },
  async refresh() { return await ask('today.refresh'); },
  async expand(input) { return await ask('today.expand', input); },
  async collapse() { return await ask('today.collapse'); },
  async snooze(input) { return await ask('today.snooze', input); },
  async dial(input) { return await ask('today.dial', input); },
  async recordOutcome(input) { return await ask('today.recordOutcome', input); },
  async scheduleCallback(input) { return await ask('today.scheduleCallback', input); },
  async releasePause(input) { return await ask('today.releasePause', input); },
};`,
  callieAdmin: `
globalThis.callieAdmin = {
  async state() { return await ask('admin.state'); },
  async show(input) { return await ask('admin.show', input); },
  async loadDashboard(input) { return await ask('admin.loadDashboard', input); },
};`,
};

// Lane g83. `onChange` keeps the page's listener where a spec can call it, which is what
// the main process's ping does in the real app.
const UPDATE_BRIDGE = `
globalThis.callieUpdate = {
  async state() { return await ask('update.state'); },
  async restart() { return await ask('update.restart'); },
  onChange(listener) { (globalThis.__updateListeners ??= []).push(listener); },
};`;

const ASK = `
async function ask(method, argument) {
  const response = await fetch('/bridge/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(argument ?? null),
  });
  return await response.json();
}`;

async function transpile(): Promise<string> {
  const bundle = await build({
    entryPoints: [`${rendererDirectory}renderer.ts`],
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

export async function startHomeTestServer(options: HomeServerOptions = {}): Promise<HomeTestServer> {
  const script = await transpile();
  const without = new Set(options.without ?? []);
  const bridgeScript = [
    BRIDGES.callie,
    ...(['callieMailbox', 'callieToday', 'callieAdmin'] as const).filter(name => !without.has(name)).map(name => BRIDGES[name]),
    ...(options.update === undefined ? [] : [UPDATE_BRIDGE]),
    ASK,
  ].join('\n');
  const html = (await readFile(`${rendererDirectory}index.html`, 'utf8'))
    .replace('<script type="module"', '<script src="./bridge.js"></script>\n    <script type="module"')
    // The shipped page has `connect-src 'none'` because the real renderer talks to the
    // main process across an IPC bridge, which CSP does not see. Here the bridges are
    // `fetch` to this same server, so the policy is relaxed to `'self'` for the test
    // document only; the file on disk stays strict.
    .replaceAll("connect-src 'none'", "connect-src 'self'");
  const styles = await readFile(`${rendererDirectory}styles.css`, 'utf8');

  let desktop = options.desktop ?? desktopState();
  let mailbox = options.mailbox ?? connectedMailbox();
  let today = options.today ?? todayState();
  let admin = options.admin ?? readyAdmin();
  let update: UpdateStatus = options.update ?? { kind: 'none' };
  const calls: { method: string; argument: unknown }[] = [];

  const answer = (method: string, argument: unknown): unknown => {
    const [bridge] = method.split('.');
    if (bridge === 'callie') return desktop;
    if (bridge === 'update') {
      // The real main process installs and relaunches; the page sees the install begin.
      if (method === 'update.restart' && update.kind === 'ready') update = { kind: 'installing', version: update.version };
      return update;
    }
    if (bridge === 'mailbox') {
      // The real main process holds `connect` open while the browser has the person;
      // here the grant lands at once, which is all a spec of the window can see.
      if (method === 'mailbox.connect') mailbox = connectedMailbox();
      return mailbox;
    }
    if (bridge === 'today') {
      // The scripted outcomes G6's specs used. What each proves is in the spec.
      if (method === 'today.expand') {
        const firmId = (argument as { firmId?: string } | null)?.firmId;
        today = { ...today, expanded: firmId === FIRM_ID ? expandedFirm() : null, notice: null };
      }
      if (method === 'today.collapse') today = { ...today, expanded: null, notice: null };
      if (method === 'today.snooze') {
        const itemId = (argument as { itemId?: string } | null)?.itemId;
        // 8.2: the *server* decides which of the two a task gets, from its own
        // `automated` column. The page asked for the same thing both times.
        today = { ...today, notice: itemId === AUTOMATED_ITEM_ID ? 'held' : 'snoozed' };
      }
      if (method === 'today.dial') today = { ...today, notice: 'dial_opened' };
      if (method === 'today.recordOutcome') {
        // Lane g79: a callback request with no day comes back recorded with its
        // follow-up, as the real bridge reports the server's `followUps`.
        const input = argument as { outcome?: string; callback?: unknown } | null;
        const needsTime = input?.outcome === 'callback_requested' && input.callback === null;
        today = { ...today, notice: needsTime ? 'outcome_recorded_callback_time_needed' : 'outcome_recorded' };
      }
      if (method === 'today.scheduleCallback') today = { ...today, notice: 'callback_scheduled' };
      if (method === 'today.releasePause') today = { ...today, notice: 'pause_released' };
      return today;
    }
    if (method === 'admin.loadDashboard') {
      // The real bridge echoes the window it was asked for in the answer's own
      // `window`. A failed read keeps whatever figures it held before, which is why
      // the page checks the window rather than the presence of figures.
      const window = argument as { from: string; to: string };
      admin = options.figuresFail === true
        ? { ...admin, notice: 'offline', dashboard: { ...dashboard() } }
        : { ...admin, notice: null, dashboard: { ...dashboard(), window } };
      return admin;
    }
    return admin;
  };

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, type: string, body: string): void => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(body);
    };
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (path === '/' || path === '/index.html') return send(200, 'text/html; charset=utf-8', html);
      if (path === '/renderer.js') return send(200, 'text/javascript; charset=utf-8', script);
      if (path === '/bridge.js') return send(200, 'text/javascript; charset=utf-8', bridgeScript);
      if (path === '/styles.css') return send(200, 'text/css; charset=utf-8', styles);
      if (path.startsWith('/bridge/')) {
        const method = path.slice('/bridge/'.length);
        const argument = await readBody(request);
        calls.push({ method, argument });
        if (method === 'callie.signOut') desktop = { ...desktop, screen: 'sign_in', device: null, today: null, notice: 'signed_out' };
        return send(200, 'application/json', JSON.stringify(answer(method, argument)));
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
    setUpdate: status => {
      update = status;
    },
    stop: async () => {
      // The page holds a keep-alive socket after its last request; closing the sockets
      // first is what lets the next spec file start (see `testServer.ts`).
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
