import { describe, expect, it } from 'vitest';
import {
  HANDOFF_LIMITATION_NOTICE,
  createDialHandoff,
  unavailableDialHandoff,
  type DialApi,
  type PhoneLaunchDriver,
} from '../src/main/dialHandoff.ts';
import {
  OUTCOME_LABELS,
  OUTCOME_ORDER,
  emptyOutcomeDraft,
  logCallCommand,
  outcomeProblem,
  outcomeSuppresses,
  type OutcomeDraft,
} from '../src/renderer/outcomeForm.ts';

/**
 * The Mac's half of 9.2 and 9.1.
 *
 * Nothing here decides anything. What is tested is that the client cannot open a
 * `tel:` URI without a live server-issued ticket, cannot reuse one, and cannot
 * record a callback the salesperson did not confirm.
 */

const TICKET = {
  ticketId: '11111111-1111-4111-8111-111111111111',
  e164: '+14015550123',
  firmId: '22222222-2222-4222-8222-222222222222',
  contactId: null,
  routeId: '33333333-3333-4333-8333-333333333333',
  routeVersion: 1,
  callingIdentityId: '44444444-4444-4444-8444-444444444444',
  issuedAt: '2026-09-16T14:00:00.000Z',
  expiresAt: '2026-09-16T14:01:00.000Z',
  firmLocalTime: '10:00',
  firmTimeZone: 'America/New_York',
} as const;

const CONSUMED = {
  ticketId: TICKET.ticketId,
  e164: TICKET.e164,
  consumedAt: '2026-09-16T14:00:05.000Z',
  telUri: 'tel:+14015550123',
} as const;

function workingApi(overrides: Partial<DialApi> = {}): { api: DialApi; calls: { authorize: number; consume: number } } {
  const calls = { authorize: 0, consume: 0 };
  const api: DialApi = {
    authorize: async () => {
      calls.authorize += 1;
      return await Promise.resolve({ ok: true as const, ticket: TICKET });
    },
    consume: async () => {
      calls.consume += 1;
      return await Promise.resolve({ ok: true as const, consumed: CONSUMED });
    },
    ...overrides,
  };
  return { api, calls };
}

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

const dialInput = {
  commandId: 'cmd-authorize',
  consumeCommandId: 'cmd-consume',
  firmId: TICKET.firmId,
  routeId: TICKET.routeId,
  routeVersion: 1,
  callingIdentityId: TICKET.callingIdentityId,
};

describe('the tel: handoff', () => {
  it('opens only after a setup proof, and consumes the ticket first', async () => {
    const { driver, opened } = workingDriver();
    const { api, calls } = workingApi();
    const handoff = createDialHandoff({ driver, api });

    expect(await handoff.checkSetup()).toEqual({ ready: true });
    const outcome = await handoff.dial(dialInput);

    expect(outcome).toEqual({ status: 'opened', e164: '+14015550123' });
    expect(opened).toEqual(['tel:+14015550123']);
    expect(calls).toEqual({ authorize: 1, consume: 1 });
  });

  it('refuses to dial without a setup proof, and never asks the server for a ticket', async () => {
    const { driver, opened } = workingDriver();
    const { api, calls } = workingApi();
    const handoff = createDialHandoff({ driver, api });

    expect(await handoff.dial(dialInput)).toEqual({ status: 'refused', reason: 'no_tel_handler' });
    expect(opened).toEqual([]);
    // A ticket lives sixty seconds. Minting one and then discovering there is no
    // phone app would have spent it for nothing.
    expect(calls).toEqual({ authorize: 0, consume: 0 });
  });

  it('refuses when no tel: handler is registered', async () => {
    const { driver } = workingDriver({ inspectVerifiedHandler: async () => await Promise.resolve('unavailable' as const) });
    const { api } = workingApi();
    const handoff = createDialHandoff({ driver, api });
    expect(await handoff.checkSetup()).toEqual({ ready: false, reason: 'no_tel_handler' });
    expect(await handoff.dial(dialInput)).toEqual({ status: 'refused', reason: 'no_tel_handler' });
  });

  it('refuses when the handler changed between the proof and the dial', async () => {
    const { driver, opened } = workingDriver({ isVerifiedHandlerCurrent: () => false });
    const { api, calls } = workingApi();
    const handoff = createDialHandoff({ driver, api });
    expect(await handoff.checkSetup()).toEqual({ ready: true });
    expect(await handoff.dial(dialInput)).toEqual({ status: 'refused', reason: 'handler_changed' });
    expect(opened).toEqual([]);
    expect(calls.authorize).toBe(0);
  });

  it('arms exactly one handoff: a second dial needs a second proof', async () => {
    const { driver, opened } = workingDriver();
    const { api } = workingApi();
    const handoff = createDialHandoff({ driver, api });

    await handoff.checkSetup();
    expect((await handoff.dial(dialInput)).status).toBe('opened');
    expect(await handoff.dial(dialInput)).toEqual({ status: 'refused', reason: 'no_tel_handler' });
    expect(opened).toHaveLength(1);
  });

  it('cannot be re-armed by an inspection that resolves after the dial', async () => {
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
    const { api } = workingApi();
    const handoff = createDialHandoff({ driver, api });

    const pending = handoff.checkSetup();
    // The dial happens while the inspection is still in flight: unarmed, refused.
    expect(await handoff.dial(dialInput)).toEqual({ status: 'refused', reason: 'no_tel_handler' });
    release();
    // And the late answer does not arm the attempt that already failed.
    expect(await pending).toEqual({ ready: false, reason: 'handler_changed' });
    expect(await handoff.dial(dialInput)).toEqual({ status: 'refused', reason: 'no_tel_handler' });
    expect(opened).toEqual([]);
  });

  it('reports the server refusal rather than inventing one', async () => {
    const { driver, opened } = workingDriver();
    const { api } = workingApi({
      authorize: async () => await Promise.resolve({ ok: false as const, reason: 'firm_suppressed' }),
    });
    const handoff = createDialHandoff({ driver, api });
    await handoff.checkSetup();
    expect(await handoff.dial(dialInput)).toEqual({ status: 'not_authorized', reason: 'firm_suppressed' });
    expect(opened).toEqual([]);
  });

  it('never opens on a consumption that was refused', async () => {
    const { driver, opened } = workingDriver();
    const { api } = workingApi({
      consume: async () => await Promise.resolve({ ok: false as const, reason: 'already_consumed' }),
    });
    const handoff = createDialHandoff({ driver, api });
    await handoff.checkSetup();
    expect(await handoff.dial(dialInput)).toEqual({ status: 'not_authorized', reason: 'already_consumed' });
    expect(opened).toEqual([]);
  });

  it('refuses a number the server sent in a shape a URI must not carry', async () => {
    const { driver, opened } = workingDriver();
    // A trailing newline: `/^\+[1-9][0-9]{7,14}$/.test()` accepts this in JavaScript,
    // which is the bug the old launcher's exact-match check existed to stop.
    const { api } = workingApi({
      consume: async () =>
        await Promise.resolve({
          ok: true as const,
          consumed: { ...CONSUMED, e164: '+14015550123\n', telUri: 'tel:+14015550123\n' },
        }),
    });
    const handoff = createDialHandoff({ driver, api });
    await handoff.checkSetup();
    expect(await handoff.dial(dialInput)).toEqual({ status: 'refused', reason: 'invalid_target' });
    expect(opened).toEqual([]);
  });

  it('refuses a URI that does not match the number on the ticket', async () => {
    const { driver, opened } = workingDriver();
    const { api } = workingApi({
      consume: async () =>
        await Promise.resolve({ ok: true as const, consumed: { ...CONSUMED, telUri: 'tel:+14015559999' } }),
    });
    const handoff = createDialHandoff({ driver, api });
    await handoff.checkSetup();
    expect(await handoff.dial(dialInput)).toEqual({ status: 'refused', reason: 'invalid_target' });
    expect(opened).toEqual([]);
  });

  it('calls a failed open unknown, because bytes may already have left', async () => {
    const rejecting = workingDriver({ openTelUri: async () => await Promise.reject(new Error('no handler')) });
    const { api } = workingApi();
    const handoff = createDialHandoff({ driver: rejecting.driver, api });
    await handoff.checkSetup();
    expect(await handoff.dial(dialInput)).toEqual({ status: 'opened_unknown' });

    const throwing = workingDriver({
      openTelUri: () => {
        throw new Error('window server gone');
      },
    });
    const second = createDialHandoff({ driver: throwing.driver, api: workingApi().api });
    await second.checkSetup();
    expect(await second.dial(dialInput)).toEqual({ status: 'opened_unknown' });
  });

  it('states the limitation 9.2 asks the product to state', () => {
    expect(HANDOFF_LIMITATION_NOTICE).toContain('cannot recall');
  });

  it('has a build that opens nothing', async () => {
    const handoff = unavailableDialHandoff();
    expect(await handoff.checkSetup()).toEqual({ ready: false, reason: 'no_tel_handler' });
    expect(await handoff.dial(dialInput)).toEqual({ status: 'refused', reason: 'no_tel_handler' });
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

  it('refuses a callback without the day, the zone or the confirmed instant', () => {
    expect(outcomeProblem(draftWith({ outcome: 'callback_requested' }))).toBe('callback_date_missing');
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
          callbackTimeZone: 'America/New_York',
        }),
      ),
    ).toBe('callback_instant_unconfirmed');
  });

  it('accepts a confirmed callback and carries all four of Appendix D pieces', () => {
    const draft = draftWith({
      outcome: 'callback_requested',
      callbackLocalDate: '2026-09-22',
      callbackLocalTime: '14:00',
      callbackTimeZone: 'America/New_York',
      callbackDueAt: '2026-09-22T18:00:00.000Z',
    });
    expect(outcomeProblem(draft)).toBeNull();

    const built = logCallCommand({
      commandId: 'cmd-1',
      clientVersion: '1.4.0',
      firmId: TICKET.firmId,
      occurredAt: '2026-09-16T14:05:00.000Z',
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
      firmId: TICKET.firmId,
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
      firmId: TICKET.firmId,
      routeId: TICKET.routeId,
      ticketId: TICKET.ticketId,
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
    expect(built.command.ticketId).toBe(TICKET.ticketId);
    expect(built.command.note).toBe('left a message');
  });

  it('returns the problem instead of a command when the draft is not recordable', () => {
    const built = logCallCommand({
      commandId: 'cmd-4',
      clientVersion: '1.4.0',
      firmId: TICKET.firmId,
      occurredAt: '2026-09-16T14:05:00.000Z',
      draft: emptyOutcomeDraft(),
    });
    expect(built).toEqual({ problem: 'outcome_missing' });
  });
});
