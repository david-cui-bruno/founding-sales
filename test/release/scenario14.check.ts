import { describe, expect, it } from 'vitest';
import { HOLD_RECOVERY_ACTIONS } from '@fss/contracts';
import { mustCover, readRepositoryFile } from './support/coverage.ts';

/**
 * Appendix G 14: "A shared receptionist address yields several candidates; only the
 * ambiguity holds release after resolution."
 *
 * The mail lane builds two firms behind one address, syncs a reply, asserts both
 * opportunities become candidates and both are held, resolves to one of them, and
 * then checks what survived. This check adds the reason the resolution is narrow: the
 * release is scoped by the message *and* by the reason code, and the word "only" in
 * Appendix G's sentence is that second filter.
 *
 * ## The vacuous-pass trap
 *
 * Resolving when the ambiguity hold is the only hold in existence cannot show that
 * other holds survive — everything clears and the assertion that "the unrelated hold
 * is still in force" has nothing to be about. The lane test closes it by opening an
 * unrelated hold on a candidate first. The residual trap is a release written as
 * "clear every hold this message opened", which passes that test whenever the
 * unrelated hold was opened by something else, and is wrong the first time a message
 * opens two kinds of hold at once. Closed here by asserting the release names
 * `ambiguous_match` as well as the message.
 */

describe('Appendix G 14: resolution releases the ambiguity and nothing else', () => {
  mustCover(14, ['resolveAmbiguity', 'ambiguous_match', 'releaseHoldsOfEvent']);

  it('scopes the release by reason code as well as by message', () => {
    const matching = readRepositoryFile('packages/domain/mail/matching.ts');
    const resolve = matching.slice(matching.indexOf('export async function resolveAmbiguity'));
    expect(resolve.length).toBeGreaterThan(0);
    expect(resolve).toContain('releaseHoldsOfEvent');
    expect(resolve).toContain('sourceEventId: input.messageId');
    // Without this line the release would be "every hold this message opened", and
    // the uncertain-reply hold the same message earns would go with it.
    expect(resolve).toContain("reasonCode: 'ambiguous_match'");
  });

  it('opens the successor hold before releasing, so the winner is never unheld', () => {
    const matching = readRepositoryFile('packages/domain/mail/matching.ts');
    const resolve = matching.slice(matching.indexOf('export async function resolveAmbiguity'));
    const keeper = resolve.indexOf("reasonCode: 'uncertain_reply'");
    const release = resolve.indexOf('releaseHoldsOfEvent');
    expect(keeper).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(-1);
    // Ordering is the assertion: at no instant inside the transaction is the selected
    // opportunity free of holds, so nothing can slip a send between the two writes.
    expect(keeper).toBeLessThan(release);
    expect(HOLD_RECOVERY_ACTIONS).toContain('resolve_ambiguity');
    expect(HOLD_RECOVERY_ACTIONS).toContain('confirm_reply');
  });
});
