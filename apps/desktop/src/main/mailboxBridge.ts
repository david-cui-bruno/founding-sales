import { gmailConnectResultSchema, gmailStatusSchema, type GmailStatus } from '@fss/contracts';
import { mailboxStateSchema, type MailboxState } from '../shared/contract.ts';
import type { ApiOutcome } from './apiClient.ts';
import type { AuthedClient } from './authedClient.ts';

/**
 * The Mailbox row on "This Mac", in the main process (specification 5.1, 12.1, 14.2).
 *
 * Desktop 1.0.0 had no way to connect Gmail. The API has served `POST /gmail/connect`,
 * `GET /gmail/status` and the consent callback since G7, the runbook told the operator to
 * "connect the mailbox from the Mac client", and nothing in `apps/desktop` called either
 * path — which the first real sign-in to production found on 24 September 2026
 * (docs/greenfield/release.md 8.0x). This file is the missing half, built the way G2
 * built sign-in:
 *
 *   1. `connect` sends the `connect_mailbox` command through the same `AuthedClient`
 *      every other window uses, so the 5.3 envelope, the bearer token and the version
 *      gate are the ones the session manager owns;
 *   2. the consent URL the API returns goes straight to the system browser — the port
 *      is `shell.openExternal`, exactly as sign-in's is — and never crosses the bridge,
 *      because the renderer has no use for it and a URL carrying a signed state is not
 *      something a page should hold;
 *   3. the main process then reads `/gmail/status` every couple of seconds until the
 *      mailbox is connected, the grant's signed state has expired, the person presses
 *      Refresh, or the server refuses. The callback page says nothing about the grant
 *      (G7's decision, the same as sign-in's), so the authenticated status read is the
 *      only way the Mac learns the outcome.
 *
 * There is no disconnect. `docs/greenfield/mail.md` ("Mailbox lifecycle: the thirty-day
 * rule") keeps a mailbox that sent automated mail connected for thirty days after its
 * last send, and says the guard — a refusal with an audited admin override — belongs to
 * a later lane. A button here would be a way round a rule nothing yet enforces.
 *
 * Nothing here imports Electron, so it is tested without a window (`test/mailbox.test.ts`).
 */

export const MAILBOX_IPC_CHANNELS = {
  state: 'callie:mailbox:state',
  refresh: 'callie:mailbox:refresh',
  connect: 'callie:mailbox:connect',
} as const;
export type MailboxIpcChannel = (typeof MAILBOX_IPC_CHANNELS)[keyof typeof MAILBOX_IPC_CHANNELS];

/**
 * The two API paths the row calls. Both are in `GMAIL_PATHS` in
 * `apps/api/src/routes/gmail.ts`, and `test/release/desktopMailbox.check.ts` fails if
 * either stops being a path the API mounts.
 */
export const MAILBOX_API_PATHS = Object.freeze({
  status: '/gmail/status',
  connect: '/gmail/connect',
} as const);

/** How often the main process asks whether the grant has landed. */
export const DEFAULT_MAILBOX_POLL_INTERVAL_MS = 2_000;

/**
 * The longest the Mac waits, whatever the grant's expiry says. The API's signed state
 * lives ten minutes (`DEFAULT_GRANT_SECONDS`), and a callback after that is refused, so
 * waiting longer would only be waiting for something that cannot happen.
 */
export const MAXIMUM_MAILBOX_WAIT_MS = 10 * 60 * 1000;

export interface MailboxBridgeDeps {
  readonly api: AuthedClient;
  /** G2's session manager: signed in, online, and a version the API accepts. */
  readonly session: {
    state(): Promise<{
      readonly online: boolean;
      readonly mayMutate: boolean;
      readonly device: object | null;
    }>;
  };
  /** The system browser. `shell.openExternal` in the app; a recorder in the tests. */
  readonly openExternally: (url: string) => Promise<void>;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollIntervalMs?: number;
}

export interface MailboxBridgeHost {
  state(): Promise<MailboxState>;
  refresh(): Promise<MailboxState>;
  connect(): Promise<MailboxState>;
}

/**
 * The consent URL, if it is one the Mac will hand to the browser.
 *
 * `shell.openExternal` opens whatever scheme macOS has a handler for, so the one thing
 * checked is that this is an `https:` address — a `file:` or an application scheme from
 * a confused or hostile answer is refused, not opened. The host is Google's in
 * production and a test host in the suites; the API chose it, and the API is the
 * authority on where its own grant starts.
 */
export function consentUrlOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Only what the row shows. The id, the watermark and the sync error text stay here. */
function rowOf(value: GmailStatus): NonNullable<MailboxState['status']> {
  return {
    connected: value.connected,
    mailbox:
      value.mailbox === null
        ? null
        : {
            emailAddress: value.mailbox.emailAddress,
            status: value.mailbox.status,
            syncState: value.mailbox.syncState,
          },
  };
}

export function createMailboxBridge(deps: MailboxBridgeDeps): MailboxBridgeHost {
  const now = deps.now ?? ((): Date => new Date());
  const sleep =
    deps.sleep ??
    (async (ms: number): Promise<void> => {
      await new Promise(resolve => setTimeout(resolve, ms));
    });
  const interval = deps.pollIntervalMs ?? DEFAULT_MAILBOX_POLL_INTERVAL_MS;

  let status: MailboxState['status'] = null;
  let connecting = false;
  // Two notices, because they clear differently: a failed read is forgotten by the next
  // read that answers, while a refused connection stays on the row until the person
  // presses Refresh or starts again — a window regaining focus must not erase it.
  let readNotice: string | null = null;
  let connectNotice: string | null = null;
  // Every connect and every refresh takes the next number. A wait whose number is no
  // longer the current one has been overtaken and stops at its next wake-up.
  let attempt = 0;

  const snapshot = async (): Promise<MailboxState> => {
    const session = await deps.session.state();
    return mailboxStateSchema.parse({
      status,
      connecting,
      mayConnect: session.device !== null && session.mayMutate && !connecting,
      notice: connectNotice ?? readNotice,
    });
  };

  const read = async (): Promise<ApiOutcome<GmailStatus>> => {
    const answer = await deps.api.read(MAILBOX_API_PATHS.status, value => gmailStatusSchema.parse(value));
    if (answer.ok) {
      status = rowOf(answer.value);
      readNotice = null;
    } else {
      // A read that did not answer means the row does not know, and says so. Keeping the
      // last answer would show it as current — and after a sign-out and a sign-in as
      // somebody else, it would be somebody else's address.
      status = null;
      readNotice = answer.reason;
    }
    return answer;
  };

  /** Stop waiting, with this code on the row (or none), and say where things stand. */
  const finish = async (code: string | null): Promise<MailboxState> => {
    connecting = false;
    connectNotice = code;
    return await snapshot();
  };

  return {
    async state() {
      await read();
      return await snapshot();
    },

    async refresh() {
      attempt += 1;
      connecting = false;
      connectNotice = null;
      await read();
      return await snapshot();
    },

    async connect() {
      // A second press while the browser is open is the first press, not a second grant.
      // The flag is claimed before the first `await`, so two presses in the same tick
      // cannot both get past it.
      if (connecting) return await snapshot();
      attempt += 1;
      const mine = attempt;
      connecting = true;
      connectNotice = null;

      const session = await deps.session.state();
      if (attempt !== mine) return await snapshot();
      if (session.device === null) return await finish('not_signed_in');
      // Not refused for offline (wave 1): the command below finds out, and says `offline`
      // itself when the server cannot be reached.
      // The API checks the version itself and is the authority; this only stops the Mac
      // offering a person a command it already knows will be refused (5.3).
      if (!session.mayMutate) return await finish('client_upgrade_required');
      if (status?.connected === true) return await finish('mailbox_already_connected');

      const started = await deps.api.command(MAILBOX_API_PATHS.connect, {}, value =>
        gmailConnectResultSchema.parse(value),
      );
      if (attempt !== mine) return await snapshot();
      if (!started.ok) return await finish(started.reason);
      const url = consentUrlOf(started.value.authorizationUrl);
      if (url === null) return await finish('consent_url_refused');

      try {
        // The system browser, never a window inside the app: the person must see the
        // address bar that says accounts.google.com (5.1).
        await deps.openExternally(url);
      } catch {
        return await finish('browser_unavailable');
      }

      const remaining = Date.parse(started.value.expiresAt) - now().getTime();
      // A Mac clock ahead of the API's would put the expiry in the past before the
      // person has seen the consent screen; the ten-minute bound still holds then.
      const deadline =
        now().getTime() + (remaining > 0 ? Math.min(remaining, MAXIMUM_MAILBOX_WAIT_MS) : MAXIMUM_MAILBOX_WAIT_MS);

      for (;;) {
        await sleep(interval);
        // Refresh overtook this wait: it already read the status and cleared the flag.
        if (attempt !== mine) return await snapshot();
        const answer = await read();
        if (attempt !== mine) return await snapshot();
        if (answer.ok && answer.value.connected) return await finish(null);
        // Offline is worth waiting through: the browser half does not need this Mac.
        // Any refusal is not — a revoked device will not become a connected mailbox.
        if (!answer.ok && !answer.offline) return await finish(answer.reason);
        if (now().getTime() >= deadline) return await finish('mailbox_connect_timed_out');
      }
    },
  };
}
