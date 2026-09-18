import type { DomainServices } from '../../src/main/domain/createDomainServices';
import { PRIORITY_PROJECTION_REBUILD_JOB_TYPE } from '../../src/main/domain/startup/domainStartupTypes';
import {
  buildRebuildCommand,
  deriveRefreshIdempotencyKey,
  scanPriorityProjections,
} from '../../src/main/domain/startup/priorityProjectionRefresh';
import type { JobRecord } from '../../src/main/jobs/jobTypes';

function founderLocalDate(asOf: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(asOf));
}

/**
 * Seeds the exact queued `priority_projection_rebuild_v1` commands that
 * `DomainRuntime.bootstrap` used to enqueue at every startup.
 *
 * Startup stopped enqueuing them in Batch 10 (D11 step 6a) and now retires
 * whatever it finds queued, because nothing ever executed them:
 * `createDiscoveryWorker` has no caller in `src/`. Tests whose subject is the
 * executor, the recovery ledger or the restart path still need a real queued
 * root command, so they seed it here instead of relying on startup.
 *
 * It calls the same three exported functions bootstrap called, in the same
 * order, with the same inputs, so the payload bytes, the reasons and the
 * canonical idempotency key are byte-for-byte what startup produced. Call it
 * after `initialize()`: the retirement sweep runs inside bootstrap, so a job
 * seeded before it would be cancelled.
 */
export function seedPriorityRebuildJobs(input: {
  services: DomainServices;
  listEligibleProspectIds: () => readonly string[];
  asOf: string;
  nextId: () => string;
}): readonly JobRecord[] {
  const { services, asOf } = input;
  const activeRule = services.prioritizationRepository.getActiveRuleVersion();
  if (activeRule === null) throw new Error('SEED_REBUILD_NO_ACTIVE_RULE');
  const timezone = services.workspaceSettings.read().timezone;
  const scan = scanPriorityProjections({
    repository: services.prioritizationRepository,
    listEligibleProspectIds: input.listEligibleProspectIds,
    activeRule,
    asOf,
    workspaceTimezone: timezone,
  });
  const interval = founderLocalDate(asOf, timezone);
  const seeded: JobRecord[] = [];
  for (const candidate of scan.candidates) {
    const jobId = input.nextId();
    const evaluationId = input.nextId();
    seeded.push(services.jobs.enqueue({
      id: jobId,
      type: PRIORITY_PROJECTION_REBUILD_JOB_TYPE,
      idempotencyKey: deriveRefreshIdempotencyKey({
        prospectId: candidate.prospectId,
        ruleVersionId: activeRule.id,
        founderLocalDate: interval,
        refreshFingerprint: candidate.refreshFingerprint,
      }),
      payload: buildRebuildCommand({
        jobId,
        evaluationId,
        candidate,
        ruleVersionId: activeRule.id,
        founderTimezone: timezone,
        founderLocalDate: interval,
        evaluatedAt: asOf,
      }),
      at: asOf,
    }));
  }
  return seeded;
}
