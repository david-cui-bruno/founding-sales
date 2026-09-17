import { registerLocalWorkspaceIpc } from '../workspace/registerLocalWorkspaceIpc';
import { createLocalWorkspaceProvider, type SelectedCompanyResearchPort, type CompanyResearchSettingsLifecycle } from '../workspace/localWorkspaceProvider';
import type { CompanyDraftPreparationPort } from '../outreach/companyDraftPreparationService';
import { registerDailyIpc } from '../today/registerDailyIpc';
import type { DailyApi } from '../../shared/contracts/dailyContract';
import { registerRecoveryIpc } from '../recovery/registerRecoveryIpc';
import type { RecoveryProvider } from '../../shared/contracts/recoveryContract';
import type { FounderSalesDomain } from '../domain/founderSalesDomain';
import type { FoundationRuntime } from '../foundation/foundationRuntime';
import { appHealthSchema } from '../../shared/healthContract';
import { registerHealthIpc } from '../health/registerHealthIpc';
import { registerLeadDetailIpc } from '../leads/registerLeadDetailIpc';
import { registerLeadsIpc } from '../leads/registerLeadsIpc';
import { registerShellIpc, type ShellProvider } from './registerShellIpc';
import type { HealthProvider } from '../health/registerHealthIpc';
import type { LeadDetailProvider } from '../leads/leadDetailService';
import type { LeadsProvider } from '../leads/leadsService';

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
  registerDailyIpc: typeof registerDailyIpc;
  registerLocalWorkspaceIpc: typeof registerLocalWorkspaceIpc;
  registerShellIpc: typeof registerShellIpc;
  registerRecoveryIpc: typeof registerRecoveryIpc;
};

const defaultRegistrars: FeatureRegistrars = {
  registerHealthIpc,
  registerLeadsIpc,
  registerLeadDetailIpc,
  registerDailyIpc,
  registerLocalWorkspaceIpc,
  registerShellIpc,
  registerRecoveryIpc,
};

export function createLeadsProvider(runtime: DomainGate): LeadsProvider {
  return {
    list: (input) => runtime.withDomain((domain) => domain.listLeadRows(input)),
  };
}

export function createLeadDetailProvider(runtime: DomainGate): LeadDetailProvider {
  return {
    get: (input) => runtime.withDomain((domain) => domain.getLeadDetail(input)),
  };
}

export function createDailyProvider(runtime: Pick<DomainGate, 'withDomain'>): DailyApi {
  return { get: () => runtime.withDomain(domain => domain.getDaily()) };
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
  runtime: DomainGate & Pick<FoundationRuntime, 'withDatabase'>,
  isTrustedRendererUrl: ((url: string) => boolean) | undefined,
  registrars: FeatureRegistrars | undefined,
  recoveryProvider: RecoveryProvider,
  shellProvider?: ShellProvider,
  logDirectoryPath?: string,
  options?: { selectedCompanyResearch?: { current(): SelectedCompanyResearchPort | null }; companyResearchSettings?: CompanyResearchSettingsLifecycle;
    companyDraftPreparation?: CompanyDraftPreparationPort },
): () => void {
  if (recoveryProvider === undefined) throw new Error('Recovery provider is required.');
  registrars ??= defaultRegistrars;
  const registrations = [
    () => registrars.registerHealthIpc(runtime, isTrustedRendererUrl),
    () => registrars.registerLeadsIpc(createLeadsProvider(runtime), isTrustedRendererUrl),
    () => registrars.registerLeadDetailIpc(createLeadDetailProvider(runtime), isTrustedRendererUrl),
    () => registrars.registerShellIpc(
      shellProvider ?? createShellProvider(runtime, logDirectoryPath),
      isTrustedRendererUrl,
    ),
    () => registrars.registerRecoveryIpc(recoveryProvider, isTrustedRendererUrl),
    () => registrars.registerDailyIpc(createDailyProvider(runtime), isTrustedRendererUrl),
    () => registrars.registerLocalWorkspaceIpc(createLocalWorkspaceProvider(runtime, options?.selectedCompanyResearch, options?.companyResearchSettings, options?.companyDraftPreparation), isTrustedRendererUrl),
  ];

  const unregisters: (() => void)[] = [];
  const cleanup = (): unknown[] => {
    const errors: unknown[] = [];
    for (const unregister of unregisters.splice(0).reverse()) {
      try { unregister(); } catch (error) { errors.push(error); }
    }
    return errors;
  };
  try {
    for (const register of registrations) unregisters.push(register());
  } catch (error) {
    const errors = cleanup();
    if (errors.length > 0) throw new AggregateError([error, ...errors], 'Application IPC registration and rollback failed.', { cause: error });
    throw error;
  }
  return () => {
    const errors = cleanup();
    if (errors.length > 0) throw new AggregateError(errors, 'Application IPC cleanup failed.');
  };
}

export type { FounderSalesDomain };
