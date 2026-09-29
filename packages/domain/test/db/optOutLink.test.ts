import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  OPT_OUT_DASH_CODE_POINTS,
  OPT_OUT_DASH_REPLACEMENT,
  OPT_OUT_LOWERCASE,
  OPT_OUT_SPACE_CODE_POINTS,
  OPT_OUT_SPACE_REPLACEMENT,
  OPT_OUT_UPPERCASE,
  hasOptOutLink,
} from '@fss/contracts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { OPT_OUT_LINK_CASES } from './support/optOutLinkCases.ts';

/**
 * `email_has_optout_link(text)` — migration 0024's spelling of the no-visible-opt-out-link
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

  it('translates exactly the code points `@fss/contracts` names, character for character', () => {
    // Outcomes agreeing on 26 examples is not the same claim as the two normalisations
    // being the same normalisation. This reads the migration and compares the three
    // translation tables directly (review of PR 311, second round).
    const sql = readFileSync(new URL('../../db/migrations/0024_email_presentation.sql', import.meta.url), 'utf8');
    const unicodeLists = [...sql.matchAll(/U&'((?:\\[0-9A-Fa-f]{4})+)'/gu)].map(match =>
      [...(match[1] ?? '').matchAll(/\\([0-9A-Fa-f]{4})/gu)]
        .map(point => String.fromCodePoint(Number.parseInt(point[1] ?? '0', 16)))
        .join(''),
    );
    expect(unicodeLists).toHaveLength(2);
    expect(unicodeLists[0]).toBe(OPT_OUT_DASH_CODE_POINTS);
    expect(unicodeLists[1]).toBe(OPT_OUT_SPACE_CODE_POINTS);
    // And what each is translated *to*, which decides nothing unless the lengths match.
    expect(sql).toContain(`'${OPT_OUT_DASH_REPLACEMENT}')`);
    expect(sql).toContain(`'${OPT_OUT_SPACE_REPLACEMENT}')`);
    expect(OPT_OUT_DASH_REPLACEMENT).toHaveLength(OPT_OUT_DASH_CODE_POINTS.length);
    expect(OPT_OUT_SPACE_REPLACEMENT).toHaveLength(OPT_OUT_SPACE_CODE_POINTS.length);
    // The case map, which is a `translate()` in both places and `lower()` in neither.
    // Asserted over the function's body, not the file: the header explains why.
    const body = sql.slice(sql.indexOf('CREATE FUNCTION email_has_optout_link'), sql.indexOf('$$;'));
    expect(body).toContain(`'${OPT_OUT_UPPERCASE}', '${OPT_OUT_LOWERCASE}'`);
    expect(body).not.toMatch(/\blower\(/u);
    expect(body).toContain('normalize(candidate, NFKC)');
  });

  it('is immutable, which is what makes it legal inside a CHECK', async () => {
    const { rows } = await database.session.query<{ volatile: string }>(
      "SELECT provolatile AS volatile FROM pg_proc WHERE proname = 'email_has_optout_link'",
    );
    expect(rows[0]?.volatile).toBe('i');
  });
});
