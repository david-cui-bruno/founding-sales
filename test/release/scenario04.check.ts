import { describe, expect, it } from 'vitest';
import { BLOCKED_ACTION_KINDS, type BlockedActionKind } from '@fss/contracts';
import { MAILBOX_HOLD_BLOCKS } from '@fss/domain/mail';
import { mustCover } from './support/coverage.ts';

/**
 * Appendix G 4: "Email, call and LinkedIn steps are due while the Gmail grant is
 * revoked or coverage is stale: all automated steps hold through incomplete
 * recovery." LinkedIn was removed on 25 September 2026, so the steps are email and
 * call.
 *
 * The mail lane proves the behaviour end to end — it revokes the grant against a real
 * mailbox row, runs the sync, and reads the holds back out. What it cannot prove is
 * the quantifier. Its fixture has the step kinds it happens to have; Appendix G says
 * *all* automated steps. So this check reads `MAILBOX_HOLD_BLOCKS` directly and
 * compares it with the contract's own list of blockable action kinds, which is the
 * only place the word "all" is written down.
 *
 * ## The vacuous-pass trap
 *
 * A hold that blocks `email_send` and nothing else passes any test that only tried an
 * email, and the Gmail grant is so obviously about email that such a test is the one
 * somebody writes. Closed by deriving the expected set from `BLOCKED_ACTION_KINDS`
 * rather than restating it: the two kinds a mailbox genuinely does not gate —
 * dialling, which needs no mailbox, and research, which contacts nobody — are
 * subtracted by name and everything else must be present, so a kind added to the
 * contract without being added to the mailbox hold fails here.
 */

describe('Appendix G 4: a revoked grant holds every automated step kind', () => {
  mustCover(4, ['MAILBOX_HOLD_BLOCKS', 'Appendix G 4', 'mailbox_disconnected', 'coverage_incomplete']);

  it('blocks every action kind except the two that need no mailbox', () => {
    // Dialling reaches a telephone and research reaches nobody; neither becomes
    // unsafe because a Gmail grant lapsed, and holding them would stop work that is
    // still correct. Everything else in Appendix G's sentence is here.
    const deliberatelyExcluded = new Set<BlockedActionKind>(['dial_authorization', 'research']);
    const expected = BLOCKED_ACTION_KINDS.filter(kind => !deliberatelyExcluded.has(kind));

    expect([...MAILBOX_HOLD_BLOCKS].sort()).toEqual([...expected].sort());
    expect(MAILBOX_HOLD_BLOCKS).toContain('email_send');
    expect(MAILBOX_HOLD_BLOCKS).toContain('call_task');
    // "Through incomplete recovery" is this one: the enrollment may not step forward
    // while coverage is unproved, or the hold would be outrun rather than obeyed.
    expect(MAILBOX_HOLD_BLOCKS).toContain('enrollment_advance');
  });
});
