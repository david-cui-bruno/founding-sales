import { describe, expect, it } from 'vitest';
import { connectMailboxCommandSchema, type GmailStatus } from '@fss/contracts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import type { HttpAnswer } from '../src/main/apiClient.ts';
import {
  MAILBOX_API_PATHS,
  MAILBOX_IPC_CHANNELS,
  MAXIMUM_MAILBOX_WAIT_MS,
  consentUrlOf,
  createMailboxBridge,
  type MailboxBridgeDeps,
} from '../src/main/mailboxBridge.ts';
import { mailboxStateSchema, type MailboxState } from '../src/shared/contract.ts';
import {
  CONNECT_GMAIL_LABEL,
  MAILBOX_WAITING_LABEL,
  buildMailboxView,
  mailboxNoticeSentence,
} from '../src/renderer/viewModel.ts';

/**
 * The Mailbox row on "This Mac" (release.md 8.0x).
 *
 * Desktop 1.0.0 had no control that called `POST /gmail/connect` or `GET /gmail/status`,
 * and nothing in this suite noticed, because nothing here asked. These tests are the
 * asking: the bridge is given a scripted API, a scripted session and a recorder in
 * place of `shell.openExternal`, so what is proved is the sequence a person depends on
 * — the command is sent with the envelope the API parses, the consent URL goes to the
 * system browser and nowhere else, and the status is read until the mailbox connects,
 * the grant expires, the person presses Refresh, or the server refuses.
 *
 * `example.test` is reserved by RFC 6761; no real address appears.
 */

const MAILBOX_ID = '77777777-7777-4777-8777-777777777777';
const ADDRESS = 'sales@example.test';
const START = Date.parse('2026-09-24T15:10:00.000Z');

type Scripted = HttpAnswer | 'offline';

function status(connected: boolean, overrides: Partial<NonNullable<GmailStatus['mailbox']>> = {}): HttpAnswer {
  return {
    status: 200,
    body: {
      connected,
      mailbox: connected
        ? {
            id: MAILBOX_ID,
            emailAddress: ADDRESS,
            status: 'connected',
            syncState: 'baseline_pending',
            coverageWatermarkAt: null,
            lastSyncedAt: null,
            lastSyncError: null,
            ...overrides,
          }
        : null,
    },
  };
}

const accepted = (result: unknown): HttpAnswer => ({ status: 200, body: { status: 'accepted', replayed: false, result } });

/**
 * A whole Mac as far as the row can see: an API that answers each path from a queue
 * (the last answer repeats), a session, a browser that records, and a clock that the
 * poll's sleep moves forward.
 */
function world(
  answers: Readonly<Record<string, readonly Scripted[]>>,
  options: {
    readonly session?: { online: boolean; mayMutate: boolean; device: object | null };
    readonly openFails?: boolean;
    readonly onSleep?: (count: number) => Promise<void>;
  } = {},
) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const opened: string[] = [];
  const queues = new Map(Object.entries(answers).map(([path, list]) => [path, [...list]]));
  let clock = START;
  let sleeps = 0;

  const api = createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: '1.0.1',
    accessToken: async () => await Promise.resolve('token-value'),
    send: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ method: init.method, path, body: init.body === undefined ? null : JSON.parse(init.body) });
      const queue = queues.get(path) ?? [];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next === undefined) return await Promise.resolve({ status: 404, body: { error: 'not_found' } });
      if (next === 'offline') throw new Error('the server did not answer');
      return await Promise.resolve(next);
    },
  });

  const deps: MailboxBridgeDeps = {
    api,
    session: {
      state: async () =>
        await Promise.resolve(options.session ?? { online: true, mayMutate: true, device: { role: 'admin' } }),
    },
    openExternally: async url => {
      if (options.openFails === true) throw new Error('no handler');
      opened.push(url);
      await Promise.resolve();
    },
    now: () => new Date(clock),
    sleep: async ms => {
      sleeps += 1;
      clock += ms;
      await options.onSleep?.(sleeps);
    },
    pollIntervalMs: 2_000,
  };
  const bridge = createMailboxBridge(deps);
  const paths = (): string[] => calls.map(call => call.path);
  return { bridge, calls, opened, paths, advance: (ms: number) => (clock += ms) };
}

const consentUrl = 'https://accounts.google.test/o/oauth2/v2/auth?client_id=x&state=signed-state-value';
const started = (url = consentUrl, expiresInMs = 600_000): HttpAnswer =>
  accepted({ authorizationUrl: url, expiresAt: new Date(START + expiresInMs).toISOString() });

describe('the Mailbox bridge: connect', () => {
  it('sends connect_mailbox, opens the consent URL in the system browser, and reads the status until it connects', async () => {
    const mac = world({
      [MAILBOX_API_PATHS.connect]: [started()],
      [MAILBOX_API_PATHS.status]: [status(false), status(false), status(true)],
    });

    const answer = await mac.bridge.connect();

    // The command first, then the browser, then one status read per wake-up.
    expect(mac.paths()).toEqual(['/gmail/connect', '/gmail/status', '/gmail/status', '/gmail/status']);
    expect(mac.calls[0]?.method).toBe('POST');
    expect(mac.calls[1]?.method).toBe('GET');
    expect(mac.opened).toEqual([consentUrl]);
    // What the Mac sent is exactly what the API's own schema accepts: the envelope and
    // nothing else, so no scope, redirect or URL can be chosen from this side.
    expect(connectMailboxCommandSchema.safeParse(mac.calls[0]?.body).success).toBe(true);

    expect(answer).toEqual({
      status: { connected: true, mailbox: { emailAddress: ADDRESS, status: 'connected', syncState: 'baseline_pending' } },
      connecting: false,
      mayConnect: true,
      notice: null,
    });
  });

  it('never hands the consent URL, the token or the mailbox id to the window', async () => {
    const mac = world({
      [MAILBOX_API_PATHS.connect]: [started()],
      [MAILBOX_API_PATHS.status]: [status(true, { lastSyncError: 'history_list: status 500' })],
    });
    const answer = await mac.bridge.connect();
    const crossing = JSON.stringify(answer);
    expect(crossing).not.toContain('signed-state-value');
    expect(crossing).not.toContain('token-value');
    expect(crossing).not.toContain(MAILBOX_ID);
    expect(crossing).not.toContain('history_list');
    // `strictObject`: a field that could carry any of them is a parse error.
    expect(() => mailboxStateSchema.parse({ ...answer, authorizationUrl: consentUrl })).toThrow();
  });

  it('shows a refusal as a notice on the row, and opens nothing', async () => {
    const mac = world({
      [MAILBOX_API_PATHS.connect]: [{ status: 426, body: { status: 'refused', replayed: false, reason: 'client_upgrade_required' } }],
      [MAILBOX_API_PATHS.status]: [status(false)],
    });
    const answer = await mac.bridge.connect();
    expect(answer.notice).toBe('client_upgrade_required');
    expect(answer.connecting).toBe(false);
    expect(mac.opened).toEqual([]);
    expect(mac.paths()).toEqual(['/gmail/connect']);
  });

  it('keeps a refused connection on the row when the window regains focus', async () => {
    const mac = world({
      [MAILBOX_API_PATHS.connect]: [{ status: 409, body: { status: 'refused', replayed: false, reason: 'invalid_input' } }],
      [MAILBOX_API_PATHS.status]: [status(false)],
    });
    await mac.bridge.connect();
    // A focus read answers, and the refusal is still there to be read.
    expect((await mac.bridge.state()).notice).toBe('invalid_input');
    // Refresh is what clears it.
    expect((await mac.bridge.refresh()).notice).toBeNull();
  });

  it('opens nothing but an https: consent URL', async () => {
    for (const url of ['file:///Applications/Calculator.app', 'http://accounts.google.test/o/oauth2/v2/auth']) {
      const mac = world({ [MAILBOX_API_PATHS.connect]: [started(url)], [MAILBOX_API_PATHS.status]: [status(false)] });
      const answer = await mac.bridge.connect();
      expect(answer.notice).toBe('consent_url_refused');
      expect(mac.opened).toEqual([]);
    }
    expect(consentUrlOf('https://accounts.google.com/o/oauth2/v2/auth?state=x')).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?state=x',
    );
    expect(consentUrlOf('not a url')).toBeNull();
  });

  it('says so when the system browser cannot be opened', async () => {
    const mac = world(
      { [MAILBOX_API_PATHS.connect]: [started()], [MAILBOX_API_PATHS.status]: [status(false)] },
      { openFails: true },
    );
    const answer = await mac.bridge.connect();
    expect(answer.notice).toBe('browser_unavailable');
    expect(answer.connecting).toBe(false);
  });

  it('stops waiting when Refresh is pressed', async () => {
    let refreshed: MailboxState | null = null;
    const mac = world(
      { [MAILBOX_API_PATHS.connect]: [started()], [MAILBOX_API_PATHS.status]: [status(false)] },
      {
        onSleep: async count => {
          // The person abandoned the consent screen and pressed Refresh on the second wait.
          if (count === 2) refreshed = await mac.bridge.refresh();
        },
      },
    );
    const answer = await mac.bridge.connect();
    expect(refreshed).not.toBeNull();
    expect(answer.connecting).toBe(false);
    expect(answer.notice).toBeNull();
    expect(answer.mayConnect).toBe(true);
    // One read by the first wake-up, one by Refresh, and none after: the wait stopped.
    expect(mac.paths()).toEqual(['/gmail/connect', '/gmail/status', '/gmail/status']);
  });

  it('gives up when the grant’s signed state has expired', async () => {
    const mac = world({
      [MAILBOX_API_PATHS.connect]: [started(consentUrl, 6_000)],
      [MAILBOX_API_PATHS.status]: [status(false)],
    });
    const answer = await mac.bridge.connect();
    expect(answer.notice).toBe('mailbox_connect_timed_out');
    expect(answer.connecting).toBe(false);
    // Three two-second waits reach the six-second expiry.
    expect(mac.paths().filter(path => path === '/gmail/status')).toHaveLength(3);
  });

  it('never waits longer than ten minutes, whatever the expiry says', async () => {
    const mac = world({
      [MAILBOX_API_PATHS.connect]: [started(consentUrl, 24 * 3_600_000)],
      [MAILBOX_API_PATHS.status]: [status(false)],
    });
    const answer = await mac.bridge.connect();
    expect(answer.notice).toBe('mailbox_connect_timed_out');
    expect(mac.paths().filter(path => path === '/gmail/status')).toHaveLength(MAXIMUM_MAILBOX_WAIT_MS / 2_000);
  });

  it('waits through an offline read, and stops at a refusal', async () => {
    const mac = world({
      [MAILBOX_API_PATHS.connect]: [started()],
      [MAILBOX_API_PATHS.status]: ['offline', { status: 401, body: { error: 'device_revoked' } }],
    });
    const answer = await mac.bridge.connect();
    expect(answer.notice).toBe('device_revoked');
    expect(answer.connecting).toBe(false);
    expect(mac.paths()).toEqual(['/gmail/connect', '/gmail/status', '/gmail/status']);
  });

  it('does not start a second grant while the first consent screen is open', async () => {
    const mac = world({
      [MAILBOX_API_PATHS.connect]: [started()],
      [MAILBOX_API_PATHS.status]: [status(false), status(true)],
    });
    const [first, second] = await Promise.all([mac.bridge.connect(), mac.bridge.connect()]);
    expect(mac.paths().filter(path => path === '/gmail/connect')).toHaveLength(1);
    expect(mac.opened).toHaveLength(1);
    expect(second.connecting).toBe(true);
    expect(first.status?.connected).toBe(true);
  });

  it('asks the API nothing when this Mac may not mutate, and says why', async () => {
    for (const [session, reason] of [
      [{ online: true, mayMutate: false, device: null }, 'not_signed_in'],
      [{ online: true, mayMutate: false, device: { role: 'admin' } }, 'client_upgrade_required'],
    ] as const) {
      const mac = world({ [MAILBOX_API_PATHS.connect]: [started()] }, { session: { ...session } });
      const answer = await mac.bridge.connect();
      expect(answer.notice).toBe(reason);
      expect(answer.mayConnect).toBe(false);
      expect(mac.calls).toEqual([]);
    }
  });

  it('refuses to start a grant for a mailbox it has just read as connected', async () => {
    const mac = world({ [MAILBOX_API_PATHS.connect]: [started()], [MAILBOX_API_PATHS.status]: [status(true)] });
    await mac.bridge.state();
    const answer = await mac.bridge.connect();
    expect(answer.notice).toBe('mailbox_already_connected');
    expect(mac.paths()).toEqual(['/gmail/status']);
  });
});

describe('the Mailbox bridge: status', () => {
  it('reads /gmail/status and passes on only the address, the status and the baseline state', async () => {
    const mac = world({
      [MAILBOX_API_PATHS.status]: [
        status(true, { syncState: 'ready', lastSyncedAt: '2026-09-24T15:00:00.000Z', lastSyncError: 'a diagnostic' }),
      ],
    });
    const answer = await mac.bridge.state();
    expect(mac.calls).toEqual([{ method: 'GET', path: '/gmail/status', body: null }]);
    expect(answer.status).toEqual({
      connected: true,
      mailbox: { emailAddress: ADDRESS, status: 'connected', syncState: 'ready' },
    });
  });

  it('reports a revoked mailbox with its address, as not connected', async () => {
    const mac = world({
      [MAILBOX_API_PATHS.status]: [
        {
          status: 200,
          body: {
            connected: false,
            mailbox: {
              id: MAILBOX_ID,
              emailAddress: ADDRESS,
              status: 'revoked',
              syncState: 'ready',
              coverageWatermarkAt: null,
              lastSyncedAt: null,
              lastSyncError: null,
            },
          },
        },
      ],
    });
    const answer = await mac.bridge.state();
    expect(answer.status?.connected).toBe(false);
    expect(answer.status?.mailbox?.status).toBe('revoked');
    expect(answer.mayConnect).toBe(true);
  });

  it('does not show an old answer as current when a read fails', async () => {
    const mac = world({ [MAILBOX_API_PATHS.status]: [status(true), 'offline'] });
    expect((await mac.bridge.state()).status?.connected).toBe(true);
    const after = await mac.bridge.state();
    expect(after.status).toBeNull();
    expect(after.notice).toBe('offline');
  });

  it('forgets a failed read at the next read that answers', async () => {
    const mac = world({ [MAILBOX_API_PATHS.status]: ['offline', status(false)] });
    const first = await mac.bridge.state();
    expect(first.notice).toBe('offline');
    expect(first.status).toBeNull();
    const second = await mac.bridge.state();
    expect(second.notice).toBeNull();
    expect(second.status).toEqual({ connected: false, mailbox: null });
  });

  it('turns an answer that is not the contract into a notice, not a guess', async () => {
    const mac = world({ [MAILBOX_API_PATHS.status]: [{ status: 200, body: { connected: 'yes' } }] });
    const answer = await mac.bridge.state();
    expect(answer.notice).toBe('unreadable_answer');
    expect(answer.status).toBeNull();
  });

  it('names one channel per method, and nothing else — no disconnect', () => {
    expect(Object.values(MAILBOX_IPC_CHANNELS)).toEqual([
      'callie:mailbox:state',
      'callie:mailbox:refresh',
      'callie:mailbox:connect',
    ]);
    expect(Object.values(MAILBOX_API_PATHS)).toEqual(['/gmail/status', '/gmail/connect']);
  });
});

describe('the Mailbox row', () => {
  const state = (overrides: Partial<MailboxState> = {}): MailboxState =>
    mailboxStateSchema.parse({
      status: { connected: false, mailbox: null },
      connecting: false,
      mayConnect: true,
      notice: null,
      ...overrides,
    });

  it('offers Connect Gmail when no mailbox is connected', () => {
    expect(buildMailboxView(state())).toEqual({
      text: 'Not connected',
      action: { label: CONNECT_GMAIL_LABEL, enabled: true },
      hint: null,
      notice: null,
    });
    expect(CONNECT_GMAIL_LABEL).toBe('Connect Gmail');
  });

  it('shows the address and its status once connected, and offers nothing — not even Disconnect', () => {
    const view = buildMailboxView(
      state({
        status: { connected: true, mailbox: { emailAddress: ADDRESS, status: 'connected', syncState: 'baseline_pending' } },
      }),
    );
    expect(view.text).toBe('sales@example.test · connected · baseline pending');
    expect(view.action).toBeNull();
    expect(
      buildMailboxView(
        state({ status: { connected: true, mailbox: { emailAddress: ADDRESS, status: 'connected', syncState: 'ready' } } }),
      ).text,
    ).toBe('sales@example.test · connected · ready');
  });

  it('offers Connect Gmail again for a revoked mailbox, and names it', () => {
    const view = buildMailboxView(
      state({ status: { connected: false, mailbox: { emailAddress: ADDRESS, status: 'revoked', syncState: 'ready' } } }),
    );
    expect(view.text).toBe('sales@example.test · revoked');
    expect(view.action).toEqual({ label: CONNECT_GMAIL_LABEL, enabled: true });
  });

  it('waits, with nothing to press, while the consent screen is open', () => {
    for (const view of [buildMailboxView(state({ connecting: true, mayConnect: false })), buildMailboxView(state(), { waiting: true })]) {
      expect(view.action).toEqual({ label: MAILBOX_WAITING_LABEL, enabled: false });
      expect(view.hint).toContain('press Refresh');
    }
  });

  it('disables Connect Gmail when the Mac may not start one', () => {
    expect(buildMailboxView(state({ mayConnect: false })).action).toEqual({ label: CONNECT_GMAIL_LABEL, enabled: false });
  });

  it('offers nothing before the status has been read, rather than a blind second grant', () => {
    expect(buildMailboxView(null)).toEqual({ text: 'Checking…', action: null, hint: null, notice: null });
    const unknown = buildMailboxView(state({ status: null, notice: 'offline' }));
    expect(unknown.text).toBe('Unknown');
    expect(unknown.action).toBeNull();
    expect(unknown.notice).toBe('Callie cannot reach the server.');
  });

  it('puts a refusal on the card as one fixed sentence, and an unknown code as it came', () => {
    expect(buildMailboxView(state({ notice: 'mailbox_connect_timed_out' })).notice).toBe(
      'Gmail was not connected in time. Press Connect Gmail to start again.',
    );
    expect(mailboxNoticeSentence('device_revoked')).toBe('This Mac was signed out remotely. Sign in with Google again.');
    expect(mailboxNoticeSentence('http_502')).toBe('http_502');
  });
});
