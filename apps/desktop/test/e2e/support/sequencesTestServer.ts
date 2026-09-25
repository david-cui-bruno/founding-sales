import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { SequenceState } from '../../../src/renderer/sequenceContract.ts';
import { EMPTY_SEQUENCE_STATE } from '../../../src/renderer/sequenceView.ts';
import {
  SEQUENCE_IDS,
  emailStepAnswer,
  enrollmentAnswer,
  linkedInStepAnswer,
  sequenceSummaryAnswer,
  sequenceVersionAnswer,
  templateVersionAnswer,
} from '../../support/sequenceAnswers.ts';

/**
 * The generated test server the sequence editor specs run against (lane g78).
 *
 * The same substitution G2 made for the sign-in window and every window since: the
 * renderer under test is the shipped file, transpiled with esbuild and served
 * unmodified, and the only thing replaced is the bridge — `window.callieSequences`,
 * which in Electron comes from the preload script and here comes from a small
 * generated script that posts back to this server.
 *
 * The states are built from `../../support/sequenceAnswers.ts`, the fixtures the
 * release suite holds to the real routes, so a version drawn here has the steps the API
 * actually sends. What the page does with a failed read is scripted: the first `state`
 * answers with the reads that failed, and the next answers with them read, which is
 * what Retry is for.
 *
 * No real person, firm or profile appears. `example.test` is reserved by RFC 6761.
 */

const rendererDirectory = fileURLToPath(new URL('../../../src/renderer/', import.meta.url));

export interface SequencesTestServer {
  readonly url: string;
  readonly calls: { readonly method: string; readonly argument: unknown }[];
  stop(): Promise<void>;
}

/** A populated window: one published version with both kinds of step, and one enrollment held for review. */
export function populatedSequenceState(overrides: Partial<SequenceState> = {}): SequenceState {
  return {
    ...EMPTY_SEQUENCE_STATE,
    online: true,
    mayMutate: true,
    isAdmin: true,
    asOf: '2026-09-21T13:00:00.000Z',
    sequences: [sequenceSummaryAnswer()],
    selectedSequenceId: SEQUENCE_IDS.sequence,
    versions: [
      sequenceVersionAnswer([emailStepAnswer(SEQUENCE_IDS.template), linkedInStepAnswer()], {
        version: 1,
        state: 'published',
        publishedAt: '2026-09-20T12:00:00.000Z',
      }),
    ],
    templates: [templateVersionAnswer()],
    heldEnrollments: [enrollmentAnswer({ state: 'review_required', reviewUnionMilliseconds: 9 * 86_400_000 })],
    ...overrides,
  };
}

/** The same window with three of its four reads failed, as the bridge reports them. */
export function unreadSequenceState(): SequenceState {
  return populatedSequenceState({
    versions: [],
    templates: [],
    heldEnrollments: [],
    asOf: null,
    readErrors: { sequences: null, versions: 'unreadable_answer', templates: 'service_unavailable', enrollments: 'offline' },
  });
}

/** The bridge the browser gets. The same twelve methods the preload script exposes. */
const BRIDGE_SCRIPT = `
globalThis.callieSequences = {
  async state() { return await ask('state'); },
  async openSequence(input) { return await ask('openSequence', input); },
  async createSequence(input) { return await ask('createSequence', input); },
  async saveDraft(input) { return await ask('saveDraft', input); },
  async publish(input) { return await ask('publish', input); },
  async retire(input) { return await ask('retire', input); },
  async approveTemplate(input) { return await ask('approveTemplate', input); },
  async enroll(input) { return await ask('enroll', input); },
  async completeLinkedIn(input) { return await ask('completeLinkedIn', input); },
  async undoLinkedIn(input) { return await ask('undoLinkedIn', input); },
  async recordLinkedInResult(input) { return await ask('recordLinkedInResult', input); },
  async resumeEnrollment(input) { return await ask('resumeEnrollment', input); },
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
    entryPoints: [`${rendererDirectory}sequenceEditor.ts`],
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

/**
 * `answers` is the sequence of states `state()` returns, one per call; the last one
 * repeats. Every other method answers the current state.
 */
export async function startSequencesTestServer(answers: readonly SequenceState[]): Promise<SequencesTestServer> {
  const script = await transpile();
  const html = (await readFile(`${rendererDirectory}sequenceEditor.html`, 'utf8'))
    .replace('<script type="module"', '<script src="./bridge.js"></script>\n    <script type="module"')
    // The shipped page has `connect-src 'none'` because the real renderer talks to the
    // main process across an IPC bridge, which CSP does not see. Here the bridge is
    // `fetch` to this same server, so the policy is relaxed for the test document only.
    .replaceAll("connect-src 'none'", "connect-src 'self'");
  const styles = await readFile(`${rendererDirectory}styles.css`, 'utf8');

  let served = 0;
  let state = answers[0] ?? EMPTY_SEQUENCE_STATE;
  const calls: { method: string; argument: unknown }[] = [];

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, type: string, body: string): void => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(body);
    };
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (path === '/' || path === '/sequenceEditor.html') return send(200, 'text/html; charset=utf-8', html);
      if (path === '/sequenceEditor.js') return send(200, 'text/javascript; charset=utf-8', script);
      if (path === '/bridge.js') return send(200, 'text/javascript; charset=utf-8', BRIDGE_SCRIPT);
      if (path === '/styles.css') return send(200, 'text/css; charset=utf-8', styles);
      if (path.startsWith('/bridge/')) {
        const method = path.slice('/bridge/'.length);
        const argument = await readBody(request);
        calls.push({ method, argument });
        if (method === 'state') {
          state = answers[Math.min(served, answers.length - 1)] ?? state;
          served += 1;
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
      server.closeAllConnections();
      await new Promise<void>(resolve => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
