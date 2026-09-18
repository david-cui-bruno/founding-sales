import { DynamoDBClient, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { ownerResearchSourceKey, ownerResearchSourceSchema, type OwnerResearchSource } from '../../../../src/shared/contracts/ownerCommandContract';
import { derivedCommand, discoveryInputFingerprint } from '../../../../src/main/research/companyResearchWorker';
import { companySourcePolicy } from '../../../../src/main/research/companySourcePolicy';
import { ResearchDiscoveryError, researchDiscoveryDiagnostic } from '../../../../src/main/research/researchDiscoveryError';
import { WorkerAuth, pairingKey } from './workerAuth';
import { fingerprint, integer, type Stored, type DynamoAdapter, type DynamoCommand } from './dynamoStore';
import { budgetKey, budgetSchema, createDiscoveryReservationStore, researchAdmissionKey, reservationKey } from './discoveryReservationStore';
import { createWorkerAccountRepository } from './workerAccountRepository';
import { assertGuidedResearch, guidedResearchBudgetId, guidedResearchMarkerKey, reviewedResearchProfile } from './researchSetup';
import { productionResearchBoundaries, researchProfile, researchWait, researchOnceNextKey, readNextReceipt } from './researchProduction';
import { researchRunId, runResearch } from './researchCoordinator';
import { emptyTickReport } from './sourceCoordinator';
import { heldResearchOnce, researchOnceNextReceiptSchema, type ResearchOnceRequest, type ResearchOnceResult } from './researchOnceContract';
import { researchCycleHeadSchema, researchCycleReceiptSchema, type ResearchCycleAdmission, type ResearchCycleAdmissionResult,
  type ResearchCycleReceipt, type ResearchCycleReference, type ResearchCycleRequest, type ResearchCycleStatusResult, type ResearchCyclePredecessor } from './researchCycleContract';
import type { ProductionBoundaries } from './handler';
export const researchCycleHeadKey = 'RESEARCH_CYCLE_V2_HEAD';
export const researchCycleKey = (ordinal: number) => `RESEARCH_CYCLE_V2#${integer.positive().parse(ordinal)}`;
const reference = (receipt: ResearchCycleReceipt): ResearchCycleReference => ({ ordinal: receipt.ordinal, admissionFingerprint: receipt.fingerprint });
const slot = (request: ResearchCycleAdmission) => request.predecessor.kind === 'legacy' ? 1 : integer.positive().parse(request.predecessor.ordinal + 1);
export function researchCycleRunId(request: ResearchCycleAdmission): string {
  const hash = fingerprint({ version: 'research-cycle-v2', workspaceId: request.workspaceId, pairingId: request.pairingId,
    researchFingerprint: request.researchFingerprint, ordinal: slot(request), predecessor: request.predecessor, pausedRevision: request.expectedSourceRevision });
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
const observation = (key: string, row: Stored<unknown> | null) => ({ key, revision: row?.rev ?? null, fingerprint: row ? fingerprint(row.data) : null });
type RunRow = Awaited<ReturnType<ReturnType<typeof createDiscoveryReservationStore>['readRunWithRevision']>>;
function validateRun(row: RunRow, source: OwnerResearchSource, runId: string, revision: number) {
  if (!row) return;
  const run = row.data; const settings = source.research!;
  const cost = integer.positive().parse(settings.capability.searchCostMicros + settings.capability.modelCostMicros);
  if (run.commandId !== runId || run.workspaceId !== source.workspaceId || run.budgetId !== guidedResearchBudgetId
    || run.inputFingerprint !== discoveryInputFingerprint(settings) || run.searchCostMicros !== settings.capability.searchCostMicros
    || run.modelCostMicros !== settings.capability.modelCostMicros || run.reserved !== cost
    || run.costMicros !== null && run.costMicros > cost
    || !run.completed && (run.candidates !== null || run.costMicros !== null) || run.completed && run.candidates === null
    || fingerprint(run.researchOnceBinding ?? null) !== fingerprint({ pairingId: source.pairingId, researchFingerprint: fingerprint(settings), sourceRevision: revision })) throw Error('research_cycle_run_corrupt');
}
function unsuccessful(row: RunRow) { return !row || !row.data.completed || row.data.candidates?.length === 0; }

/** Fixed bounded row set only. No enumeration, chain scan, credentials or mutations
 * other than explicit admission/execution and condition-only snapshot checks. */
class ResearchCycle {
  constructor(readonly auth: WorkerAuth, readonly env: NodeJS.ProcessEnv, readonly signal: AbortSignal) {}
  async receipt(ref: ResearchCycleReference, identity: { workspaceId: string; pairingId: string }) {
    const row = await this.auth.store.get<unknown>(researchCycleKey(ref.ordinal));
    if (!row) return null;
    const data = researchCycleReceiptSchema.parse(row.data); const request = data.request;
    if (row.rev !== 1 || data.ordinal !== ref.ordinal || data.fingerprint !== ref.admissionFingerprint || fingerprint(request) !== data.fingerprint
      || request.workspaceId !== identity.workspaceId || request.pairingId !== identity.pairingId || slot(request) !== data.ordinal
      || data.runId !== researchCycleRunId(request) || data.expectedExecutionRevision !== integer.positive().parse(request.expectedSourceRevision + 1)
      || data.deltaMicros !== request.proposedDiscoveryLimitMicros - request.expectedDiscoveryBudget.limit
      || request.expectedDiscoveryBudget.spent > request.expectedDiscoveryBudget.limit || request.expectedResearchBudget.spent > request.expectedResearchBudget.limit
      || fingerprint(data.observations) !== request.observationFingerprint
      || request.predecessor.kind === 'legacy' && request.predecessor.anchorFingerprint !== data.legacyAnchorFingerprint) throw Error('research_cycle_receipt_corrupt');
    integer.positive().parse(request.proposedDiscoveryLimitMicros + request.expectedResearchBudget.limit);
    return { data, rev: row.rev };
  }
  async snapshot(identity: { workspaceId: string; pairingId: string }, exact?: ResearchCycleReference) {
    const store = this.auth.store;
    const sourceRow = await store.get<unknown>(ownerResearchSourceKey());
    const marker = await store.get<unknown>(guidedResearchMarkerKey);
    const fence = await store.get<unknown>(researchAdmissionKey);
    const pairing = await store.get<unknown>(pairingKey(identity.pairingId));
    const discovery = await store.get<unknown>(budgetKey(guidedResearchBudgetId));
    const page = await store.get<unknown>('BUDGET#research');
    const headRow = await store.get<unknown>(researchCycleHeadKey);
    const checks = new Map<string, TransactWriteItem>();
    const observed = new Map<string, string>();
    const check = (key: string, row: Stored<unknown> | null) => {
      const value = fingerprint(observation(key, row));
      if (observed.has(key) && observed.get(key) !== value) throw Error('research_cycle_snapshot_conflict');
      observed.set(key, value); checks.set(key, row ? store.check(key, row.rev) : store.absent(key));
    };
    for (const [key, row] of [[ownerResearchSourceKey(), sourceRow], [guidedResearchMarkerKey, marker], [researchAdmissionKey, fence],
      [pairingKey(identity.pairingId), pairing], [budgetKey(guidedResearchBudgetId), discovery], ['BUDGET#research', page], [researchCycleHeadKey, headRow]] as const) check(key, row);
    const source = sourceRow ? ownerResearchSourceSchema.parse(sourceRow.data) : null;
    if (source && (source.workspaceId !== identity.workspaceId || source.pairingId !== identity.pairingId)) throw Error('research_cycle_source_conflict');
    const ledger = (row: Stored<unknown> | null, key: string) => {
      if (!row) return null;
      const data = budgetSchema.parse(row.data);
      if (data.spent > data.limit) throw Error('research_cycle_budget_corrupt');
      checks.set(key, store.check(key, row.rev, { limit: data.limit, spent: data.spent }));
      return data;
    };
    const discoveryBudget = ledger(discovery, budgetKey(guidedResearchBudgetId)); const researchBudget = ledger(page, 'BUDGET#research');
    if (discoveryBudget && researchBudget) integer.positive().parse(discoveryBudget.limit + researchBudget.limit);
    const head = headRow ? researchCycleHeadSchema.parse(headRow.data) : null;
    let current: Stored<ResearchCycleReceipt> | null = null; let orphaned = false;
    if (head) {
      if (head.workspaceId !== identity.workspaceId || head.pairingId !== identity.pairingId || headRow!.rev !== head.reference.ordinal) throw Error('research_cycle_head_corrupt');
      current = await this.receipt(head.reference, identity);
      if (!current || current.data.legacyAnchorFingerprint !== head.legacyAnchorFingerprint || current.data.request.researchFingerprint !== head.researchFingerprint) throw Error('research_cycle_head_corrupt');
      check(researchCycleKey(head.reference.ordinal), current);
    } else {
      const first = await store.get<unknown>(researchCycleKey(1));
      if (first && !exact) throw Error('research_cycle_head_missing');
      orphaned = !!first; check(researchCycleKey(1), first);
    }
    const observations: ResearchCycleReceipt['observations'] = [];
    let predecessor: ResearchCyclePredecessor | null = null; let legacyAnchorFingerprint: string | null = head?.legacyAnchorFingerprint ?? null;
    let eligible = true; let latestExecutionRevision = 0;
    const observeRun = async (runId: string, revision: number) => {
      const row = await createDiscoveryReservationStore(this.auth.options).readRunWithRevision(runId);
      if (source?.research) validateRun(row, source, runId, revision);
      else if (row) throw Error('research_cycle_settings_missing');
      observations.push(observation(reservationKey(runId), row)); check(reservationKey(runId), row);
      eligible = eligible && unsuccessful(row); latestExecutionRevision = Math.max(latestExecutionRevision, revision);
      return row;
    };
    if (current) {
      observations.push(observation(researchCycleKey(current.data.ordinal), current));
      await observeRun(current.data.runId, current.data.expectedExecutionRevision);
      predecessor = { kind: 'cycle', ...reference(current.data) };
    } else if (!orphaned && source?.research) {
      const runId = researchRunId(source.workspaceId, source.pairingId, source.research);
      const original = await observeRun(runId, 1); eligible = eligible && !!original;
      const nextKey = researchOnceNextKey(runId); const rawNext = await store.get<unknown>(nextKey);
      check(nextKey, rawNext); observations.push(observation(nextKey, rawNext));
      let nextFingerprint: string | null = null;
      if (rawNext) {
        const data = researchOnceNextReceiptSchema.parse(rawNext.data);
        const next = await readNextReceipt(this.auth, { version: 1, kind: 'research.once.admit-next.status', workspaceId: identity.workspaceId,
          pairingId: identity.pairingId, parentRunId: runId, parentSourceRevision: 1, researchFingerprint: fingerprint(source.research), admissionFingerprint: data.fingerprint });
        if (!next || next.rev !== rawNext.rev || fingerprint(next.data) !== fingerprint(rawNext.data)
          || !original || original.rev !== data.parentRevision || fingerprint(original.data) !== data.parentFingerprint) throw Error('research_cycle_legacy_conflict');
        nextFingerprint = data.fingerprint;
        await observeRun(data.successorRunId, data.expectedExecutionRevision);
      }
      legacyAnchorFingerprint = fingerprint({ version: 'research-cycle-v2-legacy', workspaceId: identity.workspaceId, pairingId: identity.pairingId,
        researchFingerprint: fingerprint(source.research), originalRunId: runId, successorAdmissionFingerprint: nextFingerprint });
      predecessor = { kind: 'legacy', anchorFingerprint: legacyAnchorFingerprint };
    } else eligible = false;
    let selected = current;
    if (exact && (!current || fingerprint(exact) !== fingerprint(reference(current.data)))) {
      selected = await this.receipt(exact, identity); check(researchCycleKey(exact.ordinal), selected);
    }
    if (selected && !head) { orphaned = true; predecessor = null; }
    const outcome = selected ? await this.outcome(selected.data, source, check) : null;
    const blockers: string[] = orphaned ? ['head_corrupt'] : [];
    if (!source?.research || !marker || !fence || !discoveryBudget || !researchBudget) blockers.push('configuration_missing');
    if (fence && !z.strictObject({ version: z.literal(1), kind: z.literal('guided') }).safeParse(fence.data).success) throw Error('research_cycle_fence_corrupt');
    if (pairing) {
      const value = z.strictObject({ pairingId: z.uuid(), generation: integer, revoked: z.boolean() }).parse(pairing.data);
      if (value.pairingId !== identity.pairingId) throw Error('research_cycle_pairing_corrupt');
      if (value.revoked) blockers.push('pairing_inactive');
    } else blockers.push('pairing_inactive');
    const profile = reviewedResearchProfile(researchProfile(this.env), store.now());
    if (source?.research && marker) {
      try { assertGuidedResearch(marker.data, source, researchProfile(this.env), store.now()); }
      catch { blockers.push('binding_unavailable'); }
      if (head && head.researchFingerprint !== fingerprint(source.research)) blockers.push('settings_changed');
    }
    if (this.env.DELEGATED_WORKER_SCHEDULE_ARN) blockers.push('schedule_present');
    if (!eligible && !orphaned) blockers.push('predecessor_ineligible');
    return { sourceRow, source, marker, fence, pairing, discovery, page, discoveryBudget, researchBudget, headRow, head, current, selected, checks,
      observations, predecessor, legacyAnchorFingerprint, latestExecutionRevision, eligible, outcome, blockers, profile };
  }
  private async outcome(receipt: ResearchCycleReceipt, source: OwnerResearchSource | null, check: (key: string, row: Stored<unknown> | null) => unknown): Promise<ResearchOnceResult | null> {
    const store = this.auth.store;
    const run = await createDiscoveryReservationStore(this.auth.options).readRunWithRevision(receipt.runId);
    check(reservationKey(receipt.runId), run);
    if (!run) return null;
    if (source?.research && fingerprint(source.research) === receipt.request.researchFingerprint) validateRun(run, source, receipt.runId, receipt.expectedExecutionRevision);
    if (run.data.budgetId !== guidedResearchBudgetId || run.data.reserved !== integer.positive().parse(run.data.searchCostMicros + run.data.modelCostMicros)
      || run.data.costMicros !== null && run.data.costMicros > run.data.reserved) throw Error('research_cycle_run_corrupt');
    const binding = { pairingId: receipt.request.pairingId, researchFingerprint: receipt.request.researchFingerprint, sourceRevision: receipt.expectedExecutionRevision };
    if (fingerprint(run.data.researchOnceBinding ?? null) !== fingerprint(binding) || !run.data.completed && (run.data.candidates !== null || run.data.costMicros !== null)
      || run.data.completed && run.data.candidates === null) throw Error('research_cycle_run_corrupt');
    const result = { ...heldResearchOnce(), runId: receipt.runId };
    if (!run.data.completed) return { ...result, state: 'uncertain' };
    const candidate = run.data.candidates?.[0];
    if (!candidate || companySourcePolicy(candidate.sourceUrl) !== 'candidate'
      || ![candidate.domain, `www.${candidate.domain}`].includes(new URL(candidate.sourceUrl).hostname)) return { ...result, state: 'empty' };
    const jobId = derivedCommand(receipt.runId, candidate.domain, 'enqueue'); const jobKey = `JOB#${jobId}`;
    const jobRow = await store.get<unknown>(jobKey); check(jobKey, jobRow);
    if (!jobRow) return { ...result, jobId };
    const job = await createWorkerAccountRepository(this.auth.options).readJob(jobId);
    if (!job || fingerprint(jobRow.data) !== fingerprint(job) || job.accountId !== `account-${fingerprint([receipt.request.workspaceId, derivedCommand(receipt.runId, candidate.domain, 'create')])}`) throw Error('research_cycle_job_conflict');
    if (job.state === 'completed' && !job.receiptCommitted || job.state === 'parked' && job.receiptCommitted
      || job.costMicros !== null && job.costMicros > job.reservedCost
      || job.state === 'queued' && (job.receiptCommitted || job.reservedCost !== 0 || job.claimedAt !== null || job.claimToken !== '' || job.costMicros !== null)
      || job.state !== 'queued' && (job.reservedCost !== job.limits.maxCostMicros || job.claimedAt === null || !z.uuid().safeParse(job.claimToken).success)
      || source?.research && fingerprint(source.research) === receipt.request.researchFingerprint && fingerprint(job.limits) !== fingerprint(source.research.researchLimits)) throw Error('research_cycle_job_corrupt');
    if (job.receiptCommitted) {
      const key = `ACCOUNT_COMMAND#${job.receiptCommandId}`; const evidence = await store.get<unknown>(key); check(key, evidence);
      const value = z.object({ kind: z.literal('evidence'), accountId: z.string(), claimToken: z.string() }).parse(evidence?.data);
      if (value.accountId !== job.accountId || value.claimToken !== job.claimToken) throw Error('research_cycle_evidence_conflict');
    }
    const settled = job.state === 'completed' || job.state === 'parked';
    const stale = job.state === 'running' && !job.receiptCommitted && job.claimedAt !== null && Date.parse(store.now()) - Date.parse(job.claimedAt) >= 300000;
    return { ...result, jobId, accountId: job.accountId, evidenceReceiptId: job.receiptCommitted ? job.receiptCommandId : null,
      settled, settlementReceiptId: settled ? `settle-${fingerprint({ jobId, claimToken: job.claimToken, status: job.state,
        receiptCommandId: job.receiptCommitted ? job.receiptCommandId : null, costMicros: job.costMicros })}` : null,
      state: job.state === 'completed' && job.receiptCommitted ? 'completed' : job.state === 'parked' || stale ? 'uncertain' : job.state === 'running' ? 'in-progress' : 'held' };
  }
  async status(identity: { workspaceId: string; pairingId: string }, exact?: ResearchCycleReference): Promise<ResearchCycleStatusResult> {
    const s = await this.snapshot(identity, exact);
    await this.auth.store.transact([...s.checks.values()]);
    const checkedAt = this.auth.store.now(); const profile = reviewedResearchProfile(researchProfile(this.env), checkedAt);
    const blockers = [...s.blockers]; if (profile.blockers.length) blockers.push('descriptor_unavailable');
    let authorityState: ResearchCycleStatusResult['authorityState'] = 'held';
    // Predecessor eligibility is admission-only, not authority over its mutable outcome.
    if (s.selected && profile.descriptorFingerprint !== s.selected.data.request.descriptorFingerprint) blockers.push('receipt_descriptor_changed');
    const authorityBlockers = blockers.filter(code => code !== 'predecessor_ineligible');
    if (s.selected && s.current && s.selected.data.fingerprint !== s.current.data.fingerprint) authorityState = 'superseded';
    else if (!authorityBlockers.length && s.source) {
      if (s.source.state === 'paused') authorityState = 'paused';
      else if (s.current && s.head && s.selected && s.source.revision === s.selected.data.expectedExecutionRevision) authorityState = 'ready';
    }
    return { version: 2, kind: 'research.cycle.status.result', admissionState: s.selected ? 'applied' : 'not-observed', receipt: s.selected?.data ?? null,
      head: s.head?.reference ?? null, source: s.source ? { revision: s.source.revision, state: s.source.state, researchFingerprint: s.source.research ? fingerprint(s.source.research) : null } : null,
      discoveryBudget: s.discoveryBudget, researchBudget: s.researchBudget, descriptorFingerprint: profile.descriptorFingerprint,
      predecessor: s.predecessor, observationFingerprint: s.predecessor ? fingerprint(s.observations) : null, authorityState, outcome: s.outcome, checkedAt, blockers };
  }
  async admit(request: ResearchCycleAdmission): Promise<ResearchCycleAdmissionResult> {
    const result = (receipt: ResearchCycleReceipt | null): ResearchCycleAdmissionResult => ({ version: 2, kind: 'research.cycle.admit.result', state: receipt ? 'applied' : 'held', receipt });
    const ref = { ordinal: slot(request), admissionFingerprint: fingerprint(request) };
    // Slot first: historical acknowledgement never depends on current authority.
    const prior = await this.receipt(ref, request); if (prior) return result(prior.data);
    const s = await this.snapshot(request);
    const source = s.source; const settings = source?.research; const descriptor = s.profile.descriptor;
    if (s.blockers.length || s.profile.blockers.length || !source || !settings || !s.marker || !s.discovery || !s.discoveryBudget || !s.researchBudget || !s.legacyAnchorFingerprint
      || !descriptor || source.state !== 'paused' || source.revision !== request.expectedSourceRevision || source.revision <= s.latestExecutionRevision
      || s.current && source.revision <= s.current.data.request.expectedSourceRevision
      || fingerprint(settings) !== request.researchFingerprint || s.profile.descriptorFingerprint !== request.descriptorFingerprint
      || fingerprint(s.predecessor) !== fingerprint(request.predecessor) || fingerprint(s.observations) !== request.observationFingerprint
      || fingerprint(s.discoveryBudget) !== fingerprint(request.expectedDiscoveryBudget) || fingerprint(s.researchBudget) !== fingerprint(request.expectedResearchBudget)
      || settings.budgetId !== guidedResearchBudgetId || settings.discoveryLimits.maxCompanies !== 1
      || fingerprint(settings.capability) !== fingerprint(descriptor.capability) || settings.researchLimits.maxCostMicros !== descriptor.researchReservationMicros
      || settings.researchLimits.maxCostMicros > settings.maxAccountBudgetMicros || s.researchBudget.limit - s.researchBudget.spent < descriptor.researchReservationMicros) return result(null);
    const cost = integer.positive().parse(descriptor.capability.searchCostMicros + descriptor.capability.modelCostMicros);
    const limit = Math.max(s.discoveryBudget.limit, integer.positive().parse(s.discoveryBudget.spent + cost));
    integer.positive().parse(limit + s.researchBudget.limit);
    if (settings.discoveryLimits.maxCostMicros !== cost || request.proposedDiscoveryLimitMicros !== limit) return result(null);
    const receipt = researchCycleReceiptSchema.parse({ version: 2, ordinal: ref.ordinal, request, fingerprint: ref.admissionFingerprint, runId: researchCycleRunId(request),
      legacyAnchorFingerprint: s.legacyAnchorFingerprint, expectedExecutionRevision: integer.positive().parse(source.revision + 1),
      observations: s.observations, deltaMicros: limit - s.discoveryBudget.limit, recordedAt: this.auth.store.now() });
    const store = this.auth.store;
    s.checks.set(researchCycleKey(ref.ordinal), store.put(researchCycleKey(ref.ordinal), receipt, null));
    s.checks.set(researchCycleHeadKey, store.put(researchCycleHeadKey, { version: 2, workspaceId: request.workspaceId, pairingId: request.pairingId,
      researchFingerprint: request.researchFingerprint, legacyAnchorFingerprint: s.legacyAnchorFingerprint, reference: ref }, s.headRow?.rev ?? null));
    if (limit > s.discoveryBudget.limit) s.checks.set(budgetKey(guidedResearchBudgetId), store.put(budgetKey(guidedResearchBudgetId), { ...s.discoveryBudget, limit }, s.discovery.rev,
      { limit, spent: s.discoveryBudget.spent }, { limit: s.discoveryBudget.limit, spent: s.discoveryBudget.spent }));
    this.signal.throwIfAborted(); assertGuidedResearch(s.marker.data, source, researchProfile(this.env), store.now());
    try { await store.transact([...s.checks.values()]); return result(receipt); }
    catch (error) { const committed = await this.receipt(ref, request); if (committed) return result(committed.data); throw error; }
  }
}

export async function executeResearchCycle(env: NodeJS.ProcessEnv, boundaries: ProductionBoundaries, request: ResearchCycleRequest, signal: AbortSignal) {
  if (env.DELEGATED_WORKER_ENABLED !== 'true' || env.DELEGATED_WORKER_RESEARCH_ONCE_ENABLED !== 'true' || request.workspaceId !== env.DELEGATED_WORKSPACE_ID) throw Error('research_cycle_disabled');
  signal.throwIfAborted();
  const config = z.object({ AWS_REGION: z.string().min(1), DELEGATED_WORKER_TABLE: z.string().min(1), DELEGATED_WORKSPACE_ID: z.string().min(1) }).parse(env);
  const raw = boundaries.dynamo ?? new DynamoDBClient({ region: config.AWS_REGION, maxAttempts: 1 });
  const dynamo: DynamoAdapter = { send: command => researchWait(signal, () => (raw as DynamoAdapter & { send(command: DynamoCommand, options: { abortSignal: AbortSignal }): ReturnType<DynamoAdapter['send']> }).send(command, { abortSignal: signal })) };
  const auth = new WorkerAuth({ dynamo, workspaceId: config.DELEGATED_WORKSPACE_ID, tableName: config.DELEGATED_WORKER_TABLE, clock: { now: () => new Date().toISOString() } });
  const service = new ResearchCycle(auth, env, signal);
  if (request.kind === 'research.cycle.admit') return service.admit(request);
  if (request.kind === 'research.cycle.status') return service.status(request, request.reference);
  const status = await service.status(request, request.reference);
  if (status.authorityState !== 'ready' || !status.receipt) return status;
  const receipt = status.receipt;
  const head = await auth.store.get<unknown>(researchCycleHeadKey);
  if (!head || fingerprint(researchCycleHeadSchema.parse(head.data).reference) !== fingerprint(request.reference)) return service.status(request, request.reference);
  const research = productionResearchBoundaries(env, boundaries);
  const once: ResearchOnceRequest = { version: 1, kind: 'research.once', workspaceId: request.workspaceId, pairingId: request.pairingId,
    expectedSourceRevision: receipt.expectedExecutionRevision, researchFingerprint: receipt.request.researchFingerprint };
  try {
    await researchWait(signal, () => runResearch({ auth, fetch: boundaries.fetch ?? globalThis.fetch, researchSetupProfile: researchProfile(env),
      resolvedCycle: { runId: receipt.runId, descriptorFingerprint: receipt.request.descriptorFingerprint, head: { key: researchCycleHeadKey, rev: head.rev, fingerprint: fingerprint(head.data) },
        receipt: { key: researchCycleKey(receipt.ordinal), rev: 1, fingerprint: fingerprint(receipt) } },
      research: { ...research, resolve: hostname => researchWait(signal, () => research.resolve(hostname)), pageHttp: value => researchWait(signal, () => research.pageHttp(value)) } }, signal,
    emptyTickReport(), once));
  } catch (error) {
    if (error instanceof ResearchDiscoveryError) {
      try { console.warn({ event: 'research_discovery_uncertain', ...researchDiscoveryDiagnostic(error) }); } catch { /* diagnostics cannot alter durable outcomes */ }
    } else if (!(error instanceof Error) || !['research_discovery_uncertain', 'research_once_binding_conflict', 'research_cycle_binding_changed', 'worker_unauthorized',
      'research_setup_binding_conflict', 'research_setup_descriptor_unavailable', 'research_setup_marker_missing', 'research_source_changed', 'research_pairing_changed', 'research_setup_marker_changed', 'research_model_mismatch'].includes(error.message)) throw error;
  }
  return service.status(request, request.reference);
}
