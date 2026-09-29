import { describe, expect, it } from 'vitest';
import { hasOptOutLink, normalizeForOptOutRule } from '@fss/contracts';
import { OPT_OUT_LINK_CASES } from '../db/support/optOutLinkCases.ts';

/**
 * The no-visible-opt-out-link rule, in TypeScript (David, 29 September 2026; the rule as
 * decided after the review of PR 311).
 *
 * The same table is run against the database's own spelling of the rule in
 * `packages/domain/test/db/optOutLink.test.ts`. Neither file may carry a case the other
 * does not: that is the whole point of the shared table.
 *
 * ## The vacuous-pass traps, named
 *
 * **A table of refusals only.** A rule that refused everything would pass a table of
 * failing cases; a third of the rows here are bodies that must still send, including the
 * sentence the old CHECK made unwritable.
 *
 * **A normalisation nobody can see.** The folding is asserted directly as well as through
 * the rule, so a rule that happened to match the raw bytes would not hide a normalisation
 * that does nothing.
 */
describe('the opt-out-link rule, as the Mac and the save apply it', () => {
  for (const { what, text, refused } of OPT_OUT_LINK_CASES) {
    it(`${refused ? 'refuses' : 'accepts'}: ${what}`, () => {
      expect(hasOptOutLink(text), what).toBe(refused);
    });
  }

  it('folds NFKC, the named dashes, the named spaces and the case, and never a newline', () => {
    expect(normalizeForOptOutRule('Opt‑Out')).toBe('opt-out');
    expect(normalizeForOptOutRule('opt out')).toBe('opt out');
    expect(normalizeForOptOutRule('opt　out')).toBe('opt out');
    expect(normalizeForOptOutRule('OPT OUT')).toBe('opt out');
    // NFKC on its own: a full-width URL scheme becomes the ASCII one.
    expect(normalizeForOptOutRule('ＨＴＴＰ://x')).toBe('http://x');
    // The rule counts lines, so the one character it must not fold is the newline.
    expect(normalizeForOptOutRule('a\nb')).toBe('a\nb');
  });
});
