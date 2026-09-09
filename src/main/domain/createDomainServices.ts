import { DailyReadService } from './today/dailyReadService';
import { AccountRepository } from './accounts/accountRepository';
import { AccountOutreach, createSqlAccountRoutePolicy } from './accounts/accountOutreach';
import type { AppDatabase } from '../db/database';
import { CadenceRepository } from './cadence/cadenceRepository';
import { ContactComplianceService } from './compliance/contactComplianceService';
import { JurisdictionRepository } from './compliance/jurisdictionRepository';
import { PLAYBOOK_CHANNEL_POLICIES_V2 } from './cadence/cadenceScheduler';
import { DiscoveryRepository } from './discovery/discoveryRepository';
import { DiscoveryReadService } from './discovery/discoveryReadService';
import { DiscoveryFactWriter } from './discovery/discoveryFactWriter';
import { DiscoveryService } from './discovery/discoveryService';
import { EventRepository } from './events/eventRepository';
import { IdentityRepository } from './identity/identityRepository';
import { LifecycleService } from './lifecycle/lifecycleService';
import { OptOutRepository } from './optOut/optOutRepository';
import { OptOutService } from './optOut/optOutService';
import { OutboundPermissionService } from './optOut/outboundPermissionService';
import { OutboundCommandRepository } from './outbound/outboundCommandRepository';
import { PrioritizationRepository } from './prioritization/prioritizationRepository';
import { PrioritizationService } from './prioritization/prioritizationService';
import { IntakeReceiptRepository } from './source/intakeReceiptRepository';
import { SourceRepository } from './source/sourceRepository';
import { SourceService } from './source/sourceService';
import type { Clock } from './support/clock';
import { DomainUnitOfWork } from './support/domainUnitOfWork';
import type { IdGenerator } from './support/idGenerator';
import { TodayRepository } from './today/todayRepository';
import { TodayService } from './today/todayService';
import { WorkspaceSettingsRepository } from './workspace/workspaceSettingsRepository';
import { JobRepository } from '../jobs/jobRepository';

export type DomainServices = Readonly<{
  accountOutreach: AccountOutreach;
  unitOfWork: DomainUnitOfWork;
  discoveryRepository: DiscoveryRepository;
  discoveryRead: DiscoveryReadService;
  discovery: DiscoveryService;
  jobs: JobRepository;
  identities: IdentityRepository;
  contactCompliance: ContactComplianceService;
  events: EventRepository;
  sourceRepository: SourceRepository;
  intakeReceipts: IntakeReceiptRepository;
  sources: SourceService;
  cadences: CadenceRepository;
  lifecycle: LifecycleService;
  optOut: OptOutService;
  outboundPermission: OutboundPermissionService;
  outboundCommands: OutboundCommandRepository;
  prioritizationRepository: PrioritizationRepository;
  prioritization: PrioritizationService;
  todayRepository: TodayRepository;
  today: TodayService;
  daily: DailyReadService;
  workspaceSettings: WorkspaceSettingsRepository;
}>;

/**
 * Constructs the complete same-instance domain graph exactly once.
 * Construction-only: no query, mutation, transaction, Clock read, or ID
 * allocation. Every dependency shares the one DomainUnitOfWork, exact input
 * database, Clock, and ID generator, and every binding is asserted here.
 */
export function createDomainServices(input: {
  database: AppDatabase;
  clock: Clock;
  ids: IdGenerator;
  timezone?: string;
  expectedWorkspaceId?: string;
}): DomainServices {
  const { database, clock, ids } = input;
  const timezone = input.timezone ?? 'America/New_York';
  const unitOfWork = new DomainUnitOfWork(database);
  // Read-only binding: no policy admission or implicit local execution owner.
  const accountOutreach = new AccountOutreach({ database, clock, ids, accounts: new AccountRepository({ database, clock, ids }),
    policy: createSqlAccountRoutePolicy({ database, clock, expectedWorkspaceId: input.expectedWorkspaceId }) });
  const discoveryRepository = new DiscoveryRepository({ database, unitOfWork });
  const jobs = new JobRepository(database);
  const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
  const jurisdictions = new JurisdictionRepository({ database, unitOfWork });
  const contactCompliance = new ContactComplianceService({
    database, unitOfWork, identities, jurisdictions,
    windows: PLAYBOOK_CHANNEL_POLICIES_V2, clock, ids,
  });
  const events = new EventRepository({ database, unitOfWork, clock, ids });
  const outboundCommands = new OutboundCommandRepository({ database, unitOfWork, events });
  const sourceRepository = new SourceRepository({ database, unitOfWork, clock });
  const intakeReceipts = new IntakeReceiptRepository({ database, unitOfWork, clock });
  const sources = new SourceService({
    database, unitOfWork, identities, sources: sourceRepository, receipts: intakeReceipts,
    contactCompliance,
  });
  const cadences = new CadenceRepository({ database, unitOfWork, clock });
  const lifecycle = new LifecycleService({
    database,
    unitOfWork,
    identities,
    events,
    sources: sourceRepository,
    cadences,
    clock,
    ids,
    timezone,
    policies: PLAYBOOK_CHANNEL_POLICIES_V2,
    discoveryRepository,
  });
  const optOutRepository = new OptOutRepository({ database, unitOfWork });
  const optOut = new OptOutService({
    database, unitOfWork, identities, events, optOuts: optOutRepository, lifecycle, clock, ids,
  });
  const outboundPermission = new OutboundPermissionService({
    database, unitOfWork, identities, optOuts: optOutRepository, jurisdictions,
    windows: PLAYBOOK_CHANNEL_POLICIES_V2,
  });
  const prioritizationRepository = new PrioritizationRepository({ database, unitOfWork, clock });
  const prioritization = new PrioritizationService({
    database, unitOfWork, clock, repository: prioritizationRepository, outboundPermission,
  });
  const todayRepository = new TodayRepository({ database, unitOfWork });
  const workspaceSettings = new WorkspaceSettingsRepository({ database, unitOfWork });
  const today = new TodayService({
    database, unitOfWork, clock, repository: todayRepository, priorities: prioritization,
    outboundPermission, workspaceSettings,
  });
  const discoveryRead = new DiscoveryReadService({ database, unitOfWork, clock,
    services: { discoveryRepository, today, workspaceSettings, jobs, identities, sourceRepository,
      events, outboundPermission, prioritizationRepository, prioritization } });
  const evidenceServices = { identities, sourceRepository, events, outboundPermission,
    prioritizationRepository, prioritization, workspaceSettings };
  const factWriter = new DiscoveryFactWriter({ database, unitOfWork, services: evidenceServices });
  const discovery = new DiscoveryService({ database, unitOfWork, clock, ids, factWriter,
    services: { ...evidenceServices, lifecycle, discoveryRepository, discoveryRead } });

  // Assert every final binding before any read/time/ID access.
  discoveryRepository.assertBoundTo(database, unitOfWork);
  identities.assertBoundTo(database, unitOfWork);
  contactCompliance.assertBoundTo(database, unitOfWork);
  events.assertBoundTo(database, unitOfWork);
  outboundCommands.assertBoundTo(database, unitOfWork);
  sourceRepository.assertBoundTo(database, unitOfWork);
  intakeReceipts.assertBoundTo(database, unitOfWork);
  cadences.assertBoundTo(database, unitOfWork);
  lifecycle.assertBoundTo(database, unitOfWork);
  optOutRepository.assertBoundTo(database, unitOfWork);
  outboundPermission.assertBoundTo(database, unitOfWork);
  prioritizationRepository.assertBoundTo(database, unitOfWork);
  todayRepository.assertBoundTo(database, unitOfWork);
  workspaceSettings.assertBoundTo(database, unitOfWork);

  return Object.freeze({
    accountOutreach,
    daily: new DailyReadService({ database, clock, ids, today, settings: workspaceSettings, workspaceId: input.expectedWorkspaceId }),
    unitOfWork,
    discoveryRepository,
    discoveryRead,
    discovery,
    jobs,
    identities,
    contactCompliance,
    events,
    sourceRepository,
    intakeReceipts,
    sources,
    cadences,
    lifecycle,
    optOut,
    outboundPermission,
    outboundCommands,
    prioritizationRepository,
    prioritization,
    todayRepository,
    today,
    workspaceSettings,
  });
}
