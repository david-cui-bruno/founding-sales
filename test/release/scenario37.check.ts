import { describe, expect, it } from 'vitest';
import { CRM_REFUSAL_CODES } from '@fss/domain/crm';
import { mustCover, readRepositoryFile } from './support/coverage.ts';

/**
 * Appendix G 37: "Firm and contact merge preserves suppressions, correspondence,
 * opportunity history, aliases and uniqueness under concurrent research enrichment."
 *
 * The CRM suite merges a duplicate firm carrying evidence, a suppression and an
 * external id, and reads each kind back on the target; the research suite holds a
 * transaction open on the source firm and proves the merge blocks on its row lock
 * rather than racing it. This check adds the refusal vocabulary that makes
 * "preserves" falsifiable: a merge that cannot decide is required to say so rather
 * than to pick.
 *
 * ## The vacuous-pass trap
 *
 * A merge of two empty firms preserves everything trivially — there is nothing to
 * lose, every count comes back zero, and the suite is green. The lane tests close it
 * by creating each preserved kind on the source *before* the merge, and that
 * ordering is what this file pins: the evidence, the suppression and the external id
 * are all written above the `mergeFirms` call, so a later edit that moved the setup
 * after the merge would fail here rather than quietly hollow the test out.
 */

describe('Appendix G 37: the merge preserves things that were there to preserve', () => {
  mustCover(37, ['Appendix G 37', 'mergeFirms', 'record_merge_events', 'merge_conflicts']);

  it('creates every preserved kind on the source before merging', () => {
    const lane = readRepositoryFile('packages/domain/test/crm/commands.test.ts');
    const test = lane.slice(lane.indexOf('preserves suppressions, evidence, stage events, aliases and external ids'));
    expect(test.length).toBeGreaterThan(0);
    const merge = test.indexOf('const merged = await mergeFirms(context, {');
    expect(merge).toBeGreaterThan(-1);
    const setup = test.slice(0, merge);
    // Each of these is an insert on the *source* firm. Without them the assertions
    // after the merge are counts of zero against counts of zero.
    expect(setup).toContain("externalId: 'legacy-firm-7'");
    expect(setup).toContain('await recordEvidence(context, {');
    expect(setup).toContain('INSERT INTO suppression_events');
  });

  it('refuses a merge it cannot decide rather than choosing a canonical value', () => {
    expect(CRM_REFUSAL_CODES).toContain('merge_conflicts');
    expect(CRM_REFUSAL_CODES).toContain('merge_already_performed');
    expect(CRM_REFUSAL_CODES).toContain('merge_same_record');
    // The source does not vanish; it becomes `merged` and points at its target, so
    // an old identifier still resolves to the surviving record.
    expect(CRM_REFUSAL_CODES).toContain('firm_merged');
    const migration = readRepositoryFile('packages/domain/db/migrations/0004_crm.sql');
    expect(migration).toContain('merged_into_firm_id');
    expect(migration).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON record_merge_events FROM app_runtime, migration;');
  });
});
