import { createHash } from 'node:crypto';
import { z } from 'zod';
import { accountFingerprint } from '../domain/accounts/accountEvidence';
import { companySourcePolicy } from './companySourcePolicy';
import { audienceQuerySchema, researchCapabilitySchema, researchLimitsSchema, type AudienceQuery, type ResearchCapability, type ResearchLimits, type CompanyDiscoveryPort, type DiscoveryReservationStore, type AccountResearchStore, type CompanyPagePort, type CompanyResearchWorker } from './companyResearchTypes';
/** No scheduling, eager claim, provider access, or default activation. */
export function createCompanyResearchWorker(options: { store: AccountResearchStore; pages: CompanyPagePort; clock: { now(): string };
  issue?: (code: 'company_research_parked', accountId: string) => void }): CompanyResearchWorker {
  return { async runNext(signal) {
    if (signal.aborted) return 'idle';
    const job = await options.store.claimNext(options.clock.now());
    if (!job) return 'idle';
    // A receipt is stronger evidence than an interrupted in-memory control flow.
    if (job.receiptCommitted) {
      await options.store.settle({ jobId: job.id, claimToken: job.claimToken, status: 'completed', receiptCommandId: job.receiptCommandId, costMicros: job.costMicros });
      return 'completed';
    }
    let committed = false;
    try {
      signal.throwIfAborted();
      const snapshot = await options.store.snapshot(job.accountId, options.clock.now());
      const batch = await options.pages.research(snapshot, job.limits, signal);
      signal.throwIfAborted();
      await options.store.admitEvidence({ ...batch, commandId: job.receiptCommandId, accountId: job.accountId, expectedVersion: snapshot.account.version }, { jobId: job.id, claimToken: job.claimToken });
      committed = true;
    } catch {
      await options.store.settle({ jobId: job.id, claimToken: job.claimToken, status: 'parked', receiptCommandId: null, costMicros: null });
      options.issue?.('company_research_parked', job.accountId);
      return 'parked';
    }
    // Keep settlement outside catch: a crash here must leave the receipt recoverable.
    if (committed) await options.store.settle({ jobId: job.id, claimToken: job.claimToken, status: 'completed', receiptCommandId: job.receiptCommandId, costMicros: null });
    return 'completed';
  } };
}

export type CompanyPreparationConfiguration = { workspaceId: string; budgetId: string; audience: AudienceQuery;
  discoveryLimits: ResearchLimits; researchLimits: ResearchLimits; capability: ResearchCapability };
export function discoveryInputFingerprint(config: CompanyPreparationConfiguration): string {
  const audience = audienceQuerySchema.parse(config.audience);
  return accountFingerprint({ audience: { ...audience, regions: [...audience.regions].sort(), terms: [...audience.terms].sort() },
    discoveryLimits: researchLimitsSchema.parse(config.discoveryLimits), researchLimits: researchLimitsSchema.parse(config.researchLimits),
    capability: researchCapabilitySchema.parse(config.capability) });
}
export function derivedCommand(commandId: string, domain: string, operation: string): string {
  const hash = createHash('sha256').update(JSON.stringify([commandId, domain, operation])).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
/** Offline assembly boundary. Missing configuration OR durable reservation store
 * denies operation. C1 supplies that ledger, never an ephemeral production stub. */
export function createCompanyPreparation(options: { store: AccountResearchStore; discovery: CompanyDiscoveryPort;
  reservations?: DiscoveryReservationStore; configuration?: CompanyPreparationConfiguration }) {
  return { async prepare(commandId: string, signal: AbortSignal): Promise<{ status: 'prepared' | 'blocked'; accountIds: string[] }> {
    const config = options.configuration;
    const blocked = { status: 'blocked' as const, accountIds: [] as string[] };
    if (!config || !options.reservations || signal.aborted) return blocked;
    z.uuid().parse(commandId);
    z.string().min(1).max(200).parse(config.workspaceId); z.string().min(1).max(200).parse(config.budgetId);
    const inputFingerprint = discoveryInputFingerprint(config);
    if (config.capability.searchCostMicros + config.capability.modelCostMicros > config.discoveryLimits.maxCostMicros) return blocked;
    const identity = { commandId, workspaceId: config.workspaceId, budgetId: config.budgetId, inputFingerprint };
    const reservation = await options.reservations.reserveOnce({ ...identity,
      searchCostMicros: config.capability.searchCostMicros, modelCostMicros: config.capability.modelCostMicros });
    if (reservation.status === 'denied' || signal.aborted || (reservation.status === 'replay' && reservation.candidates === null)) return blocked;
    let candidates = reservation.status === 'replay' ? reservation.candidates! : null;
    if (candidates === null) {
      candidates = await options.discovery.discover(config.audience, config.discoveryLimits, signal);
      signal.throwIfAborted();
      await options.reservations.complete({ ...identity, candidates, costMicros: null });
    }
    const accountIds: string[] = [];
    const domains = new Set<string>();
    for (const candidate of candidates.slice(0, config.discoveryLimits.maxCompanies)) {
      signal.throwIfAborted();
      if (companySourcePolicy(candidate.sourceUrl) !== 'candidate' || domains.has(candidate.domain)) continue;
      const host = new URL(candidate.sourceUrl).hostname;
      if (host !== candidate.domain && host !== `www.${candidate.domain}`) continue;
      domains.add(candidate.domain);
      const account = await options.store.create({ commandId: derivedCommand(commandId, candidate.domain, 'create'), name: candidate.name, domain: candidate.domain });
      await options.store.enqueue({ commandId: derivedCommand(commandId, candidate.domain, 'enqueue'), accountId: account.id, limits: config.researchLimits });
      accountIds.push(account.id);
    }
    return { status: 'prepared', accountIds };
  } };
}
