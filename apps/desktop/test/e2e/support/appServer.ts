import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { BUNDLE_STYLESHEET, BUNDLE_STYLESHEET_SOURCE, BUNDLE_WINDOWS } from '../../../src/main/bundleScheme.ts';
import { compileStylesheet } from '../../../scripts/styles.ts';
import type { DeviceList, DesktopState, MailboxState } from '../../../src/shared/contract.ts';
import type { UpdateStatus } from '../../../src/shared/updateContract.ts';
import type { CrmState } from '../../../src/renderer/firmWorkspaceContract.ts';

import type { SequenceState } from '../../../src/renderer/sequenceContract.ts';
import type { AdminState } from '../../../src/renderer/settingsContract.ts';
import type { TodayState } from '../../../src/renderer/todayContract.ts';
import { EMPTY_SEQUENCE_STATE } from '../../../src/renderer/sequenceView.ts';
import { adminAnswer, adminState } from './adminFixtures.ts';
import { crmAnswer, crmState } from './crmFixtures.ts';
import { connectedMailbox, desktopState, readyAdmin, todayAnswer, todayState } from './homeFixtures.ts';
import { replyAnswer, replyState, replyWire, type ReplyLane } from './replyFixtures.ts';
import { signedInState, signedOutState } from './sessionFixtures.ts';

/**
 * The one test server every window spec runs against (wave 1).
 *
 * There is one window, so there is one harness: the shipped `index.html`, the React root
 * `main.tsx` — which holds the shell and every view — and the stylesheet Tailwind compiles
 * from `tailwind.css`, both produced exactly as `scripts/bundle.ts` produces them and
 * served unmodified under the names the page asks for (`renderer.js`, `styles.css`). Only the eight bridges the preload script installs are replaced,
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

/**
 * `FSS_E2E_RENDERER_BUNDLE`: a directory holding a packaged build's `index.html`,
 * `renderer.js` and `styles.css`, extracted from its `app.asar`. Set, every spec runs
 * against those bytes rather than the source, so a packaged build's renderer can be
 * put through the same harness (wave 1). Unset, the source is bundled here.
 */
const packagedBundle = process.env['FSS_E2E_RENDERER_BUNDLE'];
const pageDirectory = packagedBundle === undefined ? rendererDirectory : `${packagedBundle.replace(/\/$/u, '')}/`;

export interface Call {
  readonly method: string;
  readonly argument: unknown;
}

/** What `POST /outbound/status` knows about one send, as Diagnostics shows it. */
export interface DiagnosticsFence {
  readonly id: string;
  readonly state: string;
  readonly recipientAddress: string;
  readonly dispatchStartedAt: string | null;
  readonly sentAt: string | null;
  readonly heldReason: string | null;
  readonly adminResolution: 'delivered' | 'skipped' | null;
  readonly reconcileAttempts: number;
}

/** One row of `GET /admin/jobs/dead`. */
export interface DiagnosticsDeadJob {
  readonly id: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly requeuedCount: number;
  readonly errorCode: string | null;
  readonly errorDetail: string | null;
  readonly deadAt: string;
}

/** A bridge, as a spec sees it: its calls (method names without the bridge's prefix) and its state. */
export interface BridgeHandle<S> {
  readonly calls: readonly Call[];
  state(): S;
  setState(state: S): void;
}

type Optional = 'callieApi' | 'callieImport';

export interface AppServerOptions {
  readonly desktop?: DesktopState;
  readonly mailbox?: MailboxState;
  /** What `callie.listDevices` answers with (wave 3b, A4). */
  readonly devices?: DeviceList;
  /** What `callie.revokeDevice` moves the session to; the default marks the Mac revoked. */
  readonly revokeAnswer?: DesktopState;
  /** What `callie.signOut` answers; the default is a plain signed-out session. */
  readonly signOutAnswer?: DesktopState;
  /** What `callieMailbox.connect` answers; connected by default. */
  readonly connectAnswer?: MailboxState;
  readonly today?: TodayState;
  /** What `today.refresh` answers, given the list held and which read this is (1 for the first). */
  readonly onRefresh?: (today: TodayState, count: number) => TodayState;
  readonly admin?: AdminState;
  /** `loadDashboard` answers with no figures for the window asked, as a refused read does. */
  readonly figuresFail?: boolean;
  readonly crm?: CrmState;
  readonly replies?: ReplyLane;
  /** What each `sequences.state` answers, one per call; the last repeats. */
  readonly sequences?: readonly SequenceState[];
  /** The state a sequences method moves the window to, by method name. */
  readonly sequencesScripted?: Readonly<Partial<Record<string, SequenceState>>>;
  /** Install `callieUpdate`, answering this. Absent: the page has no update bridge. */
  readonly update?: UpdateStatus;
  /**
   * Settings › Diagnostics. The fence one send is in, and the jobs that gave up: the two
   * recovery forms are the only thing that asks for either.
   */
  readonly sendStatus?: DiagnosticsFence | null;
  readonly deadJobs?: readonly DiagnosticsDeadJob[];
  /** What `callie.signIn` answers. Absent: signed in. */
  readonly signInAnswer?: DesktopState;
  /** What Update now finds: a version a blocked build installs at once. Absent: nothing. */
  readonly updateFound?: string;
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
  readonly replies: BridgeHandle<ReplyLane>;
  readonly sequences: BridgeHandle<SequenceState>;
  readonly update: BridgeHandle<UpdateStatus>;
  /**
   * Hold the next answer to `bridge.method` until the returned function is called, to see
   * what the page does with an answer that arrives late. Later calls are answered at once.
   */
  hold(method: string): () => void;
  stop(): Promise<void>;
}

/**
 * The globals that are *not* the registry (1.0.13).
 *
 * Until 1.0.13 every view had a named channel of its own and this table was six
 * objects long. The registry replaced them, so what is left is the shell's own bridge,
 * the updater's, and the two handoffs that are not operations: dialling, which opens a
 * URI rather than answering with one, and choosing a CSV, which opens macOS's dialog.
 */
const METHODS: Readonly<Record<string, { readonly global: string; readonly methods: readonly string[] }>> = {
  callie: { global: 'callie', methods: ['state', 'signIn', 'signOut', 'listDevices', 'revokeDevice'] },
  update: { global: 'callieUpdate', methods: ['state', 'restart', 'checkNow'] },
};

/** `onNavigate` and `onChange` keep the page's listener where a spec can call it, as the main process's messages do. */
const LISTENERS: Readonly<Record<string, string>> = {
  callie: `onNavigate(listener) { (globalThis.__navigateListeners ??= []).push(listener); },
  onSessionChange(listener) { (globalThis.__sessionListeners ??= []).push(listener); },`,
  update: `onChange(listener) { (globalThis.__updateListeners ??= []).push(listener); },`,
};

/**
 * D4's registry, faked. `callieApi.read(op, input)` and `callieApi.command(op, input)`
 * post to `/bridge/<op>`, and the operations are named `today.expand`, `replies.confirm`
 * and so on — the same `bridge.method` the other fakes use — so a spec asks for
 * `called('today.expand')` whether the view reached it through a bridge of its own or
 * through the registry. Dialling keeps its own method, as it does in the preload.
 */
const OPERATION_API = `globalThis.callieApi = {
  async read(operation, input) { return await ask(operation, input ?? null); },
  async command(operation, input) { return await ask(operation, input ?? null); },
};
globalThis.callieDial = {
  async call(input) { return await ask('today.dial', input ?? null); },
};`;

/**
 * The import handoff, faked. The real one opens macOS's open panel, reads the file and
 * posts the preview, all in the main process; here it is one call a spec can script
 * with `importAnswer`, because a page that never names a path has nothing else to show.
 */
const IMPORT_API = `globalThis.callieImport = {
  async choose() { return await ask('crm.chooseImportFile', null); },
};`;

function bridgeScript(installed: readonly string[]): string {
  const objects = installed.map(name => {
    if (name === 'api') return OPERATION_API;
    if (name === 'import') return IMPORT_API;
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
let compiledStyles: Promise<string> | null = null;

/** The one renderer bundle, built once per spec run, from the window's declared source. */
async function transpile(): Promise<string> {
  if (packagedBundle !== undefined) return await readFile(`${pageDirectory}renderer.js`, 'utf8');
  const entry = BUNDLE_WINDOWS[0]?.source ?? 'main.tsx';
  transpiled ??= build({
    entryPoints: [`${rendererDirectory}${entry}`],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    write: false,
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  }).then(bundle => bundle.outputFiles[0]?.text ?? '');
  return await transpiled;
}

/**
 * The one stylesheet, compiled once per spec run by the same function the packaging build
 * uses. A packaged run reads the bytes out of the extracted bundle instead, which is what
 * makes `FSS_E2E_RENDERER_BUNDLE` a check of the artifact rather than of the source.
 */
async function stylesheet(): Promise<string> {
  if (packagedBundle !== undefined) return await readFile(`${pageDirectory}${BUNDLE_STYLESHEET}`, 'utf8');
  compiledStyles ??= compileStylesheet(`${rendererDirectory}${BUNDLE_STYLESHEET_SOURCE}`);
  return await compiledStyles;
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
  const GLOBAL_OF: Readonly<Record<string, string>> = { api: 'callieApi', import: 'callieImport' };
  const installed = ['callie', 'api', 'import', ...(options.update === undefined ? [] : ['update'])].filter(
    name => !without.has((GLOBAL_OF[name] ?? METHODS[name]?.global ?? '') as Optional),
  );
  const html = (await readFile(`${pageDirectory}index.html`, 'utf8'))
    .replace('<script type="module"', '<script src="./bridge.js"></script>\n    <script type="module"')
    // The shipped page has `connect-src 'none'` because the real renderer talks to the
    // main process across an IPC bridge, which CSP does not see. Here the bridges are
    // `fetch` to this same server, so the policy is relaxed to `'self'` for the test
    // document only; the file on disk stays strict. `replaceAll`: the phrase is in the
    // page's comment as well as in the policy.
    .replaceAll("connect-src 'none'", "connect-src 'self'");
  const styles = await stylesheet();

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
  let deadJobs: readonly DiagnosticsDeadJob[] = options.deadJobs ?? [];
  let fence: DiagnosticsFence | null = options.sendStatus ?? null;

  const of = (bridge: string): Call[] =>
    calls
      .filter(call => call.method.startsWith(`${bridge}.`))
      .map(call => ({ method: call.method.slice(bridge.length + 1), argument: call.argument }));

  const answer = (method: string, argument: unknown): unknown => {
    const [bridge = '', name = ''] = method.split('.');
    const mine = of(bridge);
    if (bridge === 'callie') {
      if (name === 'signIn') desktop = options.signInAnswer ?? signedInState();
      if (name === 'signOut') desktop = options.signOutAnswer ?? signedOutState({ notice: 'signed_out' });
      // Wave 3b: the workspace's Macs are read on demand, and revoking one answers the
      // same session state with that Mac marked. The real main process decides what
      // revoking *this* Mac means; here a spec scripts the answer it wants.
      if (name === 'listDevices') desktop = { ...desktop, devices: options.devices ?? [] };
      if (name === 'revokeDevice') {
        const asked = (argument as { deviceId?: string } | null)?.deviceId;
        desktop =
          options.revokeAnswer ??
          {
            ...desktop,
            notice: 'device_revoked_elsewhere',
            devices: (desktop.devices ?? []).map(entry =>
              entry.deviceId === asked ? { ...entry, status: 'revoked' as const } : entry,
            ),
          };
      }
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
      if (name === 'checkNow' && options.updateFound !== undefined) update = { kind: 'installing', version: options.updateFound };
      return update;
    }
    if (bridge === 'today') {
      today = todayAnswer(today, name, argument, mine);
      if (name === 'refresh' && options.onRefresh !== undefined) {
        today = options.onRefresh(today, mine.filter(call => call.method === 'refresh').length);
      }
      return today;
    }
    // `settings.*` since 1.0.13: the family is the registry's name for what used to be
    // the administration bridge, and `adminFixtures.ts` answers by method name.
    if (bridge === 'settings') {
      admin = adminAnswer(admin, name, argument, mine, options.figuresFail === true);
      return admin;
    }
    if (bridge === 'crm') {
      crm = crmAnswer(crm, name, argument, mine);
      return crm;
    }
    if (bridge === 'replies') {
      replies = replyAnswer(replies, name, argument, mine);
      // The window is handed summaries and the open card, never the lane's bodies —
      // the same reduction `replySummaryOf` makes in the main process.
      return replyWire(replies);
    }
    if (bridge === 'diagnostics') {
      if (name === 'sendStatus') return { fence };
      if (name === 'resolveSend') {
        const input = argument as { readonly outboundMessageId: string; readonly resolution: 'delivered' | 'skipped' };
        fence = fence === null ? null : { ...fence, adminResolution: input.resolution };
        return { outboundMessageId: input.outboundMessageId, resolution: input.resolution };
      }
      if (name === 'deadJobs') return { deadJobs };
      if (name === 'requeueJob') {
        const { jobId } = argument as { readonly jobId: string };
        const job = deadJobs.find(one => one.id === jobId);
        if (job === undefined) throw new Error('no such job');
        deadJobs = deadJobs.filter(one => one.id !== jobId);
        return { requeued: true, jobId, kind: job.kind };
      }
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
    admin: handle('settings', () => admin, state => { admin = state; }),
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
