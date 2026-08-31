import type { AppDatabase } from '../db/database';
import { CadenceRepository } from './cadence/cadenceRepository';
import { FOUNDER_CHANNEL_POLICIES_V1 } from './cadence/cadenceScheduler';
import { EventRepository } from './events/eventRepository';
import { IdentityRepository } from './identity/identityRepository';
import { LifecycleService } from './lifecycle/lifecycleService';
import { OptOutRepository } from './optOut/optOutRepository';
import { OptOutService } from './optOut/optOutService';
import { OutboundPermissionService } from './optOut/outboundPermissionService';
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
  unitOfWork: DomainUnitOfWork;
  jobs: JobRepository;
  identities: IdentityRepository;
  events: EventRepository;
  sourceRepository: SourceRepository;
  intakeReceipts: IntakeReceiptRepository;
  sources: SourceService;
  cadences: CadenceRepository;
  lifecycle: LifecycleService;
  optOut: OptOutService;
  outboundPermission: OutboundPermissionService;
  prioritizationRepository: PrioritizationRepository;
  prioritization: PrioritizationService;
  todayRepository: TodayRepository;
  today: TodayService;
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
}): DomainServices {
  const { database, clock, ids } = input;
  const timezone = input.timezone ?? 'America/New_York';
  const unitOfWork = new DomainUnitOfWork(database);
  const jobs = new JobRepository(database);
  const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
  const events = new EventRepository({ database, unitOfWork, clock, ids });
  const sourceRepository = new SourceRepository({ database, unitOfWork, clock });
  const intakeReceipts = new IntakeReceiptRepository({ database, unitOfWork, clock });
  const sources = new SourceService({
    database, unitOfWork, identities, sources: sourceRepository, receipts: intakeReceipts,
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
    policies: FOUNDER_CHANNEL_POLICIES_V1,
  });
  const optOutRepository = new OptOutRepository({ database, unitOfWork });
  const optOut = new OptOutService({
    database, unitOfWork, identities, events, optOuts: optOutRepository, lifecycle, clock, ids,
  });
  const outboundPermission = new OutboundPermissionService({
    database, unitOfWork, identities, optOuts: optOutRepository,
  });
  const prioritizationRepository = new PrioritizationRepository({ database, unitOfWork, clock });
  const prioritization = new PrioritizationService({
    database, unitOfWork, clock, repository: prioritizationRepository, outboundPermission,
  });
  const todayRepository = new TodayRepository({ database, unitOfWork });
  const today = new TodayService({
    database, unitOfWork, clock, repository: todayRepository, priorities: prioritization,
    outboundPermission,
  });
  const workspaceSettings = new WorkspaceSettingsRepository({ database, unitOfWork });

  // Assert every final binding before any read/time/ID access.
  identities.assertBoundTo(database, unitOfWork);
  events.assertBoundTo(database, unitOfWork);
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
    unitOfWork,
    jobs,
    identities,
    events,
    sourceRepository,
    intakeReceipts,
    sources,
    cadences,
    lifecycle,
    optOut,
    outboundPermission,
    prioritizationRepository,
    prioritization,
    todayRepository,
    today,
    workspaceSettings,
  });
}
