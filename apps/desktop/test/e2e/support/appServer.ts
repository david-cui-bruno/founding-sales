import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { DesktopState, MailboxState } from '../../../src/shared/contract.ts';
import type { UpdateStatus } from '../../../src/shared/updateContract.ts';
import type { CrmState } from '../../../src/renderer/firmWorkspaceContract.ts';
import type { ReplyState } from '../../../src/renderer/replyContract.ts';
import type { SequenceState } from '../../../src/renderer/sequenceContract.ts';
import type { AdminState } from '../../../src/renderer/settingsContract.ts';
import type { TodayState } from '../../../src/renderer/todayContract.ts';
import { EMPTY_SEQUENCE_STATE } from '../../../src/renderer/sequenceView.ts';
import { adminAnswer, adminState } from './adminFixtures.ts';
import { crmAnswer, crmState } from './crmFixtures.ts';
import { connectedMailbox, desktopState, readyAdmin, todayAnswer, todayState } from './homeFixtures.ts';
import { replyAnswer, replyState } from './replyFixtures.ts';
import { signedInState, signedOutState } from './sessionFixtures.ts';

/**
 * The one test server every window spec runs against (wave 1).
 *
 * There is one window, so there is one harness: the shipped `index.html`, `styles.css`
 * and `renderer.ts` — which holds the shell and every view — transpiled with esbuild and
 * served unmodified. Only the eight bridges the preload script installs are replaced,
 * each by a small generated object that posts back here, where a scripted fake answers
 * it. A spec goes to a view by loading `url('#firms')`, by pressing the sidebar, or by
 * `navigateByMenu(page, 'firms')`, which is what the Window menu's `callie:navigate` does.
 *
 * Until wave 1 there were six of these, one per window, each with its own copy of the
 * page, the bridge script and the server.
 *
 * No real business name, address or number appears in the fixtures. `example.test` is
 * reserved by RFC 6761 and the numbers are in the NANP 555-01XX fictional block.
 */

const rendererDirectory = fileURLToPath(new URL('../../../src/renderer/', import.meta.url));

export interface Call {
  readonly method: string;
  readonly argument: unknown;
}

/** A bridge, as a spec sees it: its calls (method names without the bridge's prefix) and its state. */
export interface BridgeHandle<S> {
  readonly calls: readonly Call[];
  state(): S;
  setState(state: S): void;
}

type Optional = 'callieMailbox' | 'callieToday' | 'callieAdmin' | 'callieCrm' | 'callieReplies' | 'callieSequences';

export interface AppServerOptions {
  readonly desktop?: DesktopState;
  readonly mailbox?: MailboxState;
  /** What `callieMailbox.connect` answers; connected by default. */
  readonly connectAnswer?: MailboxState;
  readonly today?: TodayState;
  /** What `today.refresh` answers, given the list held and which read this is (1 for the first). */
  readonly onRefresh?: (today: TodayState, count: number) => TodayState;
  readonly admin?: AdminState;
  /** `loadDashboard` answers with no figures for the window asked, as a refused read does. */
  readonly figuresFail?: boolean;
  readonly crm?: CrmState;
  readonly replies?: ReplyState;
  /** What each `sequences.state` answers, one per call; the last repeats. */
  readonly sequences?: readonly SequenceState[];
  /** The state a sequences method moves the window to, by method name. */
  readonly sequencesScripted?: Readonly<Partial<Record<string, SequenceState>>>;
  /** Install `callieUpdate`, answering this. Absent: the page has no update bridge. */
  readonly update?: UpdateStatus;
  /** Bridges the page is built without, as a page without the preload would be. */
  readonly without?: readonly Optional[];
}

export interface AppServer {
  /** The page, optionally loaded straight onto a route: `url('#firm/<id>')`. */
  url(hash?: string): string;
  /** Every bridge call in order, as `bridge.method`. */
  readonly calls: readonly Call[];
  called(method: string): unknown[];
  readonly desktop: BridgeHandle<DesktopState>;
  readonly mailbox: BridgeHandle<MailboxState> & { setConnectAnswer(state: MailboxState): void };
  readonly today: BridgeHandle<TodayState>;
  readonly admin: BridgeHandle<AdminState>;
  readonly crm: BridgeHandle<CrmState>;
  readonly replies: BridgeHandle<ReplyState>;
  readonly sequences: BridgeHandle<SequenceState>;
  readonly update: BridgeHandle<UpdateStatus>;
  /**
   * Hold the next answer to `bridge.method` until the returned function is called, to see
   * what the page does with an answer that arrives late. Later calls are answered at once.
   */
  hold(method: string): () => void;
  stop(): Promise<void>;
}

const METHODS: Readonly<Record<string, { readonly global: string; readonly methods: readonly string[] }>> = {
  callie: { global: 'callie', methods: ['state', 'signIn', 'signOut', 'refreshToday'] },
  mailbox: { global: 'callieMailbox', methods: ['state', 'refresh', 'connect'] },
  today: {
    global: 'callieToday',
    methods: ['state', 'refresh', 'expand', 'collapse', 'snooze', 'dial', 'recordOutcome', 'scheduleCallback', 'releasePause'],
  },
  crm: {
    global: 'callieCrm',
    methods: [
      'state',
      'openFirm',
      'openPipeline',
      'saveContact',
      'changeStage',
      'resolveMerge',
      'openAddFirm',
      'addFirm',
      'openImport',
      'previewImport',
      'commitImport',
      'openOpportunity',
      'enroll',
      'confirmRoute',
      'checkRoute',
    ],
  },
  replies: { global: 'callieReplies', methods: ['state', 'refresh', 'open', 'collapse', 'confirm', 'resolve'] },
  sequences: {
    global: 'callieSequences',
    methods: [
      'state',
      'openSequence',
      'createSequence',
      'createDraft',
      'saveDraft',
      'createTemplate',
      'reviewEnrollment',
      'closeReview',
      'publish',
      'retire',
      'approveTemplate',
      'enroll',
      'resumeEnrollment',
    ],
  },
  admin: {
    global: 'callieAdmin',
    methods: [
      'state',
      'show',
      'saveSetting',
      'openHistory',
      'loadDashboard',
      'createStage',
      'renameStage',
      'reorderStages',
      'retireStage',
      'acknowledgeAlert',
      'setSendingCap',
      'recordSendingAuthentication',
      'recordHolidayCalendar',
      'addCallingNumber',
      'attestCallingNumber',
      'retireCallingNumber',
      'recordPosture',
      'revokePosture',
    ],
  },
  update: { global: 'callieUpdate', methods: ['state', 'restart', 'checkNow'] },
};

/** `onNavigate` and `onChange` keep the page's listener where a spec can call it, as the main process's messages do. */
const LISTENERS: Readonly<Record<string, string>> = {
  callie: `onNavigate(listener) { (globalThis.__navigateListeners ??= []).push(listener); },`,
  update: `onChange(listener) { (globalThis.__updateListeners ??= []).push(listener); },`,
};

function bridgeScript(installed: readonly string[]): string {
  const objects = installed.map(name => {
    const entry = METHODS[name];
    if (entry === undefined) throw new Error(`no such bridge ${name}`);
    const methods = entry.methods.map(method => `  async ${method}(input) { return await ask('${name}.${method}', input); },`);
    return `globalThis.${entry.global} = {\n${[...methods, LISTENERS[name] ?? ''].join('\n')}\n};`;
  });
  return `${objects.join('\n')}
async function ask(method, argument) {
  const response = await fetch('/bridge/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(argument ?? null),
  });
  return await response.json();
}`;
}

let transpiled: Promise<string> | null = null;

/** The one renderer bundle, built once per spec run. */
async function transpile(): Promise<string> {
  transpiled ??= build({
    entryPoints: [`${rendererDirectory}renderer.ts`],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    write: false,
    platform: 'browser',
  }).then(bundle => bundle.outputFiles[0]?.text ?? '');
  return await transpiled;
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

export async function startAppServer(options: AppServerOptions = {}): Promise<AppServer> {
  const script = await transpile();
  const without = new Set<string>(options.without ?? []);
  const installed = ['callie', 'mailbox', 'today', 'crm', 'replies', 'sequences', 'admin', ...(options.update === undefined ? [] : ['update'])].filter(
    name => !without.has(METHODS[name]?.global ?? ''),
  );
  const html = (await readFile(`${rendererDirectory}index.html`, 'utf8'))
    .replace('<script type="module"', '<script src="./bridge.js"></script>\n    <script type="module"')
    // The shipped page has `connect-src 'none'` because the real renderer talks to the
    // main process across an IPC bridge, which CSP does not see. Here the bridges are
    // `fetch` to this same server, so the policy is relaxed to `'self'` for the test
    // document only; the file on disk stays strict. `replaceAll`: the phrase is in the
    // page's comment as well as in the policy.
    .replaceAll("connect-src 'none'", "connect-src 'self'");
  const styles = await readFile(`${rendererDirectory}styles.css`, 'utf8');

  const calls: Call[] = [];
  const held = new Map<string, Promise<void>>();

  let desktop = options.desktop ?? desktopState();
  let mailbox = options.mailbox ?? connectedMailbox();
  let connectAnswer = options.connectAnswer ?? connectedMailbox();
  let today = options.today ?? todayState();
  let admin = options.admin ?? readyAdmin();
  let crm = options.crm ?? crmState({ screen: 'pipeline', firm: null });
  let replies = options.replies ?? replyState();
  const sequenceAnswers = options.sequences ?? [EMPTY_SEQUENCE_STATE];
  let sequencesServed = 0;
  let sequences = sequenceAnswers[0] ?? EMPTY_SEQUENCE_STATE;
  let update: UpdateStatus = options.update ?? { kind: 'none' };

  const of = (bridge: string): Call[] =>
    calls
      .filter(call => call.method.startsWith(`${bridge}.`))
      .map(call => ({ method: call.method.slice(bridge.length + 1), argument: call.argument }));

  const answer = (method: string, argument: unknown): unknown => {
    const [bridge = '', name = ''] = method.split('.');
    const mine = of(bridge);
    if (bridge === 'callie') {
      if (name === 'signIn') desktop = signedInState();
      if (name === 'signOut') desktop = signedOutState({ notice: 'signed_out' });
      return desktop;
    }
    if (bridge === 'mailbox') {
      // The real main process holds `connect` open while the browser has the person;
      // here the grant lands at once, which is all a spec of the window can see.
      if (name === 'connect') mailbox = connectAnswer;
      return mailbox;
    }
    if (bridge === 'update') {
      // The real main process installs and relaunches; the page sees the install begin.
      if (name === 'restart' && update.kind === 'ready') update = { kind: 'installing', version: update.version };
      return update;
    }
    if (bridge === 'today') {
      today = todayAnswer(today, name, argument, mine);
      if (name === 'refresh' && options.onRefresh !== undefined) {
        today = options.onRefresh(today, mine.filter(call => call.method === 'refresh').length);
      }
      return today;
    }
    if (bridge === 'admin') {
      admin = adminAnswer(admin, name, argument, mine, options.figuresFail === true);
      return admin;
    }
    if (bridge === 'crm') {
      crm = crmAnswer(crm, name, argument, mine);
      return crm;
    }
    if (bridge === 'replies') {
      replies = replyAnswer(replies, name, argument, mine);
      return replies;
    }
    if (bridge === 'sequences') {
      if (name === 'state') {
        sequences = sequenceAnswers[Math.min(sequencesServed, sequenceAnswers.length - 1)] ?? sequences;
        sequencesServed += 1;
      }
      sequences = options.sequencesScripted?.[name] ?? sequences;
      return sequences;
    }
    throw new Error(`no such bridge ${bridge}`);
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
      if (path === '/bridge.js') return send(200, 'text/javascript; charset=utf-8', bridgeScript(installed));
      if (path === '/styles.css') return send(200, 'text/css; charset=utf-8', styles);
      if (path.startsWith('/bridge/')) {
        const method = path.slice('/bridge/'.length);
        const argument = await readBody(request);
        calls.push({ method, argument });
        const body = JSON.stringify(answer(method, argument));
        const wait = held.get(method);
        held.delete(method);
        await wait;
        return send(200, 'application/json', body);
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
  const base = `http://127.0.0.1:${String(port)}/`;

  const handle = <S>(bridge: string, read: () => S, write: (state: S) => void): BridgeHandle<S> => ({
    get calls() {
      return of(bridge);
    },
    state: read,
    setState: write,
  });

  return {
    url: (hash = '') => `${base}${hash}`,
    get calls() {
      return [...calls];
    },
    called: method => calls.filter(call => call.method === method).map(call => call.argument),
    desktop: handle('callie', () => desktop, state => { desktop = state; }),
    mailbox: {
      ...handle('mailbox', () => mailbox, state => { mailbox = state; }),
      get calls() {
        return of('mailbox');
      },
      setConnectAnswer: state => {
        connectAnswer = state;
      },
    },
    today: handle('today', () => today, state => { today = state; }),
    admin: handle('admin', () => admin, state => { admin = state; }),
    crm: handle('crm', () => crm, state => { crm = state; }),
    replies: handle('replies', () => replies, state => { replies = state; }),
    sequences: handle('sequences', () => sequences, state => { sequences = state; }),
    update: handle('update', () => update, state => { update = state; }),
    hold: method => {
      let release: () => void = () => undefined;
      held.set(
        method,
        new Promise<void>(resolve => {
          release = resolve;
        }),
      );
      return release;
    },
    stop: async () => {
      // The page holds a keep-alive socket after its last request, and `close` waits for
      // every open connection; closing them first is what lets the next spec start.
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

/** What the Window menu's ⌘1–⌘6 and a deep link do: `callie:navigate` with a route name. */
export async function navigateByMenu(page: { evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R> }, route: string): Promise<void> {
  await page.evaluate(name => {
    for (const listener of (globalThis as unknown as { __navigateListeners?: ((route: string) => void)[] }).__navigateListeners ?? []) {
      listener(name);
    }
  }, route);
}

export { adminState, crmState, replyState };
