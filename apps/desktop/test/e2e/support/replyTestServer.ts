import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { ReplyCard, ReplyState } from '../../../src/renderer/replyContract.ts';

/**
 * The generated test server the reply window specs run against.
 *
 * The same substitution G2 made for the sign-in window, G3b for the CRM window and G6
 * for Today: the renderer under test is the shipped file, transpiled with esbuild and
 * served unmodified, and the only thing replaced is the bridge — `window.callieReplies`,
 * which in Electron comes from the preload script and here comes from a small
 * generated script that posts back to this server.
 *
 * What these specs are for is what a person sees and can press. The rules behind it
 * are proved against a real PostgreSQL in `@fss/domain/classification`.
 *
 * No real person, firm or address appears. `example.test` is reserved by RFC 6761.
 */

const rendererDirectory = fileURLToPath(new URL('../../../src/renderer/', import.meta.url));

export const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_MESSAGE_ID = '22222222-2222-4222-8222-222222222222';
export const FIRM_ID = '33333333-3333-4333-8333-333333333333';
export const OPPORTUNITY_ID = '55555555-5555-4555-8555-555555555555';
const HOLD_ID = '88888888-8888-4888-8888-888888888888';

export interface ReplyTestServer {
  readonly url: string;
  readonly calls: { readonly method: string; readonly argument: unknown }[];
  stop(): Promise<void>;
}

export function replyCard(overrides: Partial<ReplyCard> = {}): ReplyCard {
  return {
    messageId: MESSAGE_ID,
    receivedAt: '2026-09-21T13:00:00.000Z',
    from: 'reception@northwind.example.test',
    subject: 'Re: introduction',
    body: { text: 'Tuesday works. Send an invite.', truncated: false },
    firmId: FIRM_ID,
    firmName: 'Northwind Test Holdings',
    opportunityId: OPPORTUNITY_ID,
    contactId: null,
    contactName: 'Dana Example',
    contactTitle: 'Operations',
    impact: {
      controlMode: 'automated',
      holds: [
        {
          holdId: HOLD_ID,
          opportunityId: OPPORTUNITY_ID,
          reasonCode: 'uncertain_reply',
          blockedActionKinds: ['email'],
          recoveryAction: 'confirm_disposition',
          recoverable: true,
          startedAt: '2026-09-21T13:00:05.000Z',
        },
      ],
      ambiguous: false,
      candidates: [
        { opportunityId: OPPORTUNITY_ID, firmId: FIRM_ID, firmName: 'Northwind Test Holdings', selected: true },
      ],
      contactsAtFirm: 3,
    },
    deterministicClass: 'uncertain',
    signals: [{ rule: 'question_mark', evidence: 'ends with a question', layer: 'deterministic' }],
    proposedDisposition: 'interested',
    proposedBy: 'model',
    confidence: 0.88,
    supportingExcerpt: 'Tuesday works.',
    callbackProposal: null,
    modelName: 'claude-opus-5',
    promptVersion: 'g7b.replies.1',
    requiresConfirmation: true,
    confirmation: null,
    nextAction: 'confirm_disposition',
    visibility: 'assigned_or_admin',
    ...overrides,
  };
}

export function replyState(overrides: Partial<ReplyState> = {}): ReplyState {
  return {
    businessDate: '2026-09-21',
    businessTimeZone: 'America/New_York',
    cards: [replyCard()],
    open: null,
    online: true,
    mayMutate: true,
    classifier: { enabled: true, modelName: 'claude-opus-5', effort: 'low' },
    notice: null,
    ...overrides,
  };
}

/** The bridge the browser gets. The same five methods the preload script exposes. */
const BRIDGE_SCRIPT = `
globalThis.callieReplies = {
  async state() { return await ask('state'); },
  async refresh() { return await ask('refresh'); },
  async open(input) { return await ask('open', input); },
  async collapse() { return await ask('collapse'); },
  async confirm(input) { return await ask('confirm', input); },
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
    entryPoints: [`${rendererDirectory}replyPage.ts`],
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

export async function startReplyTestServer(initial: ReplyState): Promise<ReplyTestServer> {
  const script = await transpile();
  const html = (await readFile(`${rendererDirectory}replyCard.html`, 'utf8'))
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
      if (path === '/' || path === '/replyCard.html') return send(200, 'text/html; charset=utf-8', html);
      if (path === '/replyPage.js') return send(200, 'text/javascript; charset=utf-8', script);
      if (path === '/bridge.js') return send(200, 'text/javascript; charset=utf-8', BRIDGE_SCRIPT);
      if (path === '/styles.css') return send(200, 'text/css; charset=utf-8', styles);
      if (path.startsWith('/bridge/')) {
        const method = path.slice('/bridge/'.length);
        const argument = await readBody(request);
        calls.push({ method, argument });
        if (method === 'open') {
          const messageId = (argument as { messageId?: string } | null)?.messageId;
          state = {
            ...state,
            open: state.cards.find(card => card.messageId === messageId) ?? null,
            notice: null,
          };
        }
        if (method === 'collapse') state = { ...state, open: null, notice: null };
        if (method === 'confirm') {
          // The server decides what a confirmation meant. The window asked the same
          // way for all six dispositions and is told which notice to show.
          const disposition = (argument as { disposition?: string } | null)?.disposition;
          state = {
            ...state,
            open: null,
            notice: disposition === 'not_interested' ? 'suggests_lost' : 'confirmed',
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
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${String(port)}/`,
    calls,
    stop: async () => {
      // `close` waits for every socket to go idle, and a page Playwright has not torn
      // down yet holds a keep-alive connection open until the suite's timeout. The
      // sockets belong to a browser that is about to be closed anyway.
      server.closeAllConnections();
      await new Promise<void>(resolve => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
