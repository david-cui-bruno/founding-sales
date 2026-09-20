import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { TodayFirm, TodayState } from '../../../src/renderer/todayContract.ts';

/**
 * The generated test server the Today window specs run against.
 *
 * The same substitution G2 made for the sign-in window and G3b for the CRM window:
 * the renderer under test is the shipped file, transpiled with esbuild and served
 * unmodified, and the only thing replaced is the bridge — `window.callieToday`, which
 * in Electron comes from the preload script and here comes from a small generated
 * script that posts back to this server.
 *
 * The bridge is scripted rather than backed by the API. What these specs are for is
 * what a person sees and can press; the API's own behaviour is proved against a real
 * PostgreSQL in `@fss/domain` and `@fss/api`.
 *
 * No real business name, address or number appears here. `example.test` is reserved by
 * RFC 6761 and the numbers are in the NANP 555-01XX fictional block.
 */

const rendererDirectory = fileURLToPath(new URL('../../../src/renderer/', import.meta.url));

export const FIRM_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_FIRM_ID = '22222222-2222-4222-8222-222222222222';
export const MANUAL_ITEM_ID = '33333333-3333-4333-8333-333333333333';
export const AUTOMATED_ITEM_ID = '66666666-6666-4666-8666-666666666666';
export const ROUTE_ID = '44444444-4444-4444-8444-444444444444';
export const IDENTITY_ID = '55555555-5555-4555-8555-555555555555';

export interface TodayTestServer {
  readonly url: string;
  setState(state: TodayState): void;
  readonly calls: { readonly method: string; readonly argument: unknown }[];
  stop(): Promise<void>;
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

export function todayState(overrides: Partial<TodayState> = {}): TodayState {
  return {
    snapshotDate: '2026-09-21',
    businessTimeZone: 'America/New_York',
    cards: [
      {
        firmId: FIRM_ID,
        firmName: 'Northwind Test Holdings',
        lane: 'callback',
        dueAt: '2026-09-21T18:00:00.000Z',
        counts: { replies: 0, emailsDue: 3, callsDue: 1, linkedInDue: 1 },
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
    handoffNotice:
      'Once a call is handed to the phone app, Callie cannot recall it. A suppression recorded after that point applies to the next call, not this one.',
    ...overrides,
  };
}

/** The bridge the browser gets. The same seven methods the preload script exposes. */
const BRIDGE_SCRIPT = `
globalThis.callieToday = {
  async state() { return await ask('state'); },
  async refresh() { return await ask('refresh'); },
  async expand(input) { return await ask('expand', input); },
  async collapse() { return await ask('collapse'); },
  async snooze(input) { return await ask('snooze', input); },
  async dial(input) { return await ask('dial', input); },
  async recordOutcome(input) { return await ask('recordOutcome', input); },
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
    entryPoints: [`${rendererDirectory}todayPage.ts`],
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

export async function startTodayTestServer(initial: TodayState): Promise<TodayTestServer> {
  const script = await transpile();
  const html = (await readFile(`${rendererDirectory}today.html`, 'utf8'))
    .replace('<script type="module"', '<script src="./bridge.js"></script>\n    <script type="module"')
    // The shipped page has `connect-src 'none'` because the real renderer talks to
    // the main process across an IPC bridge, which CSP does not see. Here the bridge
    // is `fetch` to this same server, so the policy is relaxed to `'self'` for the
    // test document only; the file on disk stays strict.
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
      if (path === '/' || path === '/today.html') return send(200, 'text/html; charset=utf-8', html);
      if (path === '/todayPage.js') return send(200, 'text/javascript; charset=utf-8', script);
      if (path === '/bridge.js') return send(200, 'text/javascript; charset=utf-8', BRIDGE_SCRIPT);
      if (path === '/styles.css') return send(200, 'text/css; charset=utf-8', styles);
      if (path.startsWith('/bridge/')) {
        const method = path.slice('/bridge/'.length);
        const argument = await readBody(request);
        calls.push({ method, argument });
        // The scripted outcomes. What each one proves is in the spec that uses it.
        if (method === 'expand') {
          const firmId = (argument as { firmId?: string } | null)?.firmId;
          state = { ...state, expanded: firmId === FIRM_ID ? expandedFirm() : null, notice: null };
        }
        if (method === 'collapse') state = { ...state, expanded: null, notice: null };
        if (method === 'snooze') {
          const itemId = (argument as { itemId?: string } | null)?.itemId;
          // 8.2: the *server* decides which of the two a task gets, from its own
          // `automated` column. The window asked for the same thing both times.
          state = { ...state, notice: itemId === AUTOMATED_ITEM_ID ? 'held' : 'snoozed' };
        }
        if (method === 'dial') state = { ...state, notice: 'dial_opened' };
        if (method === 'recordOutcome') state = { ...state, notice: 'outcome_recorded' };
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
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${String(port)}/`,
    setState: next => {
      state = next;
    },
    calls,
    stop: async () => {
      await new Promise<void>(resolve => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
