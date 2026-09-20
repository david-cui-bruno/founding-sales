import { describe, expect, it } from 'vitest';
import { DIAL_HOLD_REFUSAL_CODES, SUPPRESSION_SCOPES } from '@fss/contracts';
import { SEND_REFUSAL_CODES } from '@fss/domain/outbound';
import { mustCover } from './support/coverage.ts';

/**
 * Appendix G 6: "An opt-out commits while email and dial work is queued or claimed,
 * including a shared handle: no post-commit external action."
 *
 * Three lane suites hold the three halves — the outbound fence refuses a dispatch
 * whose recipient was suppressed a moment earlier, the policy suite records an
 * opt-out on a call and refuses the next dial, and the mail suite reads explicit
 * opt-out wording and suppresses the address and the firm together. What none of
 * them states is the shape the three share: suppression has exactly two scopes, and
 * a refusal names which one stopped it.
 *
 * ## The vacuous-pass trap
 *
 * Testing the firm scope alone would miss the handle shared between two firms, which
 * is the interesting half of the sentence — an address or a number belongs to a
 * person, and suppressing the firm they happen to be filed under does not stop the
 * other firm's sequence reaching the same inbox. Closed in the lane suites, which
 * assert the handle suppression alone does *not* suppress the firm and vice versa,
 * and closed here by requiring both scopes to survive as separately named refusals
 * on both channels: collapse them into one code and this fails.
 */

describe('Appendix G 6: an opt-out stops both scopes on both channels', () => {
  mustCover(6, ['Appendix G 6', 'handle_suppressed', 'doNotCallCoversAllContact', 'suppressionsRecorded']);

  it('keeps firm and handle as two scopes with two refusals on each channel', () => {
    expect([...SUPPRESSION_SCOPES].sort()).toEqual(['firm', 'handle']);

    // Sending and dialling answer in the same vocabulary, and each keeps the two
    // apart. A single `suppressed` code would make the shared-handle case
    // indistinguishable from the firm case in every log and every test.
    for (const code of ['firm_suppressed', 'handle_suppressed'] as const) {
      expect(SEND_REFUSAL_CODES, `sending cannot say ${code}`).toContain(code);
      expect(DIAL_HOLD_REFUSAL_CODES, `dialling cannot say ${code}`).toContain(code);
    }
  });
});
