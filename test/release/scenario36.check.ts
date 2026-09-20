import { describe, expect, it } from 'vitest';
import { TERMINAL_OUTBOUND_STATES } from '@fss/domain/outbound';
import { mustCover, readRepositoryFile } from './support/coverage.ts';

/**
 * Appendix G 36: "Unknown-terminal marked delivered continues from the original
 * dispatch time; marked skipped stops and never resends."
 *
 * The outbound suite drives a fence all the way through `dispatching` and
 * `reconciling` into `unknown_terminal`, resolves it both ways, and asserts a
 * subsequent dispatch attempt returns `already_terminal` with Gmail untouched. This
 * check adds the structural reason both answers are safe: the admin's resolution
 * writes an opinion, not a state, so neither choice can put the fence anywhere a
 * send could start from.
 *
 * ## The vacuous-pass trap
 *
 * A fence that never dispatched has no original dispatch time to continue from, so a
 * test that resolved a fresh `prepared` fence would assert something true and
 * meaningless. The lane test closes that by driving the fence through the real
 * transitions first and reading `dispatchedAt` back out of the outcome. The trap
 * here is a resolution that helpfully "reopens" a skipped fence so the step can be
 * retried; that would satisfy every assertion about the recorded resolution and
 * would be a second send.
 */

describe('Appendix G 36: the admin answers the question without moving the fence', () => {
  mustCover(36, ['Appendix G 36', 'resolveUnknownTerminal', 'already_terminal', 'unknown_terminal']);

  it('writes the resolution and never the state', () => {
    const fence = readRepositoryFile('packages/domain/outbound/fence.ts');
    const resolve = fence.slice(
      fence.indexOf('export async function resolveUnknownTerminal'),
      fence.indexOf('export async function readFenceEvents'),
    );
    expect(resolve.length).toBeGreaterThan(0);
    expect(resolve).toContain('SET admin_resolution = $3');
    // No transition at all. Both answers mean the same thing about Gmail.
    expect(resolve).not.toContain('SET state =');
    expect(resolve).not.toContain("state = 'prepared'");
    // Answerable once, and only from the terminal state.
    expect(resolve).toContain("AND state = 'unknown_terminal' AND admin_resolution IS NULL");
  });

  it('keeps unknown_terminal terminal whichever way it is resolved', () => {
    expect(TERMINAL_OUTBOUND_STATES.has('unknown_terminal')).toBe(true);
    expect(TERMINAL_OUTBOUND_STATES.has('sent')).toBe(true);
    // The two resolutions differ in what the *sequence* does next, which is why the
    // lane test reads `dispatchedAt` from the outcome rather than from the clock.
    const lane = readRepositoryFile('packages/domain/test/outbound/scenarios.test.ts');
    expect(lane).toContain("resolution: 'delivered'");
    expect(lane).toContain("resolution: 'skipped'");
    expect(lane).toContain('expect(outcome.dispatchedAt).toBe(after?.dispatchStartedAt)');
  });
});
