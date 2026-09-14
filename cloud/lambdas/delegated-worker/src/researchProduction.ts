import { lookup } from 'node:dns/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { z } from 'zod';
import { createPinnedPageHttp } from '../../../../src/main/research/companyPageProvider';
import { derivedCommand } from '../../../../src/main/research/companyResearchWorker';
import { companySourcePolicy } from '../../../../src/main/research/companySourcePolicy';
import { ownerResearchSourceKey, ownerResearchSourceSchema } from '../../../../src/shared/contracts/ownerCommandContract';
import { WorkerAuth } from './workerAuth';
import { fingerprint, type DynamoAdapter, type DynamoCommand } from './dynamoStore';
import { createDiscoveryReservationStore } from './discoveryReservationStore';
import { createWorkerAccountRepository } from './workerAccountRepository';
import { researchRunId, runResearch, type SourceResearchBoundaries } from './researchCoordinator';
import { heldResearchOnce, type ResearchOnceRequest, type ResearchOnceResult } from './researchOnceContract';
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
  const runId = researchRunId(source.workspaceId, source.pairingId, source.research);
  const research = productionResearchBoundaries(env, boundaries);
  try {
    await researchWait(signal, () => runResearch({ auth, fetch: boundaries.fetch ?? globalThis.fetch, researchSetupProfile: researchProfile(env),
      research: { ...research, resolve: hostname => researchWait(signal, () => research.resolve(hostname)), pageHttp: value => researchWait(signal, () => research.pageHttp(value)) } }, signal,
    { status: 'inactive', researchPrepared: 0, researchCompleted: 0, held: 0, mailPolls: 0, dispatches: 0, sendReconciliations: 0, meetings: 0 }, request));
  } catch (error) {
    // Only known admission refusals are held. SDK/unexpected failures propagate
    // to sanitized Lambda FunctionError. Durable reservations survive either way.
    if (!(error instanceof Error) || !['research_once_binding_conflict', 'research_discovery_uncertain', 'worker_unauthorized', 'research_setup_binding_conflict', 'research_setup_descriptor_unavailable', 'research_setup_marker_missing', 'research_source_changed', 'research_pairing_changed', 'research_setup_marker_changed', 'research_model_mismatch'].includes(error.message)) throw error;
  }
  return readResult(auth, request, runId);
}
