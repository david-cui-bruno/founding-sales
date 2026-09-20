import { describe, expect, it } from 'vitest';
import { mustCover, readRepositoryFile } from './support/coverage.ts';

/**
 * Appendix G 41: "Retention deletes unmatched metadata, raw MIME, canceled drafts and
 * logs at their boundaries without deleting matched business history or suppression
 * tombstones."
 *
 * 10.3's table, and the rows of it that are not a duration: "minimal suppression
 * tombstones and suppression history: indefinite", "audit events: seven years", and
 * "normalized matched message body and necessary headers: with business correspondence".
 *
 * ## The vacuous-pass trap
 *
 * A retention suite proves what it deletes and almost never proves what survives, so the
 * dangerous half — a batch that took a suppression tombstone along with the unmatched
 * metadata around it — is the half nobody tests. It is also the half that cannot be
 * undone.
 *
 * Closed by asserting the guarantee that does not depend on any batch being written
 * correctly: the application role has no `DELETE` on the append-only tables at all, so a
 * retention job that wanted to remove a tombstone could not, whatever its policy said.
 * That is a database privilege rather than a policy, and it is the only kind of promise
 * worth making about an irreversible record.
 *
 * The other half — every table is classified for retention — is G14's
 * `PENDING_RETENTION_TABLES` and `TABLE_RETENTION_COVERAGE`. When that migration merges,
 * the coverage assertion belongs here beside these. Until then this check asserts the
 * closed vocabulary 10.3 defines and that each bounded kind has a *per-kind* boundary,
 * because one global duration would delete raw MIME too late and unmatched metadata too
 * early, and both are policy failures.
 */

/** 10.3's kinds a retention batch may delete, each with its own boundary. */
const BOUNDED_KINDS = ['unmatched_gmail_metadata', 'raw_mime', 'canceled_drafts', 'operational_logs'];
/** 10.3's kinds it may never delete. */
const INDEFINITE_KINDS = ['suppression_history', 'audit_events', 'business_records', 'matched_message_body'];

describe('Appendix G 41: what retention removes, and what it can never reach', () => {
  mustCover(41, ['retention_policies', 'retention_interval', 'retain_indefinitely']);

  const foundation = readRepositoryFile('packages/domain/db/migrations/0001_foundation.sql');

  it('names every bounded kind of 10.3 in the closed vocabulary', () => {
    for (const kind of BOUNDED_KINDS) {
      expect(foundation, `retention has no place for ${kind}`).toContain(kind);
    }
  });

  it('names the kinds that are kept, so "delete everything old" is not representable', () => {
    for (const kind of INDEFINITE_KINDS) {
      expect(foundation, `retention has no place for ${kind}`).toContain(kind);
    }
    // A disposition vocabulary with only `delete` in it would make the distinction
    // unexpressible; these three are what let a policy say "keep".
    expect(foundation).toContain('retain_indefinitely');
    expect(foundation).toContain('retain_with_business_record');
    expect(foundation).toContain('tombstone');
  });

  it('gives each kind its own boundary rather than one global duration', () => {
    // 10.3 states four different durations for the four bounded kinds. The column is
    // per row, and the CHECK ties the presence of an interval to the disposition, so a
    // bounded kind cannot be stored without a boundary and a kept kind cannot have one.
    expect(foundation).toContain('retention_interval interval');
    expect(foundation).toContain('retention_policies_one_per_kind UNIQUE (workspace_id, data_kind)');
    expect(foundation).toContain('retention_policies_interval_consistent');
    expect(foundation).toContain('retention_policies_interval_positive');
  });

  it('the application role cannot delete a suppression event or an audit event at all', () => {
    // 10.2: "`suppression_events` is insert-only. UPDATE and DELETE are revoked from
    // application and migration roles." 5.2 says the same of `audit_events`. A retention
    // batch pointed at either would be refused by PostgreSQL before its policy was read.
    expect(foundation).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON suppression_events FROM app_runtime, migration;');
    expect(foundation).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM app_runtime, migration;');
  });

  it('the same is true of the append-only histories a deletion would silently rewrite', () => {
    const crm = readRepositoryFile('packages/domain/db/migrations/0004_crm.sql');
    expect(crm).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON opportunity_stage_events');
    expect(crm).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON record_merge_events');
    const policy = readRepositoryFile('packages/domain/db/migrations/0006_policy.sql');
    expect(policy).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON suppression_finalizations');
    const outbound = readRepositoryFile('packages/domain/db/migrations/0010_outbound.sql');
    // An outbound fence is what makes at-most-once true; deleting one would make a
    // resend possible, which is invariant 1.
    expect(outbound).toContain('REVOKE DELETE, TRUNCATE ON outbound_messages');
  });
});
