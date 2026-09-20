import { describe, expect, it } from 'vitest';
import { OUTBOUND_STATES, TERMINAL_OUTBOUND_STATES } from '@fss/domain/outbound';
import { mustCover, readRepositoryFile } from './support/coverage.ts';

/**
 * Appendix G 5: "Gmail accepts a Message-ID and drops the response; the Sent search
 * misses then finds; permanent absence ends unknown without resend."
 *
 * The outbound lane runs all three halves against a real fence and a recorded Gmail
 * fake: the indeterminate send, the lagging Sent index, and the observation window
 * expiring. What it cannot show on its own is that "ends unknown" is a *terminal*
 * position in the state machine rather than a label somebody chose — a fence that
 * could crawl back out of `unknown_terminal` would still pass every one of those
 * tests, because none of them asks afterwards.
 *
 * ## The vacuous-pass trap
 *
 * A Gmail fake that never indexes the message makes "no resend" true for the wrong
 * reason: nothing ever succeeded, so there was nothing to resend. The lane fixture
 * closes that by using `indeterminate_but_delivered` with a `sentIndexingDelay`, so
 * the message really is in the Sent folder and really is found late — the reconcile
 * returns `still_unknown` twice and `sent` on the third pass. Here the complement is
 * closed structurally: `unknown_terminal` is asserted to be in the terminal set, and
 * the transition into it is asserted to be gated on the database's own clock, so a
 * caller cannot talk the window into expiring early and manufacture the terminal
 * state it then claims to be honouring.
 */

describe('Appendix G 5: an accepted send with no answer settles without a second send', () => {
  mustCover(5, ['indeterminate_but_delivered', 'sentIndexingDelay', 'still_unknown']);

  it('makes sent and unknown_terminal the only ends of the machine', () => {
    expect([...TERMINAL_OUTBOUND_STATES].sort()).toEqual(['sent', 'unknown_terminal']);
    // The in-doubt states are emphatically not terminal: a fence stuck in
    // `reconciling` still has an observation scheduled, and one in `dispatching` is
    // the state Appendix B says must never be left alone.
    for (const state of ['prepared', 'held', 'dispatching', 'reconciling'] as const) {
      expect(OUTBOUND_STATES).toContain(state);
      expect(TERMINAL_OUTBOUND_STATES.has(state), `${state} must not be terminal`).toBe(false);
    }
  });

  it('lets only the database clock declare the observation over', () => {
    const fence = readRepositoryFile('packages/domain/outbound/fence.ts');
    const body = fence.slice(
      fence.indexOf('export async function markUnknownTerminal'),
      fence.indexOf('export async function holdFence'),
    );
    expect(body.length).toBeGreaterThan(0);
    // Without this predicate a worker with a fast clock could mark a fence terminal
    // while Gmail was still holding the message, and "never resend" would start
    // meaning "never deliver".
    expect(body).toContain("state = 'reconciling'");
    expect(body).toContain('reconcile_deadline_at <= now()');
  });
});
