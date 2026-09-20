import { describe, expect, it } from 'vitest';
import { CRM_REFUSAL_CODES } from '@fss/domain/crm';
import { mustCover, readRepositoryFile } from './support/coverage.ts';

/**
 * Appendix G 7: "Two salespeople and one assigned firm: every mutation and sensitive
 * read by the other is refused, including concurrent reassignment."
 *
 * The CRM command suite acts as a real second salesperson with a real scope and walks
 * every mutation; the pipeline-administration suite does the same for the board; the
 * API surface suite does it over HTTP with a session. Between them the behaviour is
 * covered. What this check adds is the property those suites depend on and never
 * state: that the refusal has a vocabulary of its own, so "refused" can be
 * distinguished from "not signed in".
 *
 * ## The vacuous-pass trap
 *
 * Refusing an unauthenticated caller is not refusing an authenticated one with the
 * wrong assignment, and a suite that only ever presented no credentials would look
 * thorough and prove nothing. The lane tests close it by holding a genuine second
 * salesperson's scope in the same workspace. This check closes the reverse leak: the
 * CRM refusal set is asserted to carry `not_assigned` and to carry no
 * session-shaped code at all, so a future rewrite cannot answer an assignment
 * question with an authentication answer and still typecheck.
 */

describe('Appendix G 7: the other salesperson is refused as the other salesperson', () => {
  const entry = mustCover(7, ['not_assigned', 'reassignFirm', 'assigned_or_admin']);

  it('names assignment and authority separately, and never authentication', () => {
    expect(CRM_REFUSAL_CODES).toContain('not_assigned');
    expect(CRM_REFUSAL_CODES).toContain('admin_only');
    // Authentication is settled before a CRM command is reached at all, so a code
    // about it here would mean the two layers had been conflated.
    for (const code of ['unauthenticated', 'session_expired', 'membership_required', 'device_revoked']) {
      expect(CRM_REFUSAL_CODES as readonly string[], `${code} does not belong to the CRM lane`).not.toContain(code);
    }
  });

  it('reads the assigned firm through a visibility the caller cannot widen', () => {
    // The sensitive-read half. `assigned_or_admin` is the discriminant of the Firm
    // page response, so a reader who is neither gets a narrower shape rather than a
    // full row with fields blanked — there is nothing to forget to blank.
    expect(entry.references).toContain('apps/api/test/crmSurface.test.ts');
    const contract = readRepositoryFile('packages/contracts/src/crmSurface.ts');
    expect(contract).toContain("z.discriminatedUnion('visibility'");
    expect(contract).toContain('assigned_or_admin');
  });
});
