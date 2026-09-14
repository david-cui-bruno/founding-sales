import { ResearchDiscoveryError } from '../../../../src/main/research/researchDiscoveryError';
import { assertGuidedResearch, guardGuidedResearch, guidedResearchMarkerKey, type ResearchSetupProfile } from './researchSetup';
import { TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { ownerResearchSourceSchema, ownerResearchSourceKey } from '../../../../src/shared/contracts/ownerCommandContract';
import { pairingKey, type WorkerAuth } from './workerAuth';
import { fingerprint, type DynamoAdapter } from './dynamoStore';
import { createCompanyPageProvider, type PageHttp } from '../../../../src/main/research/companyPageProvider';
import { createFetchedReceiptPolicy } from '../../../../src/main/research/companySourcePolicy';
import { createCompanyPreparation, createCompanyResearchWorker } from '../../../../src/main/research/companyResearchWorker';
import { createCompanyDiscoveryProvider, requestCompanyDiscovery } from '../../../../src/main/research/companyDiscoveryProvider';
import { createWorkerAccountRepository } from './workerAccountRepository';
import { budgetSchema, createDiscoveryReservationStore } from './discoveryReservationStore';
import type { SourceTickReport } from './sourceCoordinator';
import type { AccountResearchStore } from '../../../../src/main/research/companyResearchTypes';
import type { ResearchOnceRequest, ResearchOnceNextReceipt } from './researchOnceContract';
export type SourceResearchBoundaries = { loadCredentials(workspaceId: string, signal: AbortSignal): Promise<{ apiKey: string; model: string }>;
  pageHttp: PageHttp; resolve(hostname: string): Promise<string[]> };
export type ResolvedResearchSuccessor = { runId: string; receipt: { key: string; rev: number; fingerprint: string }; parent: { key: string; rev: number; fingerprint: string } };
export type ResearchCoordinatorOptions = { auth: WorkerAuth; fetch: typeof globalThis.fetch; research?: SourceResearchBoundaries; researchSetupProfile?: ResearchSetupProfile; resolvedSuccessor?: ResolvedResearchSuccessor };
export function researchRunId(workspaceId: string, pairingId: string, research: unknown): string {
  const identity = fingerprint({ workspaceId, pairingId, research });
  return `${identity.slice(0,8)}-${identity.slice(8,12)}-4${identity.slice(13,16)}-a${identity.slice(17,20)}-${identity.slice(20,32)}`;
}

export function researchSuccessorRunId(request: ResearchOnceNextReceipt['request']): string {
  const hash = fingerprint({ version: 'research-once-next-v1', workspaceId: request.workspaceId, pairingId: request.pairingId,
    parentRunId: request.parentRunId, researchFingerprint: request.researchFingerprint, currentRevision: request.expectedSourceRevision,
    expectedExecutionRevision: 3, descriptorFingerprint: request.descriptorFingerprint });
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
export async function runResearch(input: ResearchCoordinatorOptions, signal: AbortSignal, report: SourceTickReport, once?: ResearchOnceRequest) {
    const store = input.auth.store;
    const boundaries = input.research; if (!boundaries) return;
    const row = await store.get<unknown>(ownerResearchSourceKey()); if (!row) return;
    const config = ownerResearchSourceSchema.parse(row.data);
    if (config.workspaceId !== store.options.workspaceId || config.state !== 'active' || !config.research) return;
    const guided = await guardGuidedResearch(store, config, input.researchSetupProfile ?? {});
    const settings = config.research;
    if (once && (!guided || config.pairingId !== once.pairingId || config.revision !== once.expectedSourceRevision
      || fingerprint(settings) !== once.researchFingerprint || settings.discoveryLimits.maxCompanies !== 1)) return;
    // Refuse missing page budget BEFORE reserving discovery/provider spend.
    const runId = input.resolvedSuccessor?.runId ?? researchRunId(config.workspaceId, config.pairingId, settings);
    if (once) {
      const row = await store.get('BUDGET#research');
      if (!row) return;
      const budget = budgetSchema.parse(row.data);
      const prior = await createDiscoveryReservationStore(store.options).readRun(runId);
      if (prior && (!prior.researchOnceBinding || prior.researchOnceBinding.pairingId !== once.pairingId
        || prior.researchOnceBinding.researchFingerprint !== once.researchFingerprint || prior.researchOnceBinding.sourceRevision !== once.expectedSourceRevision)) return;
      if (!prior && budget.limit - budget.spent < settings.researchLimits.maxCostMicros) return;
    }
    if (settings.workspaceId !== config.workspaceId || settings.researchLimits.maxCostMicros > settings.maxAccountBudgetMicros) throw new Error('research_config_mismatch');
    const pairing = await input.auth.activePairing(config.pairingId);
    async function guard() {
      signal.throwIfAborted();
      const marker = await guardGuidedResearch(store, config, input.researchSetupProfile ?? {});
      if (marker?.rev !== guided?.rev) throw new Error('research_setup_marker_changed');
      if (input.resolvedSuccessor) {
        for (const expected of [input.resolvedSuccessor.receipt, input.resolvedSuccessor.parent]) {
          const row = await store.get<unknown>(expected.key);
          if (!row || row.rev !== expected.rev || fingerprint(row.data) !== expected.fingerprint) throw new Error('research_next_binding_changed');
        }
      }
      const current = await store.get<unknown>(ownerResearchSourceKey());
      if (!current || current.rev !== row!.rev || fingerprint(current.data) !== fingerprint(config)) throw new Error('research_source_changed');
      const active = await input.auth.activePairing(config.pairingId);
      if (active.rev !== pairing.rev) throw new Error('research_pairing_changed');
      // No await after this freshness/binding check before releasing the guard.
      if (marker) assertGuidedResearch(marker.data, config, input.researchSetupProfile ?? {}, store.now());
    }
    // The SDK boundary adds actual config and pairing CAS to every C1 mutation.
    // Reading a selector cannot approve budget, grant AUTH, or reset unknown spend.
    const dynamo: DynamoAdapter = { async send(command) {
      if (!(command instanceof TransactWriteItemsCommand)) return store.options.dynamo.send(command);
      await guard();
      return store.options.dynamo.send(new TransactWriteItemsCommand({ ...command.input, TransactItems: [...(command.input.TransactItems ?? []),
        store.check(ownerResearchSourceKey(), row.rev), store.check(pairingKey(config.pairingId), pairing.rev), guided ? store.check(guidedResearchMarkerKey, guided.rev) : store.absent(guidedResearchMarkerKey),
        ...(input.resolvedSuccessor ? [store.check(input.resolvedSuccessor.receipt.key, input.resolvedSuccessor.receipt.rev), store.check(input.resolvedSuccessor.parent.key, input.resolvedSuccessor.parent.rev)] : [])] }));
    } };
    const options = { ...store.options, dynamo, ...(once ? { researchOnceBinding: {
      pairingId: config.pairingId, researchFingerprint: fingerprint(settings), sourceRevision: config.revision,
    } } : {}) };
    const accounts = createWorkerAccountRepository(options);
    const reservations = createDiscoveryReservationStore(options);
    const discovery = createCompanyDiscoveryProvider({ capability: settings.capability, request: async (query, limits, requestSignal) => {
      await guard(); const credentials = await boundaries.loadCredentials(config.workspaceId, requestSignal);
      await guard();
      if (credentials.model !== settings.capability.model) throw new Error('research_model_mismatch');
      try { return await requestCompanyDiscovery({ query, limits, capability: settings.capability, credentials, signal: requestSignal, fetch: input.fetch }); }
      catch (error) {
        if (!once || signal.aborted || error instanceof ResearchDiscoveryError) throw error;
        throw new Error('research_discovery_uncertain');
      }
    } });
    let selectedJobId: string | undefined;
    let selectedAccountId: string | undefined;
    const selectedAccounts: AccountResearchStore = once ? {
      create: value => accounts.create(value), snapshot: (id, at) => accounts.snapshot(id, at),
      admitEvidence: (batch, claim) => accounts.admitEvidence(batch, claim), settle: value => accounts.settle(value),
      enqueue: async (value: Parameters<typeof accounts.enqueue>[0]) => {
        if (selectedJobId && selectedJobId !== value.commandId) throw new Error('research_selection_conflict');
        selectedJobId = value.commandId; selectedAccountId = value.accountId;
        await accounts.enqueue(value);
      },
      claimNext: (asOf: string) => selectedJobId ? accounts.claimExact(selectedJobId, asOf, { accountId: selectedAccountId!, limits: settings.researchLimits }) : Promise.resolve(null),
    } : accounts;
    const prepared = await createCompanyPreparation({ store: selectedAccounts, reservations, discovery, configuration: settings }).prepare(runId, signal);
    report.status = 'completed';
    if (prepared.status !== 'prepared') { report.held++; return; }
    report.researchPrepared++;
    const pages = createCompanyPageProvider({ receipts: createFetchedReceiptPolicy(), clock: options.clock,
      permitted: (url) => settings.permittedSources.includes(url),
      resolve: async hostname => { await guard(); return boundaries.resolve(hostname); },
      http: async request => { await guard(); return boundaries.pageHttp(request); },
      onFetched: (source, accountId) => accounts.recordFetchedSource({ accountId, source }) });
    const worker = createCompanyResearchWorker({ store: selectedAccounts, clock: options.clock, pages: { async research(snapshot, limits, requestSignal) {
      await guard();
      if (!prepared.accountIds.includes(snapshot.account.id) || fingerprint(limits) !== fingerprint(settings.researchLimits)) throw new Error('research_job_config_mismatch');
      return pages.research(snapshot, limits, requestSignal);
    } } });
    const result = await worker.runNext(signal);
    if (result === 'completed') report.researchCompleted++;
    if (result === 'parked') report.held++;
  }
