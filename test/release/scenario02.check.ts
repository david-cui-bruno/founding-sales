import { describe, expect, it } from 'vitest';
import { IDEMPOTENCY_PROTECTIONS, JOB_KINDS, JOB_KIND_PROTECTION } from '@fss/domain/jobs';
import { mustCover } from './support/coverage.ts';

/**
 * Appendix G 2: "Worker A pauses past its lease, B reclaims, A resumes: one business
 * effect, proven by fencing or uniqueness."
 *
 * Four worker suites prove it against a real PostgreSQL, through the shared
 * `runTwiceUnderStolenLease` harness: it expires the lease, lets a second worker
 * claim and finish, then lets the first one wake and try. What those suites cannot
 * show is that the *set* of handlers is covered — a new job kind whose handler leans
 * on the lease would sail past all four of them, because none of them knows the kind
 * exists. That is what this check adds: Appendix C's protection column is asserted
 * total over `JOB_KINDS`, so a kind without a protection is a red build on the day it
 * is added rather than on the day it double-sends.
 *
 * ## The vacuous-pass trap
 *
 * A stolen-lease test whose resumed worker does nothing at all reports "one effect"
 * because the handler is inert, not because the fence held; and a protection table
 * with a fourth value like `lease` would satisfy any assertion that merely asked for
 * a non-empty string. The first half is closed in the lane suites, which assert
 * `freshOutcome` completed as well as that the stale worker got `lease_lost`. The
 * second is closed here: every value is required to be one of the three
 * `IDEMPOTENCY_PROTECTIONS` specification 13.2 allows, and there is no fourth.
 */

describe('Appendix G 2: a stolen lease still produces one business effect', () => {
  mustCover(2, ['runTwiceUnderStolenLease', 'lease_lost', 'outbound_fence']);

  it('gives every job kind one of the three protections, and never the lease', () => {
    // 13.2: "Every handler is protected by business uniqueness, a monotonic fencing
    // token, or the outbound at-most-once fence." Total over the kinds, closed over
    // the values — a kind added without an entry does not typecheck, and a kind given
    // a made-up protection fails here.
    const allowed = new Set<string>(IDEMPOTENCY_PROTECTIONS);
    for (const kind of JOB_KINDS) {
      const protection: string = JOB_KIND_PROTECTION[kind];
      expect(allowed.has(protection), `${kind} carries the unknown protection ${protection}`).toBe(true);
    }
    expect(Object.keys(JOB_KIND_PROTECTION).sort()).toEqual([...JOB_KINDS].sort());
    expect(allowed.has('lease')).toBe(false);
  });

  it('protects the send with the fence rather than with uniqueness', () => {
    // The one kind whose effect cannot be rolled back. Appendix C says
    // `outbound_fence` for it, and the runner reads this value to decide whether to
    // run the handler outside the completion transaction; a rewrite to
    // `business_uniqueness` would move the send back inside it and lose the property.
    expect(JOB_KIND_PROTECTION['sequence.action']).toBe('outbound_fence');
    expect(JOB_KIND_PROTECTION['mail.reconcile']).toBe('outbound_fence');
    expect(JOB_KIND_PROTECTION['mail.watch_renew']).toBe('fencing_token');
  });
});
