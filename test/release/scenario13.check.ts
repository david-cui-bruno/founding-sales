import { describe, expect, it } from 'vitest';
import { RECOVERY_OVERLAP_SECONDS } from '@fss/domain/mail';
import { mustCover, readRepositoryFile } from './support/coverage.ts';

/**
 * Appendix G 13: "An expired Gmail cursor with a reply just outside nominal bounds is
 * recovered by overlap and coverage proof."
 *
 * The mail lane does the whole of it against a real mailbox: Gmail refuses the
 * history id, the mailbox moves to `recovering` and opens a `coverage_incomplete`
 * hold, the bounded recovery runs, `coverageProved` comes back true and the hold
 * clears. This check adds the two facts that make that sequence mean what it says —
 * the overlap is a real interval, and the hold comes off at the end of the walk
 * rather than at the start of it.
 *
 * ## The vacuous-pass trap
 *
 * A reply placed inside the nominal window would be found with no overlap at all, so
 * the fixture would prove the sync works rather than that the recovery reaches back.
 * The lane fixture closes it by putting the message before the watermark and inside
 * `RECOVERY_OVERLAP_SECONDS` only, then asserting the recovery's `from_at` is at or
 * before that instant. The traps left for this file are an overlap quietly set to
 * zero — every existing assertion would still pass, because a zero-width overlap
 * still produces a valid interval — and a recovery that released the hold on its
 * first page, which would turn "coverage proof" into "coverage attempted" without
 * failing a single behavioural test whose fixture fits in one page.
 */

describe('Appendix G 13: the overlap is real and the proof comes last', () => {
  mustCover(13, ['RECOVERY_OVERLAP_SECONDS', 'coverage_incomplete', 'coverageProved']);

  it('reaches back a whole hour before the watermark', () => {
    expect(RECOVERY_OVERLAP_SECONDS).toBe(3600);
    expect(RECOVERY_OVERLAP_SECONDS).toBeGreaterThan(0);
    // The floor is the watermark minus the overlap, so a message arriving up to an
    // hour before the cursor expired is still inside the bounded search.
    const recover = readRepositoryFile('packages/domain/mail/recover.ts');
    expect(recover).toContain('RECOVERY_OVERLAP_SECONDS * 1000');
  });

  it('releases the coverage hold only after the whole interval is walked', () => {
    const recover = readRepositoryFile('packages/domain/mail/recover.ts');
    const unfinished = recover.indexOf('if (!exhausted) {');
    const ready = recover.indexOf("syncState: 'ready'");
    const released = recover.indexOf("releaseMailboxHold(context, { mailboxId: mailbox.id, reasonCode: 'coverage_incomplete' })");
    expect(unfinished).toBeGreaterThan(-1);
    // A partial pass returns `continued` and touches neither the watermark nor the
    // hold, so "recovered by overlap and coverage proof" cannot be satisfied by a
    // recovery that gave up halfway and declared itself done.
    expect(ready).toBeGreaterThan(unfinished);
    expect(released).toBeGreaterThan(ready);

    // Appendix D: epoch seconds, never an ambiguous date string, or the overlap
    // would be a day wide or a day short depending on Gmail's reading of it.
    expect(recover).toContain('Math.floor(Date.parse(recovery.fromAt) / 1000)');
  });
});
