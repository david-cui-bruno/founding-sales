import { describe, expect, it } from 'vitest';
import { IMPORT_ISSUE_CODES, importCommitResponseSchema } from '@fss/contracts';
import { mustCover, readRepositoryFile } from './support/coverage.ts';

/**
 * Appendix G 38: "CSV import with duplicates, cross-workspace ids, invalid routes and
 * partial failures produces a preview and atomic per-row commands without leakage."
 *
 * The CRM import suite runs one file containing all four defects, asserts the
 * preview classifies each row, commits the good ones, rolls a half-written row back
 * whole, and says nothing at all about the workspace next door; the API surface suite
 * does the same over HTTP and replays a retry. This check adds the contract those
 * results are reported in — the four defect families are separately nameable, and a
 * response can say that some rows landed and others did not.
 *
 * ## The vacuous-pass trap
 *
 * A file where every row is valid never exercises partial failure: the commit
 * succeeds, the counts match, and "atomic per row" is indistinguishable from "atomic
 * per file". The lane fixture closes it by putting all four defects in one file. The
 * trap this file closes is a response shape that cannot express a partial result —
 * if `status` were a single value for the whole request, the suite would have to
 * assert something weaker, and the weaker assertion would survive a regression to
 * all-or-nothing behaviour.
 */

describe('Appendix G 38: four defects in one file, reported row by row', () => {
  mustCover(38, ['duplicate_in_file', 'duplicate_in_workspace', 'previewCsvImport', 'commitImportRow']);

  it('names each defect family separately', () => {
    // Duplicates within the file and duplicates already in the workspace are
    // different problems with different fixes, and the cross-workspace case is the
    // second one seen from the caller's side.
    expect(IMPORT_ISSUE_CODES).toContain('duplicate_in_file');
    expect(IMPORT_ISSUE_CODES).toContain('duplicate_in_workspace');
    // The invalid routes: an address and a number are both routes, and both refuse.
    expect(IMPORT_ISSUE_CODES).toContain('email_invalid');
    expect(IMPORT_ISSUE_CODES).toContain('phone_invalid');
    expect(IMPORT_ISSUE_CODES).toContain('owner_unknown');
    expect(new Set(IMPORT_ISSUE_CODES).size).toBe(IMPORT_ISSUE_CODES.length);
  });

  it('can report some rows accepted and others refused in one answer', () => {
    // Per row, not per file. If this shape could not hold a mixture, "partial
    // failures" would have nowhere to be reported and the suite would be asserting
    // against a response that cannot represent the scenario.
    const parsed = importCommitResponseSchema.parse({
      results: [
        { rowNumber: 2, status: 'accepted', replayed: false, reason: null, firmId: '11111111-2222-4333-8444-555555555555' },
        { rowNumber: 3, status: 'refused', replayed: false, reason: 'duplicate_in_workspace', firmId: null },
      ],
      counts: { accepted: 1, refused: 1 },
    });
    expect(parsed.results.map(result => result.status)).toEqual(['accepted', 'refused']);
    expect(parsed.counts).toEqual({ accepted: 1, refused: 1 });

    // And the import suite keeps its own copy of the codes honest against the
    // contract's, so the two lists cannot drift apart unnoticed.
    const lane = readRepositoryFile('packages/domain/test/crm/import.test.ts');
    expect(lane).toContain('expect([...IMPORT_ISSUE_CODES]).toEqual([...CONTRACT_ISSUE_CODES]);');
  });
});
