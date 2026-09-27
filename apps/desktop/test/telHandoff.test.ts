import { describe, expect, it } from 'vitest';
import { createDialHandoff } from '../src/main/dialHandoff.ts';
import type { SchemeHandlers } from '../src/main/launchServices.ts';
import { HANDLER_PROOF_MILLISECONDS, createTelLaunchDriver, isTelUri, NotATelUriError } from '../src/main/telHandoff.ts';

/**
 * The `tel:` opener (specification 9.2, 14.2, 17).
 *
 * `dialHandoff.ts` proves the handoff *logic* — the setup proof, the URI check, the
 * "a failed open is unknown" rule — against one port. This is the macOS binding of that
 * port, and three things about it are worth a test of their own:
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

describe('the handoff, end to end through the real logic', () => {
  it('refuses without a setup proof, and opens nothing', async () => {
    const opened: string[] = [];
    const handoff = createDialHandoff({
      driver: createTelLaunchDriver({
        probe: () => ({ kind: 'absent' }),
        openExternal: async uri => {
          opened.push(uri);
          await Promise.resolve();
        },
      }),
    });
    expect(await handoff.checkSetup()).toEqual({ ready: false, reason: 'no_tel_handler' });
    expect(await handoff.open({ telUri: TEL, e164: NUMBER })).toEqual({ status: 'refused', reason: 'no_tel_handler' });
    expect(opened).toEqual([]);
  });

  it('opens the advised URI through the real driver, once per proof', async () => {
    const opened: string[] = [];
    const handoff = createDialHandoff({
      driver: createTelLaunchDriver({
        probe: () => AVAILABLE,
        openExternal: async uri => {
          opened.push(uri);
          await Promise.resolve();
        },
      }),
    });
    expect(await handoff.checkSetup()).toEqual({ ready: true });
    expect(await handoff.open({ telUri: TEL, e164: NUMBER })).toEqual({ status: 'opened', e164: NUMBER });
    expect(await handoff.open({ telUri: TEL, e164: NUMBER })).toEqual({ status: 'refused', reason: 'no_tel_handler' });
    expect(opened).toEqual([TEL]);
  });

  it('is `opened_unknown` when the open throws, because bytes may already have left', async () => {
    const handoff = createDialHandoff({
      driver: createTelLaunchDriver({
        probe: () => AVAILABLE,
        openExternal: async () => {
          await Promise.resolve();
          throw new Error('the window server said no');
        },
      }),
    });
    await handoff.checkSetup();
    expect(await handoff.open({ telUri: TEL, e164: NUMBER })).toEqual({ status: 'opened_unknown' });
  });

  /**
   * The driver is the last gate, and it is a different gate from the handoff's: the
   * handoff checks the URI matches the number the advice named, and the driver checks
   * the string is a `tel:` URI at all. Either alone would be enough to stop this; both
   * exist because `shell.openExternal` is one argument away from being the most useful
   * thing in this process.
   */
  it('never reaches `openExternal` with anything but a tel: URI', async () => {
    const opened: string[] = [];
    const driver = createTelLaunchDriver({
      probe: () => AVAILABLE,
      openExternal: async uri => {
        opened.push(uri);
        await Promise.resolve();
      },
    });
    await expect(driver.openTelUri('https://example.test/')).rejects.toBeInstanceOf(NotATelUriError);
    expect(opened).toEqual([]);
  });
});
