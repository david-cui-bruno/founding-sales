import { describe, expect, it } from 'vitest';
import {
  COVERAGE_EXEMPT_TABLES,
  PENDING_RETENTION_TABLES,
  RETENTION_TARGETS,
  TABLE_RETENTION_COVERAGE,
} from '@fss/domain/retention';
import { mustCover, readRepositoryFile } from './support/coverage.ts';

/**
 * Appendix G 41: "Retention deletes unmatched metadata, raw MIME, canceled drafts and
 * logs at their boundaries without deleting matched business history or suppression
 * tombstones."
 *
 * G14 owns the sweeps, the deletion workflow and the departure command, and its suites
 * prove each boundary against a real database. What belongs here is the release-gate
 * question those suites cannot ask of themselves: **is every table answered for**, and
 * **can the things that must survive actually be reached**.
 *
 * ## The vacuous-pass trap
 *
 * A retention suite proves what it deletes and almost never proves what survives, so
 * the dangerous half — a batch that took a suppression tombstone along with the
 * unmatched metadata around it — is the half nobody tests, and it is the half that
 * cannot be undone. Worse, a table added by a *later* lane is uncovered by definition:
 * nothing existing mentions it, so nothing existing fails.
 *
 * Closed three ways. `TABLE_RETENTION_COVERAGE` is asserted to be a real registry
 * rather than an empty object, so "every table is classified" cannot be true by being
 * a claim about nothing. `PENDING_RETENTION_TABLES` is asserted empty, because a table
 * named as pending is a table with no horizon. And the tables that must never be a
 * deletion target are asserted unreachable by *privilege* rather than by policy — a
 * retention batch pointed at `suppression_events` is refused by PostgreSQL before its
 * policy is read, which is the only kind of promise worth making about an irreversible
 * record.
 */

/** 10.3's kinds a scheduled sweep deletes from this database, each with its own boundary. */
const SWEPT_KINDS = ['unmatched_gmail_metadata', 'raw_mime', 'canceled_drafts'];
/**
 * The fourth bounded kind of Appendix G 41. Its boundary is the CloudWatch log group's
 * own retention (`infra/modules/observability`), not a statement against PostgreSQL —
 * FSS cannot delete a log line it does not store. A target that claimed to sweep it
 * would be a target that silently did nothing, so `external` is the honest state and
 * asserting it is how a later lane cannot quietly turn it into a no-op sweep.
 */
const EXTERNAL_KINDS = ['operational_logs'];
/** 10.3's kinds it may never delete. */
const KEPT_KINDS = ['business_records', 'suppression_history', 'audit_events'];

describe('Appendix G 41: what retention removes, and what it can never reach', () => {
  mustCover(41, ['TABLE_RETENTION_COVERAGE', 'PENDING_RETENTION_TABLES', 'RETENTION_TARGETS']);

  it('has a target for every kind of 10.3, bounded and kept alike', () => {
    const kinds = RETENTION_TARGETS.map(target => target.dataKind);
    for (const kind of [...SWEPT_KINDS, ...EXTERNAL_KINDS, ...KEPT_KINDS]) {
      expect(kinds, `10.3 names ${kind} and retention has no target for it`).toContain(kind);
    }
  });

  it('distinguishes the bounded kinds from the kept ones, so "delete everything" is not representable', () => {
    for (const kind of SWEPT_KINDS) {
      const target = RETENTION_TARGETS.find(entry => entry.dataKind === kind);
      expect(target?.state, `${kind} must be swept`).toBe('implemented');
      expect(target?.sweep, `${kind} is marked implemented with no sweep`).not.toBeNull();
    }
    for (const kind of EXTERNAL_KINDS) {
      const target = RETENTION_TARGETS.find(entry => entry.dataKind === kind);
      expect(target?.state, `${kind} boundary is not this database's to enforce`).toBe('external');
      expect(target?.sweep, `${kind} is external and yet claims a sweep`).toBeNull();
    }
    for (const kind of KEPT_KINDS) {
      const target = RETENTION_TARGETS.find(entry => entry.dataKind === kind);
      expect(target?.state, `${kind} must be retained`).toBe('retained');
      expect(target?.sweep, `${kind} is retained and yet has a sweep`).toBeNull();
    }
  });

  it('classifies every table, and the registry is not empty', () => {
    // The guard is only worth having if it is a claim about something. An empty
    // registry would satisfy "every table it names is classified" trivially.
    const classified = Object.keys(TABLE_RETENTION_COVERAGE);
    expect(classified.length).toBeGreaterThan(40);
    for (const [table, entry] of Object.entries(TABLE_RETENTION_COVERAGE)) {
      expect(entry.dispositions.length, `${table} is classified with no disposition`).toBeGreaterThan(0);
      expect(entry.note.length, `${table} is classified with no reason`).toBeGreaterThan(10);
    }
    // And the exemptions are named rather than implied: `schema_versions` is the
    // migration ledger, not prospect data.
    expect(COVERAGE_EXEMPT_TABLES.length).toBeLessThan(5);
  });

  it('has no table still waiting to be classified', () => {
    // A pending table is a table with no horizon. It is allowed to exist while a lane
    // is in flight, and it is not allowed to exist at a release gate.
    expect(PENDING_RETENTION_TABLES).toEqual([]);
  });

  it('classifies the tombstones as retained, and the privilege makes that true', () => {
    for (const table of ['suppression_events', 'audit_events']) {
      expect(TABLE_RETENTION_COVERAGE[table]?.dispositions).toContain('retained');
    }
    // 10.2 and 5.2: the classification above is a claim, and this is what makes it a
    // fact. A batch pointed at either table is refused by PostgreSQL.
    const foundation = readRepositoryFile('packages/domain/db/migrations/0001_foundation.sql');
    expect(foundation).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON suppression_events FROM app_runtime, migration;');
    expect(foundation).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM app_runtime, migration;');
  });

  it('and of the append-only histories a deletion would silently rewrite', () => {
    const crm = readRepositoryFile('packages/domain/db/migrations/0004_crm.sql');
    expect(crm).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON opportunity_stage_events');
    expect(crm).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON record_merge_events');
    const outbound = readRepositoryFile('packages/domain/db/migrations/0010_outbound.sql');
    // An outbound fence is what makes at-most-once true; deleting one would make a
    // resend possible, which is invariant 1.
    expect(outbound).toContain('REVOKE DELETE, TRUNCATE ON outbound_messages');
  });

  it('gives each bounded kind its own boundary rather than one global duration', () => {
    // 10.3 states four different durations. The column is per row and the CHECK ties
    // the presence of an interval to the disposition, so a bounded kind cannot be
    // stored without a boundary and a kept kind cannot carry one.
    const foundation = readRepositoryFile('packages/domain/db/migrations/0001_foundation.sql');
    expect(foundation).toContain('retention_interval interval');
    expect(foundation).toContain('retention_policies_one_per_kind UNIQUE (workspace_id, data_kind)');
    expect(foundation).toContain('retention_policies_interval_consistent');
  });
});
