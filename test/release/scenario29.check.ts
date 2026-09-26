import { describe, expect, it } from 'vitest';
import { MANUAL_SUPPRESSION_CORRECTION_MILLISECONDS, mayCorrectSuppression } from '@fss/domain';
import { MANUAL_SUPPRESSION_CORRECTION_SECONDS } from '@fss/contracts';

/**
 * Appendix G 29: "A manual suppression corrects at 9:59 while the finalizer races;
 * correction or finalization wins atomically, never contact during the window."
 *
 * The policy suite runs the race for real — two connections, two transactions, and an
 * assertion that exactly one of them wrote — and the worker suite runs the finalizer
 * under a stolen lease. This check adds the boundary the race is about. Both sides
 * measure the same ten minutes, and the deadline is exclusive: at exactly ten minutes
 * the finalizer owns the event and the correction is too late.
 *
 * ## The vacuous-pass trap
 *
 * Running the correction and the finalizer one after the other never races: the
 * second one finds the first one's outcome and reports it politely, and the suite
 * reports "exactly one won" without ever having had two. The lane test closes that by
 * running both in concurrent transactions on separate sessions. The trap left here is
 * an off-by-one at the boundary — an inclusive deadline would let a correction land
 * at exactly 10:00, when the finalizer is already entitled to the row — and a second
 * copy of the duration drifting away from the first.
 */

describe('Appendix G 29: one exclusive ten-minute deadline, agreed by both racers', () => {
  it('is the same ten minutes on the server and in the contract', () => {
    expect(MANUAL_SUPPRESSION_CORRECTION_MILLISECONDS).toBe(10 * 60 * 1000);
    expect(MANUAL_SUPPRESSION_CORRECTION_SECONDS * 1000).toBe(MANUAL_SUPPRESSION_CORRECTION_MILLISECONDS);
  });

  it('allows the correction at 9:59 and refuses it at 10:00 exactly', () => {
    const recordedAt = '2026-09-21T13:00:00.000Z';
    const actorUserId = '11111111-2222-4333-8444-555555555555';
    const event = { source: 'salesperson_manual', actorUserId, recordedAt } as const;

    // 9:59 — the salesperson is still inside their own window.
    expect(mayCorrectSuppression({ event, actorUserId, now: '2026-09-21T13:09:59.000Z' })).toEqual({ allowed: true });
    // 10:00 exactly — the finalizer owns it. An inclusive deadline here would let
    // both sides believe they had won, which is the whole of the scenario.
    expect(mayCorrectSuppression({ event, actorUserId, now: '2026-09-21T13:10:00.000Z' })).toEqual({
      allowed: false,
      refusal: 'window_expired',
    });
    expect(mayCorrectSuppression({ event, actorUserId, now: '2026-09-21T13:10:00.001Z' })).toEqual({
      allowed: false,
      refusal: 'window_expired',
    });
  });
});
