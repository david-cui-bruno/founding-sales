import { describe, expect, it } from 'vitest';
import { SEND_REFUSAL_CODES } from '@fss/domain/outbound';
import { mustCover, readRepositoryFile } from './support/coverage.ts';

/**
 * Appendix G 12: "A worker sends after lease expiry while another reclaims and Sent
 * indexing is delayed."
 *
 * The outbound lane races two workers over one fence against a real database and
 * asserts the loser calls Gmail zero times while the winner calls it once. This
 * check adds the structural property the race depends on and that no single test run
 * can demonstrate: the fence's state machine has exactly one edge back to `prepared`,
 * and it starts at `held` — so a worker that reached `dispatching` can never be put
 * back into a position from which it could send again.
 *
 * ## The vacuous-pass trap
 *
 * If the losing worker is turned away somewhere earlier — by a hold, by the ramp, by
 * an eligibility read — then the fence was never the thing that stopped it, and the
 * test proves only that the loser was unlucky. The lane test closes that by asserting
 * the loser reaches `claimForDispatch` and is refused *there*, with
 * `fence_not_ready`. The residual trap is a recovery path added later that resets a
 * stuck `dispatching` fence to `prepared` "so it can be retried"; that would be
 * invisible to the race test and fatal. Closed here by counting the transitions into
 * `prepared` in the source and requiring the only one to be guarded on `held`.
 */

describe('Appendix G 12: dispatch ownership is irreversible', () => {
  mustCover(12, ['Appendix G 12', 'claimForDispatch', 'fence_not_ready', 'attempt_token']);

  it('claims prepared atomically and hands the loser fence_not_ready', () => {
    const fence = readRepositoryFile('packages/domain/outbound/fence.ts');
    const claim = fence.slice(
      fence.indexOf('export async function claimForDispatch'),
      fence.indexOf('export async function recordSent'),
    );
    expect(claim.length).toBeGreaterThan(0);
    // One UPDATE, one predicate. Whoever the database picks gets the token; the
    // other reads the row back and is told why, which is the refusal the lane test
    // asserts the loser receives.
    expect(claim).toContain("WHERE workspace_id = $1 AND id = $2 AND state = 'prepared'");
    expect(claim).toContain("'fence_unknown' : 'fence_not_ready'");
    expect(SEND_REFUSAL_CODES).toContain('fence_not_ready');

    // And the send itself is bound to the token, so the worker that woke up late
    // cannot complete a dispatch its replacement now owns.
    const sent = fence.slice(
      fence.indexOf('export async function recordSent'),
      fence.indexOf('export async function beginReconciling'),
    );
    expect(sent).toContain("AND attempt_token = $3 AND state = 'dispatching'");
  });

  it('has exactly one edge back to prepared, and it leaves from held', () => {
    const fence = readRepositoryFile('packages/domain/outbound/fence.ts');
    const resets = fence.split("SET state = 'prepared'").length - 1;
    expect(resets, 'a second way back to prepared is a second way to send').toBe(1);
    // `held` is defined as "never entered dispatching", which is the only reason the
    // reverse edge is safe at all.
    const release = fence.slice(fence.indexOf("SET state = 'prepared'"));
    expect(release.slice(0, 200)).toContain("AND state = 'held'");
  });
});
