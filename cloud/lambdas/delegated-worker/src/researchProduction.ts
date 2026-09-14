import { ResearchDiscoveryError, researchDiscoveryDiagnostic } from '../../../../src/main/research/researchDiscoveryError';
import { lookup } from 'node:dns/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { z } from 'zod';
import { createPinnedPageHttp } from '../../../../src/main/research/companyPageProvider';
import { derivedCommand, discoveryInputFingerprint } from '../../../../src/main/research/companyResearchWorker';
import { companySourcePolicy } from '../../../../src/main/research/companySourcePolicy';
import { ownerResearchSourceKey, ownerResearchSourceSchema } from '../../../../src/shared/contracts/ownerCommandContract';
import { WorkerAuth, pairingKey } from './workerAuth';
import { fingerprint, integer, type DynamoAdapter, type DynamoCommand } from './dynamoStore';
import { budgetKey, budgetSchema, researchAdmissionKey, reservationKey, createDiscoveryReservationStore } from './discoveryReservationStore';
import { createWorkerAccountRepository } from './workerAccountRepository';
import { researchRunId, researchSuccessorRunId, runResearch, type SourceResearchBoundaries, type ResolvedResearchSuccessor } from './researchCoordinator';
import { heldResearchOnce, researchOnceNextReceiptSchema, type ResearchOnceRequest, type ResearchOnceResult, type ResearchOnceNextRequest, type ResearchOnceNextResult } from './researchOnceContract';
import { assertGuidedResearch, guardGuidedResearch, guidedResearchMarkerKey, guidedResearchBudgetId, reviewedResearchProfile } from './researchSetup';
import type { ProductionBoundaries } from './handler';
/** Stops waiting for non-cooperative boundaries. Every later SDK/provider start
 * separately checks this same signal. An already-sent remote write may commit. */
export function researchWait<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('research_once_deadline'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return start(); }).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) abort(); else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
export function researchProfile(env: NodeJS.ProcessEnv) {
  const prefix = `/delegated-worker/${env.DELEGATED_WORKSPACE_ID}/`;
  return { reviewedCapability: env.DELEGATED_RESEARCH_REVIEWED_CAPABILITY,
    credentialParameterDeclared: !!env.DELEGATED_RESEARCH_CREDENTIAL_PARAMETER?.startsWith(prefix) && env.DELEGATED_RESEARCH_CREDENTIAL_PARAMETER.length > prefix.length };
}
export function productionResearchBoundaries(env: NodeJS.ProcessEnv, boundaries: ProductionBoundaries): SourceResearchBoundaries {
  return { pageHttp: boundaries.pageHttp ?? createPinnedPageHttp(),
    resolve: boundaries.resolve ?? (async hostname => (await lookup(hostname, { all: true })).map(item => item.address)),
    loadCredentials: async (workspaceId, signal) => {
      signal.throwIfAborted();
      if (workspaceId !== env.DELEGATED_WORKSPACE_ID) throw new Error('research_workspace_mismatch');
      const path = z.string().startsWith(`/delegated-worker/${workspaceId}/`).parse(env.DELEGATED_RESEARCH_CREDENTIAL_PARAMETER);
      const ssm = boundaries.ssm ?? new SSMClient({ region: env.AWS_REGION, maxAttempts: 1 });
      const result = await researchWait(signal, () => ssm.send(new GetParameterCommand({ Name: path, WithDecryption: true }), { abortSignal: signal }));
      if (result.Parameter?.Type !== 'SecureString' || !result.Parameter.Value) throw new Error('research_unconfigured');
      return z.strictObject({ apiKey: z.string().min(1).max(16384), model: z.string().min(1).max(255) }).parse(JSON.parse(result.Parameter.Value));
    } };
}
async function readResult(auth: WorkerAuth, request: ResearchOnceRequest, runId: string): Promise<ResearchOnceResult> {
  const result = { ...heldResearchOnce(), runId };
  const reservation = await createDiscoveryReservationStore(auth.options).readRun(runId);
  if (!reservation) return request.kind === 'research.once.status' ? heldResearchOnce() : result;
  const binding = reservation.researchOnceBinding;
  if (!binding || binding.pairingId !== request.pairingId || binding.researchFingerprint !== request.researchFingerprint
    || binding.sourceRevision !== request.expectedSourceRevision) return heldResearchOnce();
  if (!reservation.completed) return { ...result, state: 'uncertain' };
  const candidate = reservation.candidates?.[0];
  if (!candidate || companySourcePolicy(candidate.sourceUrl) !== 'candidate'
    || ![candidate.domain, `www.${candidate.domain}`].includes(new URL(candidate.sourceUrl).hostname)) return { ...result, state: 'empty' };
  const jobId = derivedCommand(runId, candidate.domain, 'enqueue');
  const job = await createWorkerAccountRepository(auth.options).readJob(jobId);
  if (!job) return { ...result, jobId, state: 'held' };
  const expectedAccountId = `account-${fingerprint([request.workspaceId, derivedCommand(runId, candidate.domain, 'create')])}`;
  if (job.accountId !== expectedAccountId) throw new Error('research_job_identity_conflict');
  const settled = job.state === 'completed' || job.state === 'parked';
  const stale = job.state === 'running' && !job.receiptCommitted && job.claimedAt !== null && Date.parse(auth.store.now()) - Date.parse(job.claimedAt) >= 300000;
  return { ...result, jobId, accountId: job.accountId, evidenceReceiptId: job.receiptCommitted ? job.receiptCommandId : null,
    settled, settlementReceiptId: settled ? `settle-${fingerprint({ jobId, claimToken: job.claimToken, status: job.state,
      receiptCommandId: job.receiptCommitted ? job.receiptCommandId : null, costMicros: job.costMicros })}` : null,
    state: job.state === 'completed' && job.receiptCommitted ? 'completed' : job.state === 'parked' || stale ? 'uncertain' : job.state === 'running' ? 'in-progress' : 'held' };
}
/** Research-only composition: no Google, source tick, mail, dispatch or meeting objects. */
export async function executeResearchOnce(env: NodeJS.ProcessEnv, boundaries: ProductionBoundaries, request: ResearchOnceRequest, signal: AbortSignal): Promise<ResearchOnceResult> {
  if (env.DELEGATED_WORKER_ENABLED !== 'true' || env.DELEGATED_WORKER_RESEARCH_ONCE_ENABLED !== 'true'
    || request.workspaceId !== env.DELEGATED_WORKSPACE_ID || (request.kind === 'research.once' && env.DELEGATED_WORKER_SCHEDULE_ARN !== undefined && env.DELEGATED_WORKER_SCHEDULE_ARN !== '')) return heldResearchOnce();
  signal.throwIfAborted();
  const config = z.object({ AWS_REGION: z.string().min(1), DELEGATED_WORKER_TABLE: z.string().min(1), DELEGATED_WORKSPACE_ID: z.string().min(1) }).parse(env);
  const raw = boundaries.dynamo ?? new DynamoDBClient({ region: config.AWS_REGION, maxAttempts: 1 });
  const dynamo: DynamoAdapter = { send: command => researchWait(signal, () => (raw as DynamoAdapter & { send(command: DynamoCommand, options: { abortSignal: AbortSignal }): ReturnType<DynamoAdapter['send']> }).send(command, { abortSignal: signal })) };
  const auth = new WorkerAuth({ dynamo, tableName: config.DELEGATED_WORKER_TABLE, workspaceId: config.DELEGATED_WORKSPACE_ID, clock: { now: () => new Date().toISOString() } });
  if (request.kind === 'research.once.status') return readResult(auth, request, request.runId);
  const row = await auth.store.get<unknown>(ownerResearchSourceKey());
  if (!row) return heldResearchOnce();
  const source = ownerResearchSourceSchema.parse(row.data);
  if (!source.research || source.workspaceId !== request.workspaceId || source.pairingId !== request.pairingId
    || source.revision !== request.expectedSourceRevision || fingerprint(source.research) !== request.researchFingerprint) return heldResearchOnce();
  const originalRunId = researchRunId(source.workspaceId, source.pairingId, source.research);
  let resolvedSuccessor: ResolvedResearchSuccessor | undefined;
  if (request.successor) {
    if (source.state !== 'active' || source.revision !== 3 || request.successor.parentRunId !== originalRunId) return heldResearchOnce();
    const row = await readNextReceipt(auth, { version: 1, kind: 'research.once.admit-next.status', workspaceId: request.workspaceId, pairingId: request.pairingId,
      parentRunId: originalRunId, parentSourceRevision: 1, researchFingerprint: request.researchFingerprint, admissionFingerprint: request.successor.admissionFingerprint });
    if (!row) return heldResearchOnce();
    const receipt = row.data;
    const profile = reviewedResearchProfile(researchProfile(env), auth.store.now());
    if (profile.blockers.length || profile.descriptorFingerprint !== receipt.request.descriptorFingerprint) return heldResearchOnce();
    const parent = await createDiscoveryReservationStore(auth.options).readRunWithRevision(originalRunId);
    if (!parent || parent.rev !== receipt.parentRevision || fingerprint(parent.data) !== receipt.parentFingerprint) return heldResearchOnce();
    resolvedSuccessor = { runId: receipt.successorRunId,
      receipt: { key: researchOnceNextKey(originalRunId), rev: row.rev, fingerprint: fingerprint(receipt) },
      parent: { key: reservationKey(originalRunId), rev: parent.rev, fingerprint: fingerprint(parent.data) } };
  }
  const runId = resolvedSuccessor?.runId ?? originalRunId;
  const research = productionResearchBoundaries(env, boundaries);
  try {
    await researchWait(signal, () => runResearch({ auth, resolvedSuccessor, fetch: boundaries.fetch ?? globalThis.fetch, researchSetupProfile: researchProfile(env),
      research: { ...research, resolve: hostname => researchWait(signal, () => research.resolve(hostname)), pageHttp: value => researchWait(signal, () => research.pageHttp(value)) } }, signal,
    { status: 'inactive', researchPrepared: 0, researchCompleted: 0, held: 0, mailPolls: 0, dispatches: 0, sendReconciliations: 0, meetings: 0 }, request));
  } catch (error) {
    if (error instanceof ResearchDiscoveryError) {
      // Diagnostics are best-effort and must never change the durable outcome.
      try { console.warn({ event: 'research_discovery_uncertain', ...researchDiscoveryDiagnostic(error) }); } catch { /* no fallback logging */ }
    }
    // Only known admission refusals are held. SDK/unexpected failures propagate
    // to sanitized Lambda FunctionError. Durable reservations survive either way.
    if (!(error instanceof ResearchDiscoveryError) && (!(error instanceof Error) || !['research_once_binding_conflict', 'research_discovery_uncertain', 'worker_unauthorized', 'research_setup_binding_conflict', 'research_setup_descriptor_unavailable', 'research_setup_marker_missing', 'research_source_changed', 'research_pairing_changed', 'research_setup_marker_changed', 'research_model_mismatch'].includes(error.message))) throw error;
  }
  return readResult(auth, request, runId);
}

export const researchOnceNextKey = (parentRunId: string) => `RESEARCH_ONCE_NEXT#${z.uuid().parse(parentRunId)}`;
async function readNextReceipt(auth: WorkerAuth, request: ResearchOnceNextRequest) {
  const row = await auth.store.get<unknown>(researchOnceNextKey(request.parentRunId));
  if (!row) return null;
  const receipt = researchOnceNextReceiptSchema.parse(row.data);
  const original = receipt.request;
  const expected = request.kind === 'research.once.admit-next' ? fingerprint(request) : request.admissionFingerprint;
  if (row.rev !== 1 || receipt.fingerprint !== expected || fingerprint(original) !== expected
    || original.workspaceId !== request.workspaceId || original.pairingId !== request.pairingId || original.parentRunId !== request.parentRunId
    || original.parentSourceRevision !== request.parentSourceRevision || original.researchFingerprint !== request.researchFingerprint
    || receipt.successorRunId !== researchSuccessorRunId(original)
    || receipt.deltaMicros !== original.expectedDiscoveryBudget.limit || original.expectedDiscoveryBudget.spent !== receipt.deltaMicros
    || original.proposedDiscoveryLimitMicros !== integer.positive().parse(original.expectedDiscoveryBudget.limit + receipt.deltaMicros)) throw new Error('research_next_receipt_conflict');
  return { data: receipt, rev: row.rev };
}
/** Native IAM admission only. No credentials, source activation or provider composition. */
export async function admitResearchOnceNext(env: NodeJS.ProcessEnv, boundaries: ProductionBoundaries, request: ResearchOnceNextRequest, signal: AbortSignal): Promise<ResearchOnceNextResult> {
  const result = (state: ResearchOnceNextResult['state'], receipt: ResearchOnceNextResult['receipt'] = null): ResearchOnceNextResult => ({ version: 1, kind: 'research.once.admit-next.result', state, receipt });
  if (env.DELEGATED_WORKER_ENABLED !== 'true' || env.DELEGATED_WORKER_RESEARCH_ONCE_ENABLED !== 'true' || request.workspaceId !== env.DELEGATED_WORKSPACE_ID
    || request.kind === 'research.once.admit-next' && !!env.DELEGATED_WORKER_SCHEDULE_ARN) return result('held');
  signal.throwIfAborted();
  const config = z.object({ AWS_REGION: z.string().min(1), DELEGATED_WORKER_TABLE: z.string().min(1), DELEGATED_WORKSPACE_ID: z.string().min(1) }).parse(env);
  const raw = boundaries.dynamo ?? new DynamoDBClient({ region: config.AWS_REGION, maxAttempts: 1 });
  const dynamo: DynamoAdapter = { send: command => researchWait(signal, () => (raw as DynamoAdapter & { send(command: DynamoCommand, options: { abortSignal: AbortSignal }): ReturnType<DynamoAdapter['send']> }).send(command, { abortSignal: signal })) };
  const auth = new WorkerAuth({ dynamo, tableName: config.DELEGATED_WORKER_TABLE, workspaceId: config.DELEGATED_WORKSPACE_ID, clock: { now: () => new Date().toISOString() } });
  const prior = await readNextReceipt(auth, request);
  if (prior) return result('applied', prior.data);
  if (request.kind === 'research.once.admit-next.status') return result('not-observed');
  const store = auth.store;
  const sourceRow = await store.get<unknown>(ownerResearchSourceKey());
  if (!sourceRow) return result('held');
  const source = ownerResearchSourceSchema.parse(sourceRow.data);
  const settings = source.research;
  if (!settings || source.workspaceId !== request.workspaceId || source.pairingId !== request.pairingId || source.state !== 'paused'
    || source.revision !== request.expectedSourceRevision || fingerprint(settings) !== request.researchFingerprint
    || settings.budgetId !== guidedResearchBudgetId || settings.discoveryLimits.maxCompanies !== 1
    || researchRunId(source.workspaceId, source.pairingId, settings) !== request.parentRunId) return result('held');
  const profile = researchProfile(env);
  const marker = await guardGuidedResearch(store, source, profile);
  if (!marker) return result('held');
  const pairing = await auth.activePairing(request.pairingId);
  const fence = await store.get<unknown>(researchAdmissionKey);
  if (!fence || !z.strictObject({ version: z.literal(1), kind: z.literal('guided') }).safeParse(fence.data).success) return result('held');
  const parent = await createDiscoveryReservationStore(auth.options).readRunWithRevision(request.parentRunId);
  const discovery = await store.get<unknown>(budgetKey(guidedResearchBudgetId));
  const page = await store.get<unknown>('BUDGET#research');
  if (!parent || !discovery || !page) return result('held');
  const reviewed = reviewedResearchProfile(profile, store.now());
  const descriptor = reviewed.descriptor;
  if (reviewed.blockers.length || !descriptor || reviewed.descriptorFingerprint !== request.descriptorFingerprint
    || fingerprint(settings.capability) !== fingerprint(descriptor.capability)) return result('held');
  const cost = integer.positive().parse(descriptor.capability.searchCostMicros + descriptor.capability.modelCostMicros);
  const before = budgetSchema.parse(discovery.data); const pageBudget = budgetSchema.parse(page.data);
  const afterLimit = integer.positive().parse(before.limit + cost);
  integer.positive().parse(afterLimit + pageBudget.limit);
  if (fingerprint(before) !== fingerprint(request.expectedDiscoveryBudget) || fingerprint(pageBudget) !== fingerprint(request.expectedResearchBudget)
    || before.limit !== cost || before.spent !== cost || request.proposedDiscoveryLimitMicros !== afterLimit
    || pageBudget.spent !== 0 || pageBudget.limit < descriptor.researchReservationMicros
    || settings.researchLimits.maxCostMicros !== descriptor.researchReservationMicros || settings.discoveryLimits.maxCostMicros !== cost
    || parent.data.completed || parent.data.candidates !== null || parent.data.costMicros !== null || parent.data.reserved !== cost
    || parent.data.budgetId !== guidedResearchBudgetId || parent.data.inputFingerprint !== discoveryInputFingerprint(settings)
    || parent.data.searchCostMicros !== descriptor.capability.searchCostMicros || parent.data.modelCostMicros !== descriptor.capability.modelCostMicros
    || fingerprint(parent.data.researchOnceBinding) !== fingerprint({ pairingId: request.pairingId, researchFingerprint: request.researchFingerprint, sourceRevision: 1 })) return result('held');
  const receipt = researchOnceNextReceiptSchema.parse({ version: 1, request, fingerprint: fingerprint(request), successorRunId: researchSuccessorRunId(request),
    expectedExecutionRevision: 3, parentRevision: parent.rev, parentFingerprint: fingerprint(parent.data), deltaMicros: cost, recordedAt: store.now() });
  const writes = [store.put(budgetKey(guidedResearchBudgetId), { ...before, limit: afterLimit }, discovery.rev, { limit: afterLimit, spent: before.spent }, { limit: before.limit, spent: before.spent }),
    store.put(researchOnceNextKey(request.parentRunId), receipt, null), store.check(reservationKey(request.parentRunId), parent.rev),
    store.check(ownerResearchSourceKey(), sourceRow.rev), store.check(guidedResearchMarkerKey, marker.rev), store.check(researchAdmissionKey, fence.rev),
    store.check(pairingKey(request.pairingId), pairing.rev), store.check('BUDGET#research', page.rev, { limit: pageBudget.limit, spent: pageBudget.spent })];
  // Time sampled after every awaited read and immediately before dispatch.
  signal.throwIfAborted(); assertGuidedResearch(marker.data, source, profile, store.now());
  try { await store.transact(writes); return result('applied', receipt); }
  catch (error) { const committed = await readNextReceipt(auth, request); if (committed) return result('applied', committed.data); throw error; }
}
