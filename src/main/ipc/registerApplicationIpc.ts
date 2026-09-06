import { registerRecoveryIpc } from '../recovery/registerRecoveryIpc';
import type { RecoveryProvider } from '../../shared/contracts/recoveryContract';
import type { FounderSalesDomain } from '../domain/founderSalesDomain';
import type { FoundationRuntime } from '../foundation/foundationRuntime';
import { appHealthSchema } from '../../shared/healthContract';
import { registerConversationsIpc } from '../conversations/registerConversationsIpc';
import { registerFridayIpc } from '../friday/registerFridayIpc';
import { registerHealthIpc } from '../health/registerHealthIpc';
import { registerImportIpc } from '../imports/registerImportIpc';
import { registerLeadDetailIpc } from '../leads/registerLeadDetailIpc';
import { registerLeadsIpc } from '../leads/registerLeadsIpc';
import { registerLearningsIpc } from '../learnings/registerLearningsIpc';
import { registerPipelineIpc } from '../pipeline/registerPipelineIpc';
import { registerReviewIpc } from '../review/registerReviewIpc';
import { registerShellIpc, type ShellProvider } from './registerShellIpc';
import { registerSourcingIpc } from '../sourcing/registerSourcingIpc';
import { registerTodayIpc } from '../today/registerTodayIpc';
import type { ConversationsProvider } from '../conversations/conversationsService';
import type { FridayProvider } from '../friday/fridayService';
import type { HealthProvider } from '../health/registerHealthIpc';
import type { ImportProvider } from '../imports/importService';
import type { LeadDetailProvider, EnrichmentRequester } from '../leads/leadDetailService';
import type { LeadsProvider } from '../leads/leadsService';
import type { LearningsProvider } from '../learnings/learningsService';
import type { PipelineProvider } from '../pipeline/pipelineService';
import type { ReviewProvider } from '../review/reviewService';
import type { SourcingProvider } from '../sourcing/registerSourcingIpc';
import type { TodayProvider } from '../today/todayService';

/**
 * The single execution gate between IPC and the encrypted domain: every
 * feature channel resolves its provider method through
 * `FoundationRuntime.withDomain`, so no request can bypass the facade.
 */
type DomainGate = Pick<FoundationRuntime, 'withDomain'> & HealthProvider;

export type FeatureRegistrars = {
  registerHealthIpc: typeof registerHealthIpc;
  registerLeadsIpc: typeof registerLeadsIpc;
  registerLeadDetailIpc: typeof registerLeadDetailIpc;
  registerTodayIpc: typeof registerTodayIpc;
  registerPipelineIpc: typeof registerPipelineIpc;
  registerReviewIpc: typeof registerReviewIpc;
  registerFridayIpc: typeof registerFridayIpc;
  registerImportIpc: typeof registerImportIpc;
  registerConversationsIpc: typeof registerConversationsIpc;
  registerLearningsIpc: typeof registerLearningsIpc;
  registerSourcingIpc: typeof registerSourcingIpc;
  registerShellIpc: typeof registerShellIpc;
  registerRecoveryIpc: typeof registerRecoveryIpc;
};

const defaultRegistrars: FeatureRegistrars = {
  registerHealthIpc,
  registerLeadsIpc,
  registerLeadDetailIpc,
  registerTodayIpc,
  registerPipelineIpc,
  registerReviewIpc,
  registerFridayIpc,
  registerImportIpc,
  registerConversationsIpc,
  registerLearningsIpc,
  registerSourcingIpc,
  registerShellIpc,
  registerRecoveryIpc,
};

export function createLeadsProvider(runtime: DomainGate): LeadsProvider {
  return {
    list: (input) => runtime.withDomain((domain) => domain.listLeadRows(input)),
    updateField: (input) =>
      runtime.withDomain((domain) => domain.updateLeadField(input)),
    bulkUpdate: (input) =>
      runtime.withDomain((domain) => domain.bulkUpdateLeads(input)),
  };
}

export function createLeadDetailProvider(
  runtime: DomainGate,
  enrichmentRequester?: EnrichmentRequester,
): LeadDetailProvider {
  return {
    get: (input) => runtime.withDomain((domain) => domain.getLeadDetail(input)),
    beginOutbound: (input) =>
      runtime.withDomain((domain) => domain.beginOutbound(input)),
    confirmTransition: (input) =>
      runtime.withDomain((domain) => domain.confirmTransition(input)),
    dismissLead: (input) =>
      runtime.withDomain((domain) => domain.dismissLead(input)),
    overrideCloudScore: (input) =>
      runtime.withDomain((domain) => domain.enqueueCloudScoreOverride(input)),
    findContactInfo: async (input) => (
      enrichmentRequester === undefined
        ? { written: false, refusalReason: 'credentials_unavailable' }
        : enrichmentRequester.request(input)
    ),
  };
}

export function createTodayProvider(runtime: DomainGate): TodayProvider {
  return {
    get: () => runtime.withDomain((domain) => domain.getToday()),
    complete: (input) =>
      runtime.withDomain((domain) => domain.completePrimaryAction(input)),
    snooze: (input) =>
      runtime.withDomain((domain) => domain.snoozePrimaryAction(input)),
    pin: (input) => runtime.withDomain((domain) => domain.pinWithinLane(input)),
    logPastActivity: (input) =>
      runtime.withDomain((domain) => domain.logPastActivity(input)),
    addLeadNote: (input) =>
      runtime.withDomain((domain) => domain.addLeadNote(input)),
    logCallOutcome: (input) =>
      runtime.withDomain((domain) => domain.logCallOutcome(input)),
    markActivityInError: (input) =>
      runtime.withDomain((domain) => domain.markActivityInError(input)),
    getLeadTriageSnapshot: (input) =>
      runtime.withDomain((domain) => domain.getLeadTriageSnapshot(input)),
    getTriageQueue: () =>
      runtime.withDomain((domain) => domain.getTriageQueue()),
    setReviewPosition: (input) =>
      runtime.withDomain((domain) => domain.setReviewPosition(input)),
  };
}

export function createPipelineProvider(runtime: DomainGate): PipelineProvider {
  return {
    get: () => runtime.withDomain((domain) => domain.getPipelineProjection()),
  };
}

export function createReviewProvider(runtime: DomainGate): ReviewProvider {
  return {
    list: (input) =>
      runtime.withDomain((domain) => domain.listReviewItems(input)),
    resolve: (input) =>
      runtime.withDomain((domain) => domain.resolveReviewItem(input)),
  };
}

export function createFridayProvider(runtime: DomainGate): FridayProvider {
  return {
    getCurrent: (input) =>
      runtime.withDomain((domain) => domain.getFridayReport(input)),
    getDrilldown: (input) =>
      runtime.withDomain((domain) => domain.getMetricDrilldown(input)),
    createJob: (input) =>
      runtime.withDomain((domain) => domain.createJobRequest(input)),
    fillJob: (input) =>
      runtime.withDomain((domain) => domain.markJobFilled(input)),
    cancelJob: (input) =>
      runtime.withDomain((domain) => domain.cancelJobRequest(input)),
  };
}

export function createImportProvider(runtime: DomainGate): ImportProvider {
  return {
    preview: (input) =>
      runtime.withDomain((domain) => domain.previewLeadImport(input)),
    remap: (input) =>
      runtime.withDomain((domain) => domain.remapLeadImport(input)),
    commit: (input) =>
      runtime.withDomain((domain) => domain.commitLeadImport(input)),
    status: (input) =>
      runtime.withDomain((domain) => domain.getImportJob(input)),
  };
}

export function createConversationsProvider(
  runtime: DomainGate,
): ConversationsProvider {
  return {
    list: (input) =>
      runtime.withDomain((domain) => domain.listConversations(input)),
    get: (input) =>
      runtime.withDomain((domain) => domain.getConversationDetail(input)),
    attachTranscript: (input) =>
      runtime.withDomain((domain) => domain.attachTranscript(input)),
  };
}

export function createLearningsProvider(runtime: DomainGate): LearningsProvider {
  return {
    list: (input) =>
      runtime.withDomain((domain) => domain.listLearnings(input)),
    capture: (input) =>
      runtime.withDomain((domain) => domain.captureLearning(input)),
    addEvidence: (input) =>
      runtime.withDomain((domain) => domain.addLearningEvidence(input)),
    updateStatus: (input) =>
      runtime.withDomain((domain) => domain.updateLearningStatus(input)),
  };
}

/**
 * Default shell provider: resolves the database location through the same
 * validated health surface the renderer sees, so the reveal target can never
 * be renderer-chosen. Electron is imported lazily because this module is
 * also exercised in plain-node tests.
 */
export function createShellProvider(
  runtime: DomainGate,
  logDirectoryPath?: string,
): ShellProvider {
  return {
    revealDatabase: async () => {
      const health = appHealthSchema.parse(await runtime.getHealth());
      const { shell } = await import('electron');
      shell.showItemInFolder(health.databasePath);
      return { revealed: true } as const;
    },
    revealLogDirectory: async () => {
      if (logDirectoryPath === undefined) throw new Error('LOG_DIRECTORY_UNAVAILABLE');
      const { shell } = await import('electron');
      shell.showItemInFolder(logDirectoryPath);
      return { revealed: true } as const;
    },
  };
}

/**
 * Registers every workflow feature slice against one runtime and returns one
 * idempotent unregister function that removes each slice exactly once, in
 * reverse registration order.
 */
export function registerApplicationIpc(
  runtime: DomainGate,
  isTrustedRendererUrl: ((url: string) => boolean) | undefined,
  registrars: FeatureRegistrars | undefined,
  sourcingProvider: SourcingProvider,
  recoveryProvider: RecoveryProvider,
  shellProvider?: ShellProvider,
  enrichmentRequester?: EnrichmentRequester,
  logDirectoryPath?: string,
): () => void {
  if (sourcingProvider === undefined) {
    throw new Error('Sourcing provider is required.');
  }
  if (recoveryProvider === undefined) throw new Error('Recovery provider is required.');
  registrars ??= defaultRegistrars;
  const unregisters = [
    registrars.registerHealthIpc(runtime, isTrustedRendererUrl),
    registrars.registerLeadsIpc(createLeadsProvider(runtime), isTrustedRendererUrl),
    registrars.registerLeadDetailIpc(
      createLeadDetailProvider(runtime, enrichmentRequester),
      isTrustedRendererUrl,
    ),
    registrars.registerTodayIpc(createTodayProvider(runtime), isTrustedRendererUrl),
    registrars.registerPipelineIpc(
      createPipelineProvider(runtime),
      isTrustedRendererUrl,
    ),
    registrars.registerReviewIpc(createReviewProvider(runtime), isTrustedRendererUrl),
    registrars.registerFridayIpc(createFridayProvider(runtime), isTrustedRendererUrl),
    registrars.registerImportIpc(createImportProvider(runtime), isTrustedRendererUrl),
    registrars.registerConversationsIpc(
      createConversationsProvider(runtime),
      isTrustedRendererUrl,
    ),
    registrars.registerLearningsIpc(
      createLearningsProvider(runtime),
      isTrustedRendererUrl,
    ),
    registrars.registerSourcingIpc(
      sourcingProvider,
      isTrustedRendererUrl,
    ),
    registrars.registerShellIpc(
      shellProvider ?? createShellProvider(runtime, logDirectoryPath),
      isTrustedRendererUrl,
    ),
    registrars.registerRecoveryIpc(recoveryProvider, isTrustedRendererUrl),
  ];

  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    for (const unregister of [...unregisters].reverse()) {
      unregister();
    }
  };
}

export type { FounderSalesDomain };
