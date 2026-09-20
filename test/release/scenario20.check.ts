import { describe, expect, it } from 'vitest';
import { mustBeRehearsed, readRepositoryFile } from './support/coverage.ts';

/**
 * Appendix G 20: "Post-watermark sends and suppressions exist; the old stack is
 * read-only and cannot be a rollback target."
 *
 * The first half is provable on a laptop and the carry suites prove it: the export
 * refuses a table that wrote after the watermark, and the import refuses a record
 * recorded after it even in a hand-made artifact. The second half is not provable
 * anywhere but in the rehearsal, because "the old stack is read-only" is a statement
 * about a running deployment, not about this repository — hence the script and the
 * workflow entry this check insists on.
 *
 * ## The vacuous-pass trap
 *
 * A carry run over a fixture with no post-watermark write never reaches the refusal;
 * the export succeeds, the counts match and the suite is green while the one rule
 * that matters was never consulted. `tableWithPostWatermarkWrite` exists for exactly
 * this, and the rehearsal script asserts the export refuses on the real table. This
 * file makes the fixture's existence a gate condition rather than a convention: if
 * the fixture is deleted or renamed, the round-trip suite still passes its other
 * cases and this check goes red.
 */

describe('Appendix G 20: the carry refuses what the old stack wrote after the watermark', () => {
  mustBeRehearsed(20);

  it('keeps the post-watermark fixture, and uses it to reach the refusal', () => {
    const roundTrip = readRepositoryFile('apps/worker/test/carry/roundTrip.test.ts');
    expect(roundTrip).toContain('tableWithPostWatermarkWrite');
    // The refusal reasons, named. An export that merely returned fewer items would
    // look like a successful carry of a smaller table.
    expect(roundTrip).toContain('post_watermark_items_present');
    expect(roundTrip).toContain('post_watermark_record');

    // And the fixture is real rather than a stub the test file declares inline.
    const fixtures = readRepositoryFile('apps/worker/test/fixtures/carry/oldTable.ts');
    expect(fixtures).toContain('export function tableWithPostWatermarkWrite');
  });

  it('states in the runbook that the old stack is never a rollback target', () => {
    const runbook = readRepositoryFile('docs/greenfield/carry-runbook.md');
    expect(runbook).toContain('read-only');
    expect(runbook).toContain('not** a rollback target');
    // The watermark is established before the export, not derived from it, which is
    // why a post-watermark write is detectable at all.
    expect(runbook.indexOf('## 2. Establish the write watermark')).toBeLessThan(
      runbook.indexOf('## 4. Export, under the operator role'),
    );
  });
});
