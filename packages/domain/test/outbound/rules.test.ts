import { describe, expect, it } from 'vitest';
import {
  RAMP_ADMIN_RAISE_LIMIT,
  RAMP_HARD_CEILING,
  RAMP_RAISE_HEALTHY_STREAK,
  RAMP_SETTLED_CAP,
  RAMP_SETTLED_DAY,
  RECONCILE_BACKOFF_SECONDS,
  deterministicMessageId,
  effectiveDailyCap,
  fenceIdOfMessageId,
  raiseAllowance,
  raiseRefusal,
  rampHealthFailure,
  reconcileBackoffSeconds,
  renderedHash,
  scheduledCap,
  type RampRow,
} from '../../outbound/index.ts';

/**
 * The rules of 12.7 that need no database.
 *
 * The ramp table is the part of this lane a reader is most likely to check against
 * the specification by eye, so it is asserted row by row rather than by a formula
 * that happens to agree.
 */

const ramp = (overrides: Partial<RampRow> = {}): RampRow => ({
  id: 'ramp',
  mailboxId: 'mailbox',
  healthySendingDays: 0,
  lastAdvancedOn: null,
  adminDailyCap: null,
  raisedDailyCap: null,
  lastHealthFailure: null,
  ...overrides,
});

describe('the reputation ramp (12.7)', () => {
  it('is 12.7’s table, day by day', () => {
    // "First 5 sending days | 5"
    expect([0, 1, 2, 3, 4].map(scheduledCap)).toEqual([5, 5, 5, 5, 5]);
    // "Next 5 sending days | 10"
    expect([5, 6, 9].map(scheduledCap)).toEqual([10, 10, 10]);
    // "Next 5 sending days | 15"
    expect([10, 14].map(scheduledCap)).toEqual([15, 15]);
    // "Next 5 sending days | 25"
    expect([15, 19].map(scheduledCap)).toEqual([25, 25]);
    // "Weeks 5-6 | 35" — sending days 21 to 30, which is the same span.
    expect([20, 29].map(scheduledCap)).toEqual([35, 35]);
    // "After six healthy weeks | 50"
    expect([30, 60, 500].map(scheduledCap)).toEqual([50, 50, 50]);
    expect(scheduledCap(30)).toBe(RAMP_SETTLED_CAP);
  });

  it('lets an admin lower but never raise through the lowering column', () => {
    expect(effectiveDailyCap(ramp({ healthySendingDays: 40 }))).toBe(50);
    // Lowering wins.
    expect(effectiveDailyCap(ramp({ healthySendingDays: 40, adminDailyCap: 3 }))).toBe(3);
    // Raising through the lowering column does not: the schedule still governs.
    expect(effectiveDailyCap(ramp({ healthySendingDays: 0, adminDailyCap: 90 }))).toBe(5);
  });

  it('lets an earned raise replace the schedule, and the minimum still wins', () => {
    const settled = { healthySendingDays: 40, raisedDailyCap: 75 };
    expect(effectiveDailyCap(ramp(settled), RAMP_RAISE_HEALTHY_STREAK)).toBe(75);
    // An admin who raised last month and lowers today means today.
    expect(effectiveDailyCap(ramp({ ...settled, adminDailyCap: 10 }), RAMP_RAISE_HEALTHY_STREAK)).toBe(10);
  });

  it('S06: a stored raise never lifts a mailbox above what the schedule allows it that day', () => {
    // The bypass, as the audit found it: a raise to 75 on a mailbox's first day.
    // Whatever the column says, day zero is five.
    expect(effectiveDailyCap(ramp({ healthySendingDays: 0, raisedDailyCap: 75 }))).toBe(5);
    expect(effectiveDailyCap(ramp({ healthySendingDays: 0, raisedDailyCap: 75 }), RAMP_RAISE_HEALTHY_STREAK)).toBe(5);
    // One day short of settling is still the schedule's thirty-five.
    expect(effectiveDailyCap(ramp({ healthySendingDays: RAMP_SETTLED_DAY - 1, raisedDailyCap: 75 }), 30)).toBe(35);
    // Settled, but the last sending days were not all healthy: the schedule's fifty.
    expect(
      effectiveDailyCap(ramp({ healthySendingDays: 40, raisedDailyCap: 75 }), RAMP_RAISE_HEALTHY_STREAK - 1),
    ).toBe(RAMP_SETTLED_CAP);
    // A "raise" below the schedule is the admin's choice and is honoured as written.
    expect(effectiveDailyCap(ramp({ healthySendingDays: 12, raisedDailyCap: 10 }), 0)).toBe(10);
  });

  it('S06: names the part of the sustained-health rule a raise has not met', () => {
    expect(RAMP_SETTLED_DAY).toBe(30);
    expect(scheduledCap(RAMP_SETTLED_DAY)).toBe(RAMP_SETTLED_CAP);
    expect(raiseRefusal({ healthySendingDays: 0 }, RAMP_RAISE_HEALTHY_STREAK)).toBe('ramp_not_settled');
    expect(raiseRefusal({ healthySendingDays: RAMP_SETTLED_DAY - 1 }, 50)).toBe('ramp_not_settled');
    expect(raiseRefusal({ healthySendingDays: RAMP_SETTLED_DAY }, RAMP_RAISE_HEALTHY_STREAK - 1)).toBe(
      'health_not_sustained',
    );
    expect(raiseRefusal({ healthySendingDays: RAMP_SETTLED_DAY }, RAMP_RAISE_HEALTHY_STREAK)).toBeNull();
    expect(raiseAllowance({ healthySendingDays: 12 }, 0)).toBe(15);
    expect(raiseAllowance({ healthySendingDays: 40 }, RAMP_RAISE_HEALTHY_STREAK)).toBe(RAMP_ADMIN_RAISE_LIMIT);
  });

  it('never exceeds 12.7’s hard ceiling, whatever the columns say', () => {
    // The column's CHECK allows 100; the command allows 75; the cap in force is 75.
    expect(
      effectiveDailyCap(ramp({ healthySendingDays: 40, raisedDailyCap: RAMP_HARD_CEILING }), RAMP_RAISE_HEALTHY_STREAK),
    ).toBe(RAMP_ADMIN_RAISE_LIMIT);
    expect(RAMP_ADMIN_RAISE_LIMIT).toBeLessThan(RAMP_HARD_CEILING);
  });

  it('advances only on 12.7’s health conditions, and names the one that failed', () => {
    const healthy = {
      authenticationPasses: true,
      coverageHealthy: true,
      providerWarning: false,
      automatedSent: 40,
      bounces: 0,
      optOuts: 0,
      providerErrors: 0,
    };
    expect(rampHealthFailure(healthy)).toBeNull();
    expect(rampHealthFailure({ ...healthy, authenticationPasses: false })).toBe('authentication_failing');
    expect(rampHealthFailure({ ...healthy, coverageHealthy: false })).toBe('coverage_unhealthy');
    expect(rampHealthFailure({ ...healthy, providerWarning: true })).toBe('provider_warning');
    expect(rampHealthFailure({ ...healthy, providerErrors: 1 })).toBe('provider_warning');
    expect(rampHealthFailure({ ...healthy, bounces: 3 })).toBe('bounce_rate');
    expect(rampHealthFailure({ ...healthy, optOuts: 5 })).toBe('opt_out_rate');
    // A day with no automated sends is not a sending day either way.
    expect(rampHealthFailure({ ...healthy, automatedSent: 0 })).toBe('no_sends');
  });

  it('does not stall a new mailbox on one unlucky bounce', () => {
    const smallDay = {
      authenticationPasses: true,
      coverageHealthy: true,
      providerWarning: false,
      automatedSent: 5,
      bounces: 1,
      optOuts: 0,
      providerErrors: 0,
    };
    // One in five is twenty per cent, and on a five-send day that is one bad address.
    expect(rampHealthFailure(smallDay)).toBeNull();
    expect(rampHealthFailure({ ...smallDay, bounces: 2 })).toBe('bounce_rate');
  });
});

describe('the fence identifiers (Appendix B)', () => {
  it('derives a Message-ID from the fence and reads it back', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const header = deterministicMessageId(id, 'sending.example.test');
    expect(header).toBe('<fss.11111111-2222-4333-8444-555555555555@sending.example.test>');
    expect(fenceIdOfMessageId(header)).toBe(id);
    // Somebody else's Message-ID is not ours, and saying so is how a Sent search
    // avoids claiming a message FSS did not send.
    expect(fenceIdOfMessageId('<CAF=abc@mail.example.test>')).toBeNull();
  });

  it('hashes the bytes that leave, not the template they came from', () => {
    const first = renderedHash('Subject', 'Body');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(renderedHash('Subject', 'Body')).toBe(first);
    expect(renderedHash('Subject', 'Body ')).not.toBe(first);
  });
});

describe('the observation backoff (Appendix B)', () => {
  it('starts close together and backs off, then holds steady', () => {
    expect(reconcileBackoffSeconds(1)).toBe(RECONCILE_BACKOFF_SECONDS[0]);
    expect(reconcileBackoffSeconds(2)).toBe(RECONCILE_BACKOFF_SECONDS[1]);
    const last = RECONCILE_BACKOFF_SECONDS[RECONCILE_BACKOFF_SECONDS.length - 1];
    expect(reconcileBackoffSeconds(RECONCILE_BACKOFF_SECONDS.length)).toBe(last);
    // The window ends the question, not the attempt count, so the last delay repeats.
    expect(reconcileBackoffSeconds(99)).toBe(last);
    // A nonsensical attempt number still produces a usable delay.
    expect(reconcileBackoffSeconds(0)).toBe(RECONCILE_BACKOFF_SECONDS[0]);
  });

  it('is strictly increasing, so a lagging Sent index is not hammered', () => {
    for (let index = 1; index < RECONCILE_BACKOFF_SECONDS.length; index += 1) {
      expect(reconcileBackoffSeconds(index + 1)).toBeGreaterThan(reconcileBackoffSeconds(index));
    }
  });
});
