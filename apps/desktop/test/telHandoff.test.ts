import { describe, expect, it } from 'vitest';
import { createDialHandoff } from '../src/main/dialHandoff.ts';
import type { SchemeHandlers } from '../src/main/launchServices.ts';
import {
  HANDLER_PROOF_MILLISECONDS,
  createDialApi,
  createTelLaunchDriver,
  isTelUri,
  NotATelUriError,
} from '../src/main/telHandoff.ts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import type { HttpAnswer } from '../src/main/apiClient.ts';

/**
 * The `tel:` opener (specification 9.2, 14.2, 17).
 *
 * G4 proved the handoff *logic* — the ticket, the consumption, the "a failed open is
 * unknown" rule — against two ports. This is the macOS binding of those ports, and
 * three things about it are worth a test of their own:
 *
 *   * `shell.openExternal` is unreachable for anything that is not a `tel:` URI with an
 *     E.164 number, so the driver cannot become a general "open this URL as the user"
 *     primitive;
 *   * a launch-services probe that says anything but "a bundle claims tel:" is
 *     `no_tel_handler`, including the `unknown` a non-macOS host gives — an unreadable
 *     database is not a proof;
 *   * a proof older than a ticket's own sixty seconds is not a current one.
 *
 * Every number is in the NANP 555-01XX fictional block and reaches nobody.
 */

const AVAILABLE: SchemeHandlers = { kind: 'available', bundleIds: ['com.apple.mobilephone'] };
const NUMBER = '+14015550187';
const TEL = `tel:${NUMBER}`;

const FIRM_ID = '11111111-1111-4111-8111-111111111111';
const ROUTE_ID = '44444444-4444-4444-8444-444444444444';
const IDENTITY_ID = '55555555-5555-4555-8555-555555555555';
const TICKET_ID = '99999999-9999-4999-8999-999999999999';

describe('what counts as a tel: URI', () => {
  it('accepts an E.164 tel URI and nothing else', () => {
    expect(isTelUri(TEL)).toBe(true);
    for (const value of [
      'https://example.test/',
      'file:///etc/passwd',
      'x-apple-reminderkit://',
      'TEL:+14015550187',
      'tel:4015550187',
      'tel:+1 401 555 0187',
      'tel:+14015550187?call',
      // `$` also matches before a trailing newline, which is why the check is an
      // exact match and not `test()`. G4's launcher documented the same trap.
      `${TEL}\n`,
      `${TEL}\nhttps://example.test/`,
      '',
    ]) {
      expect(isTelUri(value), value).toBe(false);
    }
  });
});

describe('the driver opens tel: and refuses every other scheme', () => {
  it('never reaches the opener for a URL that is not a tel: URI', async () => {
    const opened: string[] = [];
    const driver = createTelLaunchDriver({
      probe: () => AVAILABLE,
      openExternal: async uri => {
        opened.push(uri);
        await Promise.resolve();
      },
    });
    for (const value of ['https://example.test/', 'file:///etc/passwd', 'tel:not-a-number']) {
      await expect(driver.openTelUri(value)).rejects.toBeInstanceOf(NotATelUriError);
    }
    expect(opened).toEqual([]);
  });

  it('opens a real tel: URI exactly as given', async () => {
    const opened: string[] = [];
    const driver = createTelLaunchDriver({
      probe: () => AVAILABLE,
      openExternal: async uri => {
        opened.push(uri);
        await Promise.resolve();
      },
    });
    await driver.openTelUri(TEL);
    expect(opened).toEqual([TEL]);
  });
});

describe('the setup proof', () => {
  const driverWith = (handlers: SchemeHandlers | (() => never), now = () => 1_000): ReturnType<typeof createTelLaunchDriver> =>
    createTelLaunchDriver({
      probe: typeof handlers === 'function' ? handlers : () => handlers,
      openExternal: async () => await Promise.resolve(),
      now,
    });

  it('is verified only when a bundle claims the scheme', async () => {
    expect(await driverWith(AVAILABLE).inspectVerifiedHandler()).toBe('verified');
    expect(await driverWith({ kind: 'absent' }).inspectVerifiedHandler()).toBe('unavailable');
    // Not macOS, or the database could not be read. Not a proof of anything.
    expect(await driverWith({ kind: 'unknown' }).inspectVerifiedHandler()).toBe('unavailable');
    expect(
      await driverWith(() => {
        throw new Error('lsregister is not here');
      }).inspectVerifiedHandler(),
    ).toBe('unavailable');
  });

  it('stops being current once it has outlived a ticket', async () => {
    let clock = 1_000;
    const driver = driverWith(AVAILABLE, () => clock);
    expect(driver.isVerifiedHandlerCurrent()).toBe(false);
    expect(await driver.inspectVerifiedHandler()).toBe('verified');
    expect(driver.isVerifiedHandlerCurrent()).toBe(true);
    clock += HANDLER_PROOF_MILLISECONDS;
    expect(driver.isVerifiedHandlerCurrent()).toBe(true);
    clock += 1;
    expect(driver.isVerifiedHandlerCurrent()).toBe(false);
  });

  it('forgets the proof when a later probe fails', async () => {
    let handlers: SchemeHandlers = AVAILABLE;
    const driver = createTelLaunchDriver({
      probe: () => handlers,
      openExternal: async () => await Promise.resolve(),
    });
    expect(await driver.inspectVerifiedHandler()).toBe('verified');
    handlers = { kind: 'absent' };
    expect(await driver.inspectVerifiedHandler()).toBe('unavailable');
    expect(driver.isVerifiedHandlerCurrent()).toBe(false);
  });
});

/** The two dial commands, scripted. */
function scriptedDialApi(answers: Readonly<Record<string, HttpAnswer>>): {
  readonly api: ReturnType<typeof createDialApi>;
  readonly calls: { path: string; body: Record<string, unknown> }[];
} {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const client = createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: '1.4.0',
    accessToken: async () => await Promise.resolve('token-value'),
    send: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
      return await Promise.resolve(answers[path] ?? { status: 404, body: { error: 'not_found' } });
    },
  });
  return { api: createDialApi(client), calls };
}

const accepted = (result: unknown): HttpAnswer => ({
  status: 200,
  body: { status: 'accepted', replayed: false, result },
});

describe('the handoff, end to end through the real logic', () => {
  const ticket = {
    ticketId: TICKET_ID,
    e164: NUMBER,
    firmId: FIRM_ID,
    contactId: null,
    routeId: ROUTE_ID,
    routeVersion: 3,
    callingIdentityId: IDENTITY_ID,
    issuedAt: '2026-09-21T13:00:00.000Z',
    expiresAt: '2026-09-21T13:00:45.000Z',
    firmLocalTime: '09:00',
    firmTimeZone: 'America/New_York',
  };

  it('refuses without a setup proof and never asks the server for a ticket', async () => {
    const { api, calls } = scriptedDialApi({});
    const handoff = createDialHandoff({
      driver: createTelLaunchDriver({ probe: () => ({ kind: 'absent' }), openExternal: async () => await Promise.resolve() }),
      api,
    });
    expect(await handoff.checkSetup()).toEqual({ ready: false, reason: 'no_tel_handler' });
    const outcome = await handoff.dial({
      commandId: 'cmd-authorize',
      consumeCommandId: 'cmd-consume',
      firmId: FIRM_ID,
      routeId: ROUTE_ID,
      routeVersion: 3,
      callingIdentityId: IDENTITY_ID,
    });
    expect(outcome).toEqual({ status: 'refused', reason: 'no_tel_handler' });
    // A ticket lives sixty seconds; none was spent finding out the Mac has no phone.
    expect(calls).toEqual([]);
  });

  it('authorizes, consumes and opens, with two command ids and the displayed version', async () => {
    const opened: string[] = [];
    const { api, calls } = scriptedDialApi({
      '/dial/authorize': accepted(ticket),
      '/dial/consume': accepted({ ticketId: TICKET_ID, e164: NUMBER, telUri: TEL, consumedAt: '2026-09-21T13:00:05.000Z' }),
    });
    const handoff = createDialHandoff({
      driver: createTelLaunchDriver({
        probe: () => AVAILABLE,
        openExternal: async uri => {
          opened.push(uri);
          await Promise.resolve();
        },
      }),
      api,
    });
    expect(await handoff.checkSetup()).toEqual({ ready: true });
    const outcome = await handoff.dial({
      commandId: 'cmd-authorize',
      consumeCommandId: 'cmd-consume',
      firmId: FIRM_ID,
      routeId: ROUTE_ID,
      routeVersion: 3,
      callingIdentityId: IDENTITY_ID,
    });
    // Lane g79 (C16): the handoff carries out what authorized the call, for the outcome.
    expect(outcome).toEqual({
      status: 'opened',
      e164: NUMBER,
      ticket: { ticketId: TICKET_ID, callingIdentityId: IDENTITY_ID, routeId: ROUTE_ID, contactId: null },
    });
    expect(opened).toEqual([TEL]);
    expect(calls.map(call => call.path)).toEqual(['/dial/authorize', '/dial/consume']);
    expect(calls[0]?.body['commandId']).toBe('cmd-authorize');
    expect(calls[0]?.body['routeVersion']).toBe(3);
    expect(calls[1]?.body['commandId']).toBe('cmd-consume');
  });

  it('passes a server refusal back as its own code', async () => {
    const { api } = scriptedDialApi({
      '/dial/authorize': { status: 409, body: { status: 'refused', replayed: false, reason: 'route_version_stale' } },
    });
    const handoff = createDialHandoff({
      driver: createTelLaunchDriver({ probe: () => AVAILABLE, openExternal: async () => await Promise.resolve() }),
      api,
    });
    await handoff.checkSetup();
    expect(
      await handoff.dial({
        commandId: 'cmd-authorize',
        consumeCommandId: 'cmd-consume',
        firmId: FIRM_ID,
        routeId: ROUTE_ID,
        routeVersion: 1,
        callingIdentityId: IDENTITY_ID,
      }),
    ).toEqual({ status: 'not_authorized', reason: 'route_version_stale' });
  });

  it('is `opened_unknown` when the open throws, because bytes may already have left', async () => {
    const { api } = scriptedDialApi({
      '/dial/authorize': accepted(ticket),
      '/dial/consume': accepted({ ticketId: TICKET_ID, e164: NUMBER, telUri: TEL, consumedAt: '2026-09-21T13:00:05.000Z' }),
    });
    const handoff = createDialHandoff({
      driver: createTelLaunchDriver({
        probe: () => AVAILABLE,
        openExternal: async () => {
          await Promise.resolve();
          throw new Error('the window server said no');
        },
      }),
      api,
    });
    await handoff.checkSetup();
    expect(
      await handoff.dial({
        commandId: 'cmd-authorize',
        consumeCommandId: 'cmd-consume',
        firmId: FIRM_ID,
        routeId: ROUTE_ID,
        routeVersion: 3,
        callingIdentityId: IDENTITY_ID,
      }),
    ).toEqual({
      status: 'opened_unknown',
      ticket: { ticketId: TICKET_ID, callingIdentityId: IDENTITY_ID, routeId: ROUTE_ID, contactId: null },
    });
  });
});
