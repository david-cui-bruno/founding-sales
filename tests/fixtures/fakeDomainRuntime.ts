import type { DomainRuntime } from '../../src/main/domain/domainRuntime';
import type { DomainStartupReport } from '../../src/main/domain/startup/domainStartupTypes';

export type FakeDomainRuntimeOptions = {
  status?: 'ready' | 'blocked';
  interruptedJobsRecovered?: number;
  onInitialize?: () => void;
  onShutdown?: () => void;
};

type FoundationDomainRuntime = Pick<
  DomainRuntime,
  'initialize' | 'getDiagnostics' | 'getServices' | 'shutdown'
>;

export function fakeStartupReport(
  overrides: Partial<{
    status: 'ready' | 'blocked';
    interruptedJobsRecovered: number;
  }> = {},
): DomainStartupReport {
  return Object.freeze({
    status: overrides.status ?? 'ready',
    evaluatedAt: '2026-08-30T12:00:00.000Z',
    activePrioritizationRuleVersionId: 'founder-priority-v1',
    violations: Object.freeze([]),
    blockingViolationCount: overrides.status === 'blocked' ? 1 : 0,
    repairableIssueCount: 0,
    projectionRefreshCandidateCount: 0,
    projectionRebuildsQueued: 0,
    pendingProjectionRebuilds: 0,
    interruptedJobsRecovered: overrides.interruptedJobsRecovered ?? 0,
  }) as DomainStartupReport;
}

export function fakeDomainRuntime(
  options: FakeDomainRuntimeOptions = {},
): FoundationDomainRuntime {
  const report = fakeStartupReport({
    status: options.status,
    interruptedJobsRecovered: options.interruptedJobsRecovered,
  });
  return {
    initialize: () => {
      options.onInitialize?.();
      return report;
    },
    getDiagnostics: () => report,
    getServices: () => ({
      jobs: { listActive: (): never[] => [] },
    }) as never,
    shutdown: () => {
      options.onShutdown?.();
    },
  };
}
