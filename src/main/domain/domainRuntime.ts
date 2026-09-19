import type { AppDatabase } from '../db/database';
import { BUILTIN_CADENCES } from './cadence/builtinCadences';
import {
  BUILTIN_PRIORITIZATION_RULE_V1,
} from './prioritization/builtinPrioritizationRules';
import type { PrioritizationRuleVersion } from './prioritization/prioritizationRepository';
import { auditDomainInvariants } from './lifecycle/invariantAudit';
import { createDomainServices, type DomainServices } from './createDomainServices';
import {
  DOMAIN_SCHEMA_MANIFEST,
  assertDomainStorageReady,
} from './startup/storageReadiness';
import { scanPriorityProjections } from './startup/priorityProjectionRefresh';
import {
  DomainRuntimeBlockedError,
  DomainRuntimeUnavailableError,
  DomainStartupFatalError,
  PRIORITY_PROJECTION_REBUILD_JOB_TYPE,
  type DomainStartupReport,
} from './startup/domainStartupTypes';
import type { Clock } from './support/clock';
import type { IdGenerator } from './support/idGenerator';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  }
  return value;
}

type RuntimeState = 'created' | 'ready' | 'blocked' | 'stopped';

/**
 * One main-process-only domain runtime. `initialize()` is synchronous and
 * idempotent; infrastructure failure throws a typed fatal error and produces
 * no usable runtime/report. Typed invariant violations commit the immutable
 * startup report, return `blocked`, and expose diagnostics only.
 */
export class DomainRuntime {
  private readonly database: AppDatabase;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly expectedWorkspaceId: string | undefined;
  private state: RuntimeState = 'created';
  private services: DomainServices | undefined;
  private report: DomainStartupReport | undefined;

  constructor(input: {
    database: AppDatabase;
    clock: Clock;
    ids: IdGenerator;
    expectedWorkspaceId?: string;
  }) {
    this.database = input.database;
    this.clock = input.clock;
    this.ids = input.ids;
    this.expectedWorkspaceId = input.expectedWorkspaceId;
  }

  initialize(): DomainStartupReport {
    if (this.state === 'stopped') {
      throw new DomainRuntimeUnavailableError('The domain runtime has shut down.');
    }
    if (this.report !== undefined) return this.report;

    assertDomainStorageReady({
      database: this.database,
      expectedBusyTimeoutMs: 5000,
      expectedSchemaVersion: 30,
      expectedManifest: DOMAIN_SCHEMA_MANIFEST,
    });

    const services = createDomainServices({
      database: this.database,
      clock: this.clock,
      ids: this.ids,
      expectedWorkspaceId: this.expectedWorkspaceId,
    });

    let report: DomainStartupReport;
    try {
      report = services.unitOfWork.immediate(() => this.bootstrap(services));
    } catch (error) {
      if (error instanceof DomainStartupFatalError) throw error;
      throw new DomainStartupFatalError(
        'bootstrap_failed',
        error instanceof Error ? error.message : 'Domain bootstrap failed.',
      );
    }

    this.services = services;
    this.report = report;
    this.state = report.status === 'ready' ? 'ready' : 'blocked';
    return report;
  }

  private bootstrap(services: DomainServices): DomainStartupReport {
    // Read the clock exactly once; asOf covers the whole transaction.
    const asOf = this.clock.now();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(asOf)) {
      throw new DomainStartupFatalError('bootstrap_failed', 'The clock produced a noncanonical instant.');
    }

    // 1. Strict-read workspace settings and founder timezone.
    const settings = services.workspaceSettings.read();

    // 2. Install all six Task 8 built-ins idempotently; assert exact catalog.
    const installedCadences = services.cadences.installBuiltins();
    if (installedCadences.length !== BUILTIN_CADENCES.length) {
      throw new DomainStartupFatalError('catalog_conflict', 'Cadence catalog install mismatch.');
    }

    // 3. Install founder-priority-v1 idempotently; assert its canonical hash.
    const installedRule = services.prioritizationRepository.installRuleVersion(
      BUILTIN_PRIORITIZATION_RULE_V1,
    );
    if (installedRule.contentHash !== BUILTIN_PRIORITIZATION_RULE_V1.contentHash) {
      throw new DomainStartupFatalError('catalog_conflict', 'Built-in rule hash mismatch.');
    }

    // 4. Resolve/activate the active rule pointer.
    let activeRule: PrioritizationRuleVersion;
    if (settings.activePrioritizationRuleVersionId === null) {
      activeRule = services.prioritizationRepository.activateRuleVersion({
        ruleVersionId: installedRule.id,
        expectedActiveRuleVersionId: null,
      });
    } else {
      let resolved: PrioritizationRuleVersion | null;
      try {
        resolved = services.prioritizationRepository.getRuleVersion(
          settings.activePrioritizationRuleVersionId,
        );
      } catch {
        throw new DomainStartupFatalError(
          'active_rule_invalid', 'The active rule pointer names a malformed rule version.',
        );
      }
      if (resolved === null) {
        throw new DomainStartupFatalError(
          'active_rule_invalid', 'The active rule pointer names a missing rule version.',
        );
      }
      activeRule = resolved;
    }

    // 5. Recover running jobs with the injected asOf.
    const interruptedJobsRecovered = services.jobs.recoverInterruptedJobs(asOf);

    // 6. Full explicit-asOf invariant audit in the same snapshot.
    let violations: readonly { kind: string; recordId: string; message: string }[];
    try {
      violations = auditDomainInvariants({ database: this.database, asOf });
    } catch (error) {
      throw new DomainStartupFatalError(
        'audit_execution_failed',
        error instanceof Error ? error.message : 'The invariant audit failed to execute.',
      );
    }
    const sortedViolations = [...violations].sort((left, right) => (
      left.kind !== right.kind
        ? (left.kind < right.kind ? -1 : 1)
        : left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0
    ));

    // 7. Scan valid prospects for repairable projection refresh work.
    const scan = scanPriorityProjections({
      repository: services.prioritizationRepository,
      listEligibleProspectIds: () => this.listEligibleProspectIds(),
      activeRule,
      asOf,
      workspaceTimezone: settings.timezone,
    });

    // 8. Retire the rebuild queue this step used to fill. Nothing executes
    // `priority_projection_rebuild_v1`: the discovery worker that consumed it was
    // never composed and has since been removed, so every job enqueued here stayed
    // queued for the life of the installed database. Startup no longer enqueues, and the jobs an earlier build left queued
    // are cancelled with the same `asOf`. Rows are never deleted: the command payload,
    // its idempotency key and its retry count stay readable, and `finished_at` records
    // the retirement. It runs once in practice, because after the first startup there
    // is nothing left to match and no later startup creates more.
    //
    // Only the canonical jobs this step created are retired: `retry_count = 0` and no
    // recovery metadata. A retried or recovery-lineage job exists only because
    // something executed its root, so a caller that composed a discovery worker kept
    // its queue; this sweep never reaches into that lineage.
    //
    // `scan.candidates` above is still the honest count of prospects whose projection
    // would need a rebuild; it just no longer becomes durable work.
    this.database.raw.prepare(`
      UPDATE jobs
      SET state = 'cancelled', result_json = NULL, error_code = NULL, error_message = NULL,
          started_at = NULL, finished_at = ?, updated_at = ?
      WHERE type = ? AND state = 'queued' AND retry_count = 0
        AND (json_valid(payload_json) = 0 OR json_extract(payload_json, '$.recovery') IS NULL)
    `).run(asOf, asOf, PRIORITY_PROJECTION_REBUILD_JOB_TYPE);

    // Corrupt/divergent projections are blocking violations, never rebuilt.
    const corruptionViolations = scan.corruptProspectIds.map((prospectId) => Object.freeze({
      kind: 'priority_projection_corrupt',
      recordId: prospectId,
      message: 'The priority projection or its evaluation is corrupt or divergent.',
    }));
    const allViolations = [...sortedViolations, ...corruptionViolations].sort((left, right) => (
      left.kind !== right.kind
        ? (left.kind < right.kind ? -1 : 1)
        : left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0
    ));

    // 9. Re-read postconditions.
    const pendingProjectionRebuilds = (this.database.raw.prepare(`
      SELECT COUNT(*) AS count FROM jobs
      WHERE type = ? AND state IN ('queued', 'running')
    `).get(PRIORITY_PROJECTION_REBUILD_JOB_TYPE) as { count: number }).count;
    const settingsAfter = services.workspaceSettings.read();
    if (settingsAfter.activePrioritizationRuleVersionId !== activeRule.id) {
      throw new DomainStartupFatalError('bootstrap_failed', 'The active rule postcondition failed.');
    }

    // 10. Build and freeze the report.
    return deepFreeze({
      status: allViolations.length === 0 ? 'ready' as const : 'blocked' as const,
      evaluatedAt: asOf,
      activePrioritizationRuleVersionId: activeRule.id,
      violations: allViolations,
      blockingViolationCount: allViolations.length,
      repairableIssueCount: scan.candidates.length,
      projectionRefreshCandidateCount: scan.candidates.length,
      // Startup stopped enqueuing in Batch 10 (D11 step 6a); always zero.
      projectionRebuildsQueued: 0,
      pendingProjectionRebuilds,
      interruptedJobsRecovered,
    });
  }

  private listEligibleProspectIds(): readonly string[] {
    const rows = this.database.raw.prepare(`
      SELECT prospect.id AS id
      FROM prospects AS prospect
      JOIN persons AS person ON person.id = prospect.person_id
      WHERE prospect.qualification_state = 'eligible'
        AND person.opted_out = 0
        AND person.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM opt_out_tombstones AS tombstone
          WHERE tombstone.person_id = person.id
        )
      ORDER BY prospect.id COLLATE BINARY
    `).all() as { id: string }[];
    return rows.map((row) => row.id);
  }

  getDiagnostics(): DomainStartupReport {
    if (this.report === undefined) {
      throw new DomainRuntimeUnavailableError();
    }
    return this.report;
  }

  getServices(): DomainServices {
    if (this.state === 'stopped' || this.report === undefined || this.services === undefined) {
      throw new DomainRuntimeUnavailableError();
    }
    if (this.report.status !== 'ready') {
      throw new DomainRuntimeBlockedError();
    }
    return this.services;
  }

  /** Idempotent; never closes SQLite. FoundationRuntime owns the database. */
  shutdown(): void {
    this.state = 'stopped';
    this.services = undefined;
  }
}
