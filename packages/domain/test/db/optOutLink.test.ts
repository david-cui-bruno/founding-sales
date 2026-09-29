import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasOptOutLink } from '@fss/contracts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { OPT_OUT_LINK_CASES } from './support/optOutLinkCases.ts';

/**
 * `email_has_optout_link(text)` — migration 0023's spelling of the no-visible-opt-out-link
 * rule — against the same table `packages/domain/test/domain/optOutLink.test.ts` runs
 * against `hasOptOutLink`.
 *
 * The database's copy is the load-bearing one: `app_runtime` holds INSERT on both tables
 * the CHECKs are over, so a rule that lived only in TypeScript is a rule a raw insert
 * walks past. The TypeScript copy is what lets the Mac and the save refuse *before* the
 * insert, so a person sees a sentence rather than a 500.
 *
 * ## The vacuous-pass trap, named
 *
 * **Two rules that agree only where they were written.** Each row is asserted against
 * both spellings *in this file*, so a case that one refuses and the other accepts fails
 * here rather than in production.
 */
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe('the database and TypeScript spell the opt-out-link rule the same way', () => {
  it('answers every case in the shared table exactly as `hasOptOutLink` does', async () => {
    for (const { what, text, refused } of OPT_OUT_LINK_CASES) {
      const { rows } = await database.session.query<{ refused: boolean }>(
        'SELECT email_has_optout_link($1) AS refused',
        [text],
      );
      expect(rows[0]?.refused, `SQL: ${what}`).toBe(refused);
      expect(hasOptOutLink(text), `TypeScript: ${what}`).toBe(refused);
    }
  });

  it('is immutable, which is what makes it legal inside a CHECK', async () => {
    const { rows } = await database.session.query<{ volatile: string }>(
      "SELECT provolatile AS volatile FROM pg_proc WHERE proname = 'email_has_optout_link'",
    );
    expect(rows[0]?.volatile).toBe('i');
  });
});
