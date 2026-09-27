import { describe, expect, it } from 'vitest';
import {
  HANDOFF_LIMITATION_NOTICE,
  createDialHandoff,
  unavailableDialHandoff,
  type PhoneLaunchDriver,
} from '../src/main/dialHandoff.ts';
import {
  OUTCOME_LABELS,
  OUTCOME_ORDER,
  callbackNeedsTime,
  emptyOutcomeDraft,
  logCallCommand,
  outcomeProblem,
  outcomeSuppresses,
  resolvedCallbackInstant,
  type OutcomeDraft,
} from '../src/renderer/outcomeForm.ts';
import { localInstant } from '../../../packages/domain/src/rules/localClock.ts';

/**
 * The Mac's half of 9.2 and 9.1.
 *
 * Nothing here decides anything. What is tested is that the client cannot open a `tel:`
 * URI without a setup proof and a URI the server's own advice just produced, cannot open
 * a second one on one proof, and cannot record a callback the salesperson did not
 * confirm.
 */

const E164 = '+14015550123';
const TEL = `tel:${E164}`;
const FIRM_ID = '22222222-2222-4222-8222-222222222222';
const ROUTE_ID = '33333333-3333-4333-8333-333333333333';

function workingDriver(overrides: Partial<PhoneLaunchDriver> = {}): { driver: PhoneLaunchDriver; opened: string[] } {
  const opened: string[] = [];
  const driver: PhoneLaunchDriver = {
    inspectVerifiedHandler: async () => await Promise.resolve('verified' as const),
    isVerifiedHandlerCurrent: () => true,
    openTelUri: async (uri: string) => {
      opened.push(uri);
      return await Promise.resolve();
    },
    ...overrides,
  };
  return { driver, opened };
}

const advised = { telUri: TEL, e164: E164 };

describe('the tel: handoff', () => {
  it('opens the URI the advice carried, and only after a setup proof', async () => {
    const { driver, opened } = workingDriver();
    const handoff = createDialHandoff({ driver });

    expect(await handoff.checkSetup()).toEqual({ ready: true });
    expect(await handoff.open(advised)).toEqual({ status: 'opened', e164: E164 });
    expect(opened).toEqual([TEL]);
  });

  it('refuses to open without a setup proof', async () => {
    const { driver, opened } = workingDriver();
    const handoff = createDialHandoff({ driver });

    expect(await handoff.open(advised)).toEqual({ status: 'refused', reason: 'no_tel_handler' });
    expect(opened).toEqual([]);
  });

  it('refuses when no tel: handler is registered', async () => {
    const { driver } = workingDriver({ inspectVerifiedHandler: async () => await Promise.resolve('unavailable' as const) });
    const handoff = createDialHandoff({ driver });
    expect(await handoff.checkSetup()).toEqual({ ready: false, reason: 'no_tel_handler' });
    expect(await handoff.open(advised)).toEqual({ status: 'refused', reason: 'no_tel_handler' });
  });

  it('refuses when the handler changed between the proof and the open', async () => {
    const { driver, opened } = workingDriver({ isVerifiedHandlerCurrent: () => false });
    const handoff = createDialHandoff({ driver });
    expect(await handoff.checkSetup()).toEqual({ ready: true });
    expect(await handoff.open(advised)).toEqual({ status: 'refused', reason: 'handler_changed' });
    expect(opened).toEqual([]);
  });

  it('arms exactly one handoff: a second open needs a second proof', async () => {
    const { driver, opened } = workingDriver();
    const handoff = createDialHandoff({ driver });

    await handoff.checkSetup();
    expect((await handoff.open(advised)).status).toBe('opened');
    expect(await handoff.open(advised)).toEqual({ status: 'refused', reason: 'no_tel_handler' });
    expect(opened).toHaveLength(1);
  });

  it('cannot be re-armed by an inspection that resolves after the open', async () => {
    let release = (): void => undefined;
    const slow = new Promise<void>(resolve => {
      release = resolve;
    });
    const { driver, opened } = workingDriver({
      inspectVerifiedHandler: async () => {
        await slow;
        return 'verified' as const;
      },
    });
    const handoff = createDialHandoff({ driver });

    const pending = handoff.checkSetup();
    // The open happens while the inspection is still in flight: unarmed, refused.
    expect(await handoff.open(advised)).toEqual({ status: 'refused', reason: 'no_tel_handler' });
    release();
    // And the late answer does not arm the attempt that already failed.
    expect(await pending).toEqual({ ready: false, reason: 'handler_changed' });
    expect(await handoff.open(advised)).toEqual({ status: 'refused', reason: 'no_tel_handler' });
    expect(opened).toEqual([]);
  });

  it('refuses a number in a shape a URI must not carry', async () => {
    const { driver, opened } = workingDriver();
    // A trailing newline: `/^\+[1-9][0-9]{7,14}$/.test()` accepts this in JavaScript,
    // which is the bug the exact-match check exists to stop.
    const handoff = createDialHandoff({ driver });
    await handoff.checkSetup();
    expect(await handoff.open({ e164: `${E164}\n`, telUri: `${TEL}\n` })).toEqual({
      status: 'refused',
      reason: 'invalid_target',
    });
    expect(opened).toEqual([]);
  });

  it('refuses a URI that does not match the number the advice named', async () => {
    const { driver, opened } = workingDriver();
    const handoff = createDialHandoff({ driver });
    await handoff.checkSetup();
    expect(await handoff.open({ e164: E164, telUri: 'tel:+14015550199' })).toEqual({
      status: 'refused',
      reason: 'invalid_target',
    });
    expect(opened).toEqual([]);
  });

  it('calls a failed open unknown, because bytes may already have left', async () => {
    const rejecting = workingDriver({ openTelUri: async () => await Promise.reject(new Error('no handler')) });
    const handoff = createDialHandoff({ driver: rejecting.driver });
    await handoff.checkSetup();
    expect(await handoff.open(advised)).toEqual({ status: 'opened_unknown' });

    const throwing = workingDriver({
      openTelUri: () => {
        throw new Error('window server gone');
      },
    });
    const second = createDialHandoff({ driver: throwing.driver });
    await second.checkSetup();
    expect(await second.open(advised)).toEqual({ status: 'opened_unknown' });
  });

  it('states the limitation 9.2 asks the product to state', () => {
    expect(HANDOFF_LIMITATION_NOTICE).toContain('cannot recall');
  });

  it('has a build that opens nothing', async () => {
    const handoff = unavailableDialHandoff();
    expect(await handoff.checkSetup()).toEqual({ ready: false, reason: 'no_tel_handler' });
    expect(await handoff.open(advised)).toEqual({ status: 'refused', reason: 'no_tel_handler' });
  });
});

describe('the outcome form', () => {
  const draftWith = (patch: Partial<OutcomeDraft>): OutcomeDraft => ({ ...emptyOutcomeDraft(), ...patch });

  it('offers the ten outcomes of 9.1 and a sentence for each', () => {
    expect(OUTCOME_ORDER).toHaveLength(10);
    for (const outcome of OUTCOME_ORDER) expect(OUTCOME_LABELS[outcome].length).toBeGreaterThan(0);
  });

  it('refuses a draft with no outcome', () => {
    expect(outcomeProblem(emptyOutcomeDraft())).toBe('outcome_missing');
  });

  it('records a callback request with no day as one that needs a time (lane g79, C13)', () => {
    const noDay = draftWith({ outcome: 'callback_requested' });
    expect(outcomeProblem(noDay)).toBeNull();
    expect(callbackNeedsTime(noDay)).toBe(true);
    const built = logCallCommand({ commandId: 'cmd-0', clientVersion: '1.4.0', firmId: FIRM_ID, draft: noDay });
    if (!('command' in built)) throw new Error('expected a command');
    // No callback travels, and no `occurredAt`: the server records it now (C15).
    expect(built.command.callback).toBeUndefined();
    expect(built.command.occurredAt).toBeUndefined();
  });

  it('refuses a time with no day, a day that is not one, and a zone it cannot place', () => {
    expect(outcomeProblem(draftWith({ outcome: 'callback_requested', callbackLocalTime: '14:00' }))).toBe(
      'callback_date_missing',
    );
    expect(outcomeProblem(draftWith({ outcome: 'callback_requested', callbackLocalDate: 'next tuesday' }))).toBe(
      'callback_date_invalid',
    );
    expect(
      outcomeProblem(
        draftWith({ outcome: 'callback_requested', callbackLocalDate: '2026-09-22', callbackLocalTime: '2pm' }),
      ),
    ).toBe('callback_time_invalid');
    expect(
      outcomeProblem(
        draftWith({ outcome: 'callback_requested', callbackLocalDate: '2026-09-22', callbackLocalTime: '14:00' }),
      ),
    ).toBe('callback_zone_missing');
    expect(
      outcomeProblem(
        draftWith({
          outcome: 'callback_requested',
          callbackLocalDate: '2026-09-22',
          callbackLocalTime: '14:00',
          callbackTimeZone: 'Mars/Olympus',
        }),
      ),
    ).toBe('callback_instant_unconfirmed');
  });

  it('resolves a DST gap exactly as the domain clock does (lane g79, C18)', () => {
    // 02:30 on 8 March 2026 does not exist in New York. The domain resolves it forward
    // to 03:30 EDT (docs/decisions/g0-dst-gap-resolution.md); the Mac used to say 01:30.
    const gap = draftWith({
      outcome: 'callback_requested',
      callbackLocalDate: '2026-03-08',
      callbackLocalTime: '02:30',
      callbackTimeZone: 'America/New_York',
    });
    const domain = localInstant('2026-03-08', { hour: 2, minute: 30 }, 'America/New_York');
    expect(resolvedCallbackInstant(gap)).toBe(domain);
    expect(resolvedCallbackInstant(gap)).toBe('2026-03-08T07:30:00.000Z');
    // A day with no hour resolves at 09:00 local, the one constant both sides read.
    expect(
      resolvedCallbackInstant(draftWith({ ...gap, callbackLocalDate: '2026-09-22', callbackLocalTime: '' })),
    ).toBe('2026-09-22T13:00:00.000Z');
  });

  it('accepts a confirmed callback and carries all four of Appendix D pieces', () => {
    const draft = draftWith({
      outcome: 'callback_requested',
      callbackLocalDate: '2026-09-22',
      callbackLocalTime: '14:00',
      callbackTimeZone: 'America/New_York',
    });
    expect(outcomeProblem(draft)).toBeNull();

    const built = logCallCommand({
      commandId: 'cmd-1',
      clientVersion: '1.4.0',
      firmId: FIRM_ID,
      itemId: '55555555-5555-4555-8555-555555555555',
      draft,
    });
    expect('command' in built).toBe(true);
    if (!('command' in built)) return;
    expect(built.command.callback).toEqual({
      localDate: '2026-09-22',
      localTime: '14:00',
      dueAt: '2026-09-22T18:00:00.000Z',
      sourceTimeZone: 'America/New_York',
    });
    expect(built.command.itemId).toBe('55555555-5555-4555-8555-555555555555');
  });

  it('says how wide a do-not-call suppression will be, and sends the same answer', () => {
    const number = draftWith({ outcome: 'do_not_call' });
    const firm = draftWith({ outcome: 'do_not_call', doNotCallCoversAllContact: true });
    expect(outcomeSuppresses(emptyOutcomeDraft())).toBe('none');
    expect(outcomeSuppresses(number)).toBe('number');
    expect(outcomeSuppresses(firm)).toBe('firm');

    const built = logCallCommand({
      commandId: 'cmd-2',
      clientVersion: '1.4.0',
      firmId: FIRM_ID,
      occurredAt: '2026-09-16T14:05:00.000Z',
      draft: firm,
    });
    if (!('command' in built)) throw new Error('expected a command');
    expect(built.command.doNotCallCoversAllContact).toBe(true);
  });

  it('omits the callback and the suppression scope from every other outcome', () => {
    const built = logCallCommand({
      commandId: 'cmd-3',
      clientVersion: '1.4.0',
      firmId: FIRM_ID,
      routeId: ROUTE_ID,
      occurredAt: '2026-09-16T14:05:00.000Z',
      draft: draftWith({
        outcome: 'voicemail_left',
        note: 'left a message',
        // Left over in the form from an earlier click; it must not travel.
        callbackLocalDate: '2026-09-22',
        doNotCallCoversAllContact: true,
      }),
    });
    if (!('command' in built)) throw new Error('expected a command');
    expect(built.command.callback).toBeUndefined();
    expect(built.command.doNotCallCoversAllContact).toBeUndefined();
    expect(built.command.routeId).toBe(ROUTE_ID);
    expect(built.command.note).toBe('left a message');
  });

  it('returns the problem instead of a command when the draft is not recordable', () => {
    const built = logCallCommand({
      commandId: 'cmd-4',
      clientVersion: '1.4.0',
      firmId: FIRM_ID,
      occurredAt: '2026-09-16T14:05:00.000Z',
      draft: emptyOutcomeDraft(),
    });
    expect(built).toEqual({ problem: 'outcome_missing' });
  });
});
