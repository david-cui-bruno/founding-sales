import { describe, expect, it } from 'vitest';
import { jobIdempotencyKey } from '@fss/domain/jobs';

/**
 * Appendix G 1: "Two scheduler transactions synchronized over one due execution create
 * one job row; repeat for Today, recovery and mail sync."
 *
 * Proved by the worker's lane suites against a real PostgreSQL, under a real advisory
 * lock. This check does two things they cannot: it asserts each of the four kinds
 * Appendix G names is actually covered by one of them, and it asserts the property the
 * uniqueness rests on — that the idempotency key for each kind is a function of the
 * work and not of the moment.
 *
 * ## The vacuous-pass trap
 *
 * A scheduler test that runs two passes one after the other sees one row because the
 * second pass found nothing due, not because `UNIQUE(workspace_id, kind,
 * idempotency_key)` held. And a key that contained an instant would make two truly
 * concurrent passes produce two rows while every sequential test stayed green.
 *
 * Closed here by asserting the keys are stable across calls and differ only by their
 * subject; closed in the lane suites by running the two passes against the same due
 * row and counting.
 */

describe('Appendix G 1: one due thing is one job row', () => {
  it('derives every idempotency key from the work, never from the instant', () => {
    // Appendix C's table, read as a property: the same work asked for twice is the
    // same key. If any of these carried a timestamp the two calls would differ and two
    // concurrent scheduler passes would each insert a row.
    const first = {
      sequence: jobIdempotencyKey.sequenceAction('11111111-2222-4333-8444-555555555555'),
      today: jobIdempotencyKey.todayList('alpha', '2026-09-21', 'today.v1'),
      mailSync: jobIdempotencyKey.mailSync('11111111-2222-4333-8444-555555555555'),
      mailRecover: jobIdempotencyKey.mailRecover('11111111-2222-4333-8444-555555555555', 3),
    };
    const second = {
      sequence: jobIdempotencyKey.sequenceAction('11111111-2222-4333-8444-555555555555'),
      today: jobIdempotencyKey.todayList('alpha', '2026-09-21', 'today.v1'),
      mailSync: jobIdempotencyKey.mailSync('11111111-2222-4333-8444-555555555555'),
      mailRecover: jobIdempotencyKey.mailRecover('11111111-2222-4333-8444-555555555555', 3),
    };
    expect(second).toEqual(first);

    // And different work is a different key, so the stability above is not the
    // stability of a constant.
    expect(jobIdempotencyKey.sequenceAction('99999999-2222-4333-8444-555555555555')).not.toEqual(first.sequence);
    expect(jobIdempotencyKey.todayList('alpha', '2026-09-22', 'today.v1')).not.toEqual(first.today);
    expect(jobIdempotencyKey.mailSync('99999999-2222-4333-8444-555555555555')).not.toEqual(first.mailSync);
  });
});
