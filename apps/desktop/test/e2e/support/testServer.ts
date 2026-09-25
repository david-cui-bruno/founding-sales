import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { DesktopState, MailboxState } from '../../../src/shared/contract.ts';

/**
 * The generated test server the Playwright specs run against.
 *
 * It does three things: transpile the real renderer with esbuild and serve it, serve
 * the real `index.html` and stylesheet, and stand in for the bridge the preload
 * script normally provides. The renderer under test is the shipped file, unmodified —
 * the only substitution is the bridge, which in Electron is `window.callie` from the
 * preload and here is `window.callie` from a tiny script this server generates.
 *
 * That substitution is what makes an Electron download unnecessary for these specs.
 * The host integrations that genuinely need Electron and macOS — the Keychain, `tel:`
 * handoff, signing, notarization and update verification — are specification 16.1's
 * macOS-runner job and are not claimed here.
 */

const rendererDirectory = fileURLToPath(new URL('../../../src/renderer/', import.meta.url));

export interface TestServer {
  readonly url: string;
  /** Replace the state the bridge answers with, for the next page load or call. */
  setState(state: DesktopState): void;
  /** What the Mailbox row's bridge answers `connect` with. Connected, unless a test says otherwise. */
  setConnectAnswer(state: MailboxState): void;
  readonly calls: string[];
  stop(): Promise<void>;
}

export const EXAMPLE_WORKSPACE = '11111111-1111-4111-8111-111111111111';
export const EXAMPLE_USER = '22222222-2222-4222-8222-222222222222';
export const EXAMPLE_DEVICE = '33333333-3333-4333-8333-333333333333';

export function signedOutState(overrides: Partial<DesktopState> = {}): DesktopState {
  return {
    screen: 'sign_in',
    clientVersion: '1.4.0',
    supportedClientVersions: { minimum: '1.2.0', maximum: '1.4.0' },
    device: null,
    online: true,
    stale: false,
    asOf: null,
    mayMutate: false,
    notice: null,
    today: null,
    ...overrides,
  };
}

export function signedInState(overrides: Partial<DesktopState> = {}): DesktopState {
  return {
    ...signedOutState(),
    screen: 'today',
    device: {
      deviceId: EXAMPLE_DEVICE,
      deviceLabel: "David's MacBook",
      workspaceId: EXAMPLE_WORKSPACE,
      role: 'salesperson',
      registeredAt: '2026-09-21T09:00:00.000Z',
    },
    mayMutate: true,
    asOf: '2026-09-21T09:05:00.000Z',
    today: {
      workspaceId: EXAMPLE_WORKSPACE,
      snapshotDate: '2026-09-21',
      businessTimeZone: 'America/New_York',
      cards: [
        {
          firmId: randomUUID(),
          firmName: 'Ash & Partners',
          lane: 'reply',
          dueAt: '2026-09-21T13:00:00.000Z',
          counts: { replies: 1, emailsDue: 0, callsDue: 0, linkedInDue: 0 },
        },
      ],
    },
    ...overrides,
  };
}

export const EXAMPLE_MAILBOX_ADDRESS = 'sales@example.test';

/** The Mailbox row before anything is connected: what `/gmail/status` says for a new user. */
export function notConnectedMailbox(overrides: Partial<MailboxState> = {}): MailboxState {
  return { status: { connected: false, mailbox: null }, connecting: false, mayConnect: true, notice: null, ...overrides };
}

/** What the main process answers once the grant has landed and the baseline has started. */
export function connectedMailbox(overrides: Partial<MailboxState> = {}): MailboxState {
  return {
    status: {
      connected: true,
      mailbox: { emailAddress: EXAMPLE_MAILBOX_ADDRESS, status: 'connected', syncState: 'baseline_pending' },
    },
    connecting: false,
    mayConnect: true,
    notice: null,
    ...overrides,
  };
}

/**
 * The bridges the browser gets: the same five methods `callie` has in the preload
 * script, and the Mailbox row's three on `callieMailbox`. Nothing else: this page is
 * built without `callieToday` and `callieAdmin`, so Home says so where they would be
 * (`homeTestServer.ts` installs all four for `home.spec.ts`).
 */
const BRIDGE_SCRIPT = `
globalThis.callie = {
  async state() { return await ask('state'); },
  async signIn(input) { return await ask('signIn', input); },
  async signOut() { return await ask('signOut'); },
  async refreshToday() { return await ask('refreshToday'); },
  async openWindow(input) { return await ask('openWindow', input); },
};
globalThis.callieMailbox = {
  async state() { return await ask('mailboxState'); },
  async refresh() { return await ask('mailboxRefresh'); },
  async connect() { return await ask('mailboxConnect'); },
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

async function transpileRenderer(): Promise<string> {
  const bundle = await build({
    entryPoints: [`${rendererDirectory}renderer.ts`],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    write: false,
    // The contract file imports zod, which is bundled in; nothing else is external.
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

export async function startTestServer(
  initial: DesktopState,
  initialMailbox: MailboxState = notConnectedMailbox(),
): Promise<TestServer> {
  const rendererScript = await transpileRenderer();
  const html = (await readFile(`${rendererDirectory}index.html`, 'utf8'))
    // The generated bridge is a second local script; the page's own policy allows it.
    .replace('<script type="module"', '<script src="./bridge.js"></script>\n    <script type="module"')
    // The shipped page has `connect-src 'none'` because the real renderer never talks
    // to the network — it talks to the main process across an IPC bridge, which CSP
    // does not see. Here the bridge is `fetch` to this same server, so the policy is
    // relaxed to `'self'` for the test document only. The file on disk stays strict,
    // and the specs below still prove nothing off-origin is ever loaded.
    // `replaceAll`: the phrase appears in the page's own comment as well as in the
    // policy, and replacing only the first would edit the comment and nothing else.
    .replaceAll("connect-src 'none'", "connect-src 'self'");
  const styles = await readFile(`${rendererDirectory}styles.css`, 'utf8');

  let state = initial;
  let mailbox = initialMailbox;
  let connectAnswer = connectedMailbox();
  const calls: string[] = [];

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, type: string, body: string): void => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(body);
    };
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (path === '/' || path === '/index.html') return send(200, 'text/html; charset=utf-8', html);
      if (path === '/renderer.js') return send(200, 'text/javascript; charset=utf-8', rendererScript);
      if (path === '/bridge.js') return send(200, 'text/javascript; charset=utf-8', BRIDGE_SCRIPT);
      if (path === '/styles.css') return send(200, 'text/css; charset=utf-8', styles);
      if (path.startsWith('/bridge/')) {
        const method = path.slice('/bridge/'.length);
        calls.push(method);
        await readBody(request);
        if (method === 'signIn') state = signedInState();
        if (method === 'signOut') state = signedOutState({ notice: 'signed_out' });
        if (method.startsWith('mailbox')) {
          // The real main process holds `connect` open while the browser has the person;
          // here the grant lands at once, which is all a spec of the window can see.
          if (method === 'mailboxConnect') mailbox = connectAnswer;
          return send(200, 'application/json', JSON.stringify(mailbox));
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
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(address.port)}/`,
    calls,
    setState: value => {
      state = value;
    },
    setConnectAnswer: value => {
      connectAnswer = value;
    },
    stop: async () => {
      // `close` waits for every open connection, and the page holds a keep-alive
      // socket after its last request. With one spec file the process exited before
      // anybody noticed; with two, the second file's first test waits behind the
      // first file's `afterEach` and the run times out. Closing the sockets first is
      // the whole fix, and `crmTestServer.ts` does the same.
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
