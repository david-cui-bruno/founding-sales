import { describe, expect, it } from 'vitest';
import { compareVersions, connectMailboxCommandSchema, mayMutate, publishedClientVersions } from '@fss/contracts';
import { GMAIL_PATHS } from '../../src/routes/gmail.ts';
import { CONTAINER_CLIENT_VERSIONS } from '../../src/bootstrap/main.ts';
import { createAuthedClient } from '../../../desktop/src/main/authedClient.ts';
import type { HttpAnswer } from '../../../desktop/src/main/apiClient.ts';
import { MAILBOX_API_PATHS, createMailboxBridge } from '../../../desktop/src/main/mailboxBridge.ts';
import { CONNECT_GMAIL_LABEL, buildMailboxView } from '../../../desktop/src/renderer/viewModel.ts';

/**
 * The Mac can connect the mailbox (release.md 8.0x).
 *
 * On 24 September 2026 at 15:08Z David signed in to production from the published
 * desktop 1.0.0 and found a "This Mac" card with Sign out and nothing that connects
 * Gmail. The API had served `POST /gmail/connect` and `GET /gmail/status` since G7;
 * section 5.4 of the runbook said "connect the mailbox from the Mac client"; no file in
 * `apps/desktop` called either path, and no test anywhere asked whether one did. So the
 * two production alarms that wait for a mailbox — `fss-prod-mailbox-heartbeat-missed` and
 * `fss-prod-gmail-watch-expiring` — could not be cleared by anything the operator had.
 *
 * This check is the question nobody asked, in the release suite so a build without the
 * answer cannot be the one released.
 *
 * ## The vacuous-pass traps, named
 *
 * **A check that the words exist.** Asserting that `mailboxBridge.ts` mentions
 * `/gmail/connect` would pass against a bridge that builds the request and never opens
 * the consent screen — which, from the person's side, is 1.0.0 again. Closed by driving
 * the bridge: a scripted API and a recorder in place of `shell.openExternal`, and the
 * assertion is the sequence — the command, the URL opened, the status read until it
 * connects.
 *
 * **A bridge nobody can reach.** The bridge can be perfect and the window still have no
 * way to it, if the preload stops exposing it or the main process stops answering its
 * channel. Those two are Electron wiring and cannot run here, so the exact lines are
 * asserted, and a mutation removes the preload's.
 *
 * **A path the API does not mount.** The bridge's paths are compared with the API's own
 * `GMAIL_PATHS`, imported rather than re-typed.
 *
 * **A build the API refuses.** A client above the API's published maximum is
 * `api_behind_client` and is refused every sign-in, renewal and command — exactly as one
 * below the minimum is. The build that carries this row is 1.0.1, so an API still
 * publishing a maximum of 1.0.0 would refuse the fix. The maximum is read from the
 * constant the container serves.
 */

const ADDRESS = 'sales@example.test';
const CONSENT = 'https://accounts.google.test/o/oauth2/v2/auth?state=signed-state';

/** The first desktop version that carries the Mailbox row. */
const FIRST_VERSION_WITH_THE_ROW = '1.0.1';

describe('8.0x: the Mac client connects the mailbox', () => {
  it('sends connect_mailbox, opens the consent screen in the system browser, and reads the status until it connects', async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const opened: string[] = [];
    // Not connected when the row is first read, still not at the first wake-up (the
    // person is on the consent screen), connected at the second.
    const statuses: HttpAnswer[] = [
      { status: 200, body: { connected: false, mailbox: null } },
      { status: 200, body: { connected: false, mailbox: null } },
      {
        status: 200,
        body: {
          connected: true,
          mailbox: {
            id: '77777777-7777-4777-8777-777777777777',
            emailAddress: ADDRESS,
            status: 'connected',
            syncState: 'baseline_pending',
            coverageWatermarkAt: null,
            lastSyncedAt: null,
            lastSyncError: null,
          },
        },
      },
    ];
    let clock = Date.parse('2026-09-24T15:10:00.000Z');
    const bridge = createMailboxBridge({
      api: createAuthedClient({
        baseUrl: 'https://api.example.test/',
        clientVersion: FIRST_VERSION_WITH_THE_ROW,
        accessToken: async () => await Promise.resolve('token-value'),
        send: async (url, init) => {
          const path = new URL(url).pathname;
          calls.push({ method: init.method, path, body: init.body === undefined ? null : JSON.parse(init.body) });
          if (path === '/gmail/connect') {
            return await Promise.resolve({
              status: 200,
              body: {
                status: 'accepted',
                replayed: false,
                result: { authorizationUrl: CONSENT, expiresAt: new Date(clock + 600_000).toISOString() },
              },
            });
          }
          if (path === '/gmail/status') {
            return await Promise.resolve(statuses.length > 1 ? (statuses.shift() as HttpAnswer) : (statuses[0] as HttpAnswer));
          }
          return await Promise.resolve({ status: 404, body: { error: 'not_found' } });
        },
      }),
      session: { state: async () => await Promise.resolve({ online: true, mayMutate: true, device: {} }) },
      openExternally: async url => {
        opened.push(url);
        await Promise.resolve();
      },
      now: () => new Date(clock),
      sleep: async ms => {
        clock += ms;
        await Promise.resolve();
      },
    });

    // The row starts where 1.0.0 left David: no mailbox, and a button to press.
    const before = await bridge.state();
    expect(buildMailboxView(before).action).toEqual({ label: CONNECT_GMAIL_LABEL, enabled: true });
    expect(CONNECT_GMAIL_LABEL).toBe('Connect Gmail');

    const after = await bridge.connect();

    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET /gmail/status',
      'POST /gmail/connect',
      'GET /gmail/status',
      'GET /gmail/status',
    ]);
    expect(connectMailboxCommandSchema.safeParse(calls[1]?.body).success).toBe(true);
    expect(opened).toEqual([CONSENT]);
    expect(after.status?.connected).toBe(true);
    expect(buildMailboxView(after).text).toBe(`${ADDRESS} · connected · baseline pending`);
    expect(buildMailboxView(after).action).toBeNull();
    // The consent URL goes to the browser and not across the bridge.
    expect(JSON.stringify(after)).not.toContain('signed-state');
  });

  it('calls only paths the API mounts', () => {
    for (const path of Object.values(MAILBOX_API_PATHS)) expect(GMAIL_PATHS).toContain(path);
  });

  it('is a build the deployed API accepts', () => {
    // Since lane g78 the container holds a policy — a minimum, a `1.x` ceiling and a
    // list of known-bad builds — and publishes the range derived from it. The build with
    // the row is inside the published range and not on the incompatible list.
    expect(compareVersions(publishedClientVersions(CONTAINER_CLIENT_VERSIONS).maximum, FIRST_VERSION_WITH_THE_ROW)).toBeGreaterThanOrEqual(0);
    expect(mayMutate(CONTAINER_CLIENT_VERSIONS, FIRST_VERSION_WITH_THE_ROW)).toBe(true);
  });
});
