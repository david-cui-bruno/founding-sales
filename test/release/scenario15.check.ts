import { describe, expect, it } from 'vitest';
import { mustCover, readRepositoryFile } from './support/coverage.ts';

/**
 * Appendix G 15: "A reply to a closed opportunity holds the new open automated
 * opportunity."
 *
 * One lane test carries it: the mail suite closes the firm's seeded opportunity,
 * opens a second one, delivers a reply that matches the old thread, and asserts the
 * `uncertain_reply` hold lands on the *new* opportunity. This check adds the database
 * fact the sentence leans on without saying so — "the new open automated
 * opportunity" is a definite article, and it is definite because the schema permits
 * only one open opportunity per firm.
 *
 * ## The vacuous-pass trap
 *
 * A firm with only a closed opportunity has nothing to hold, so a test that forgot to
 * open the second one would assert an empty list against an empty list and pass. The
 * lane test closes it by creating the second, open opportunity first — and that
 * ordering is the thing this file checks, because it is the kind of setup a later
 * edit silently reverses. The complementary trap is a schema that allowed two open
 * opportunities per firm, which would make "the new open one" ambiguous and the hold
 * placeable on either; closed by asserting the partial unique index exists.
 */

describe('Appendix G 15: the reply holds the firm’s one open opportunity', () => {
  mustCover(15, ['uncertain_reply', 'openOpportunityId']);

  it('closes the old opportunity before opening the new one', () => {
    const lane = readRepositoryFile('packages/domain/test/mail/scenarios.test.ts');
    const test = lane.slice(lane.indexOf('Appendix G 15'), lane.indexOf('Appendix G 19'));
    expect(test.length).toBeGreaterThan(0);
    const closed = test.indexOf("status = 'lost'");
    const opened = test.indexOf('INSERT INTO opportunities');
    const held = test.indexOf('openOpportunityId');
    expect(closed).toBeGreaterThan(-1);
    expect(opened).toBeGreaterThan(closed);
    // The assertion is made about the opportunity that was opened, not about the one
    // the reply's thread actually belongs to. That is the whole scenario.
    expect(held).toBeGreaterThan(opened);
    expect(test).toContain('uncertain_reply');
  });

  it('permits only one open opportunity per firm, so "the new one" is definite', () => {
    const migration = readRepositoryFile('packages/domain/db/migrations/0004_crm.sql');
    expect(migration).toContain('CREATE UNIQUE INDEX opportunities_one_open_per_firm');
    expect(migration).toContain("WHERE status = 'open'");
  });
});
