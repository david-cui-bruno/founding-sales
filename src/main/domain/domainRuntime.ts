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
import {
  buildRebuildCommand,
  deriveRefreshIdempotencyKey,
  scanPriorityProjections,
} from './startup/priorityProjectionRefresh';
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
  private state: RuntimeState = 'created';
  private services: DomainServices | undefined;
  private report: DomainStartupReport | undefined;

  constructor(input: {
    database: AppDatabase;
    clock: Clock;
    ids: IdGenerator;
  }) {
    this.database = input.database;
    this.clock = input.clock;
    this.ids = input.ids;
  }

  initialize(): DomainStartupReport {
    if (this.state === 'stopped') {
      throw new DomainRuntimeUnavailableError('The domain runtime has shut down.');
    }
    if (this.report !== undefined) return this.report;

    assertDomainStorageReady({
      database: this.database,
      expectedBusyTimeoutMs: 5000,
      expectedSchemaVersion: 6,
      expectedManifest: DOMAIN_SCHEMA_MANIFEST,
    });

    const services = createDomainServices({
      database: this.database,
      clock: this.clock,
      ids: this.ids,
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

    // 8. Enqueue exact refresh jobs, excluding corrupt prospects.
    const interval = founderLocalDate(asOf, settings.timezone);
    let projectionRebuildsQueued = 0;
    for (const candidate of scan.candidates) {
      const idempotencyKey = deriveRefreshIdempotencyKey({
        prospectId: candidate.prospectId,
        ruleVersionId: activeRule.id,
        founderLocalDate: interval,
        refreshFingerprint: candidate.refreshFingerprint,
      });
      const existing = this.database.raw.prepare(`
        SELECT id FROM jobs WHERE type = ? AND idempotency_key = ?
      `).get(PRIORITY_PROJECTION_REBUILD_JOB_TYPE, idempotencyKey) as { id: string } | undefined;
      if (existing !== undefined) continue;
      const jobId = this.ids.next();
      const evaluationId = this.ids.next();
      const command = buildRebuildCommand({
        jobId,
        evaluationId,
        candidate,
        ruleVersionId: activeRule.id,
        founderTimezone: settings.timezone,
        founderLocalDate: interval,
        evaluatedAt: asOf,
      });
      services.jobs.enqueue({
        id: jobId,
        type: PRIORITY_PROJECTION_REBUILD_JOB_TYPE,
        idempotencyKey,
        payload: command,
        at: asOf,
      });
      projectionRebuildsQueued += 1;
    }

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
      projectionRebuildsQueued,
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

function founderLocalDate(asOf: string, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date(asOf));
}
