import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { accountCreateSchema, accountEvidenceBatchSchema, accountIdSchema, accountInstantSchema, accountRouteSchema,
  accountSchema, accountSourceSchema, type Account, type AccountEvidenceBatch, type AccountEvidenceReceipt, type AccountSource } from '../../../../src/shared/contracts/accountContract';
import { workerEventSchema } from '../../../../src/shared/contracts/delegationContract';
import { projectAccountEvidence } from '../../../../src/main/domain/accounts/accountEvidence';
import { rankAccount } from '../../../../src/shared/accounts/accountRanking';
import { researchLimitsSchema, type AccountResearchStore, type ResearchClaim, type ResearchJob } from '../../../../src/main/research/companyResearchTypes';
import { DynamoStore, fingerprint, integer, keyPart, type RepositoryOptions, type Stored } from './dynamoStore';
import { budgetSchema, researchAdmissionKey, type Budget } from './discoveryReservationStore';
import { accountRecordSchema, type AccountRecord } from '../../../../src/shared/contracts/accountRecordContract';
export { projectionSchema, accountRecordSchema, type AccountRecord } from '../../../../src/shared/contracts/accountRecordContract';
const jobSchema = z.strictObject({ id: z.uuid(), accountId: accountIdSchema, limits: researchLimitsSchema, attempt: integer.positive().max(3),
  claimToken: z.string(), receiptCommandId: z.uuid(), receiptCommitted: z.boolean(), costMicros: integer.nullable(),
  state: z.enum(['queued', 'running', 'completed', 'parked']), reservedCost: integer, claimedAt: accountInstantSchema.nullable() });
type JobRecord = z.infer<typeof jobSchema>;
type Receipt = { fingerprint: string; kind: string; accountId: string; result: Account | AccountEvidenceReceipt; sequence: number; claimToken?: string };
export const accountKey = (id: string) => `ACCOUNT#${keyPart(id)}`;
const jobKey = (id: string) => `JOB#${keyPart(id)}`;
const receiptKey = (id: string) => `ACCOUNT_COMMAND#${keyPart(id)}`;
const jobFields = (job: JobRecord) => ({ accountId: job.accountId, state: job.state, claimToken: job.claimToken, receiptCommitted: job.receiptCommitted });
/** Pure immutable budget planning shared by authenticated atomic admission. */
export function planResearchBudget(store: DynamoStore, limitMicros: number) {
  const budget = budgetSchema.parse({ limit: limitMicros, spent: 0, approvedAt: store.now() });
  return store.put('BUDGET#research', budget, null, { limit: budget.limit, spent: 0 });
}
export class DynamoWorkerAccountRepository implements AccountResearchStore {
  private readonly store: DynamoStore;
  constructor(options: RepositoryOptions) { this.store = new DynamoStore(options); }
  private async account(id: string): Promise<Stored<AccountRecord>> {
    const row = await this.store.get<unknown>(accountKey(id));
    if (!row) throw new Error('account_missing');
    const data = accountRecordSchema.parse(row.data);
    if (data.account.id !== id) throw new Error('account_identity_conflict');
    return { ...row, data };
  }
  private async replay(commandId: string, fp: string): Promise<Receipt | null> {
    const row = await this.store.get<Receipt>(receiptKey(commandId));
    if (!row) return null;
    if (row.data.fingerprint !== fp) throw new Error('account_command_fingerprint_conflict');
    await this.store.publish(integer.positive().parse(row.data.sequence));
    return row.data;
  }
  async create(input: Parameters<AccountResearchStore['create']>[0]): Promise<Account> {
    const parsed = accountCreateSchema.parse(input);
    const fp = fingerprint({ kind: 'create', ...parsed });
    const replay = await this.replay(parsed.commandId, fp);
    if (replay) return accountSchema.parse(replay.result);
    const account = accountSchema.parse({ id: `account-${fingerprint([this.store.options.workspaceId, parsed.commandId])}`, name: parsed.name, domain: parsed.domain, version: 1 });
    const at = this.store.now();
    const data: AccountRecord = { account, sources: [], claims: [], routes: [], researchRevision: 1, history: [{ at, account, claims: [], routes: [] }] };
    const event = workerEventSchema.parse({ id: `create-${fp}`, workspaceId: this.store.options.workspaceId, accountId: account.id,
      authorityGeneration: 0, aggregateVersion: 1, kind: 'research.created', payload: { account, createdAt: at } });
    const outbox = await this.store.eventItems(event);
    try {
      await this.store.transact([this.store.put(accountKey(account.id), data, null, { accountId: account.id, version: 1 }),
        this.store.put(receiptKey(parsed.commandId), { fingerprint: fp, kind: 'create', accountId: account.id, result: account, sequence: outbox.sequence }, null), this.store.absent(jobKey(parsed.commandId)), ...outbox.items]);
    } catch (error) { const committed = await this.replay(parsed.commandId, fp); if (committed) return accountSchema.parse(committed.result); throw error; }
    await this.store.publish(outbox.sequence);
    return account;
  }
  async snapshot(accountId: string, asOf: string) {
    accountInstantSchema.parse(asOf);
    const row = await this.account(accountId);
    const historical = row.data.history.filter(entry => entry.at <= asOf).at(-1);
    if (!historical) throw new Error('account_not_yet_created');
    return projectAccountEvidence(historical.account, historical.claims, historical.routes);
  }
  async listCandidates(asOf: string) {
    accountInstantSchema.parse(asOf);
    const accounts = await this.store.list<AccountRecord>('ACCOUNT#');
    return accounts.flatMap(({ stored }) => {
      const record = accountRecordSchema.parse(stored.data);
      const historical = record.history.filter(entry => entry.at <= asOf).at(-1);
      if (!historical) return [];
      const snapshot = projectAccountEvidence(historical.account, historical.claims, historical.routes);
      return [{ snapshot, rank: rankAccount(snapshot, asOf) }];
    });
  }
  /** Trusted fetched-receipt capability. Bind ONLY B2's awaited onFetched callback,
   * never a model/HTTP command payload. This is attestation, not evidence admission. */
  async recordFetchedSource(input: { accountId: string; source: AccountSource }): Promise<void> {
    const source = accountSourceSchema.parse(input.source); accountIdSchema.parse(input.accountId);
    if (!source.permitted || source.fetchedAt > this.store.now()) throw new Error('source_attestation_required');
    await this.account(input.accountId);
    const key = `FETCHED#${keyPart(source.id)}`;
    const attestation = { accountId: input.accountId, fingerprint: fingerprint(source) };
    const prior = await this.store.get<typeof attestation>(key);
    if (prior) {
      if (fingerprint(prior.data) !== fingerprint(attestation)) throw new Error('source_identity_conflict');
      return;
    }
    await this.store.transact([this.store.put(key, attestation, null)]);
  }
  async admitEvidence(input: AccountEvidenceBatch, claim?: ResearchClaim): Promise<AccountEvidenceReceipt> {
    const batch = accountEvidenceBatchSchema.parse(input);
    const jobRow = await this.store.get<unknown>(jobKey(batch.commandId));
    const job = jobRow ? jobSchema.parse(jobRow.data) : null;
    if (job || claim) {
      if (!job || claim?.jobId !== job.id || claim.claimToken !== job.claimToken || job.accountId !== batch.accountId
        || job.receiptCommandId !== batch.commandId || (job.state !== 'running' && !job.receiptCommitted)) throw new Error('research_claim_fenced');
    }
    const fp = fingerprint({ kind: 'evidence', input: batch });
    const replay = await this.replay(batch.commandId, fp);
    if (replay) {
      if (job && replay.claimToken !== claim?.claimToken) throw new Error('research_claim_fenced');
      const result = z.strictObject({ accountId: accountIdSchema, version: integer.positive(), duplicate: z.boolean() }).parse(replay.result);
      return { ...result, duplicate: true };
    }
    const row = await this.account(batch.accountId);
    if (row.data.account.version !== batch.expectedVersion) throw new Error('stale_account_version');
    const at = this.store.now();
    const next = structuredClone(row.data);
    const checks = job ? [] : [this.store.absent(jobKey(batch.commandId))];
    for (const source of batch.sources) {
      const key = `FETCHED#${keyPart(source.id)}`;
      const attestation = await this.store.get<{ accountId: string; fingerprint: string }>(key);
      if (!source.permitted || source.fetchedAt > at || !attestation || attestation.data.accountId !== batch.accountId
        || attestation.data.fingerprint !== fingerprint(source)) throw new Error('source_attestation_required');
      checks.push(this.store.check(key, attestation.rev));
      const old = next.sources.find(item => item.id === source.id);
      if (old && fingerprint(old) !== fingerprint(source)) throw new Error('source_identity_conflict');
      if (!old) next.sources.push(source);
    }
    const requireEvidence = (ids: string[]) => {
      for (const id of ids) if (!next.sources.some(source => source.id === id && source.fetchedAt <= at)) throw new Error('missing_or_cross_account_evidence');
    };
    for (const claim of batch.claims) { requireEvidence(claim.evidenceIds); next.claims.push(claim); }
    const seenRoutes = new Set<string>();
    for (const route of batch.routes) {
      if (route.accountId !== batch.accountId || seenRoutes.has(route.id)) throw new Error('cross_account_or_duplicate_route');
      seenRoutes.add(route.id); requireEvidence(route.evidenceIds);
      const routeKey = `ROUTE_ID#${keyPart(route.id)}`;
      const identity = await this.store.get<{ accountId: string }>(routeKey);
      if (identity && identity.data.accountId !== batch.accountId) throw new Error('cross_account_route');
      checks.push(identity ? this.store.check(routeKey, identity.rev) : this.store.put(routeKey, { accountId: batch.accountId }, null));
      const old = next.routes.find(item => item.id === route.id);
      next.routes = next.routes.filter(item => item.id !== route.id);
      next.routes.push(accountRouteSchema.parse({ ...route, version: (old?.version ?? 0) + 1 }));
    }
    next.account = { ...next.account, version: next.account.version + 1 }; next.researchRevision++;
    next.history.push({ at, account: next.account, claims: [...next.claims], routes: [...next.routes] });
    const receipt: AccountEvidenceReceipt = { accountId: batch.accountId, version: next.account.version, duplicate: false };
    const event = workerEventSchema.parse({ id: `evidence-${fp}`, workspaceId: this.store.options.workspaceId, accountId: batch.accountId,
      authorityGeneration: 0, aggregateVersion: next.researchRevision, kind: 'research.evidence', payload: { batch, admittedAt: at } });
    const outbox = await this.store.eventItems(event);
    const writes = [this.store.put(accountKey(batch.accountId), next, row.rev, { accountId: batch.accountId, version: next.account.version },
      { accountId: batch.accountId, version: batch.expectedVersion }), this.store.put(receiptKey(batch.commandId), {
        fingerprint: fp, kind: 'evidence', accountId: batch.accountId, result: receipt, sequence: outbox.sequence, ...(claim ? { claimToken: claim.claimToken } : {}) }, null), ...checks, ...outbox.items];
    if (job && jobRow) {
      const nextJob = { ...job, receiptCommitted: true };
      writes.push(this.store.put(jobKey(job.id), nextJob, jobRow.rev, jobFields(nextJob), jobFields(job)));
    }
    try { await this.store.transact(writes); }
    catch (error) {
      // Re-enter the token guard before interpreting an ambiguous committed receipt.
      const committed = await this.store.get<Receipt>(receiptKey(batch.commandId));
      if (committed?.data.fingerprint === fp && (!claim || committed.data.claimToken === claim.claimToken)) return this.admitEvidence(batch, claim);
      throw error;
    }
    await this.store.publish(outbox.sequence);
    return receipt;
  }
  /** Explicit immutable workspace research ceiling. Missing budget is deny. */
  async approveResearchBudget(limitMicros: number): Promise<void> {
    const source = await this.store.get('OWNER_RESEARCH_SOURCE');
    const admission = await this.store.get(researchAdmissionKey);
    await this.store.transact([this.store.put(researchAdmissionKey, { version: 1, kind: 'legacy' }, admission?.rev ?? null), planResearchBudget(this.store, limitMicros), this.store.absent('GUIDED_RESEARCH_SETUP'), source ? this.store.check('OWNER_RESEARCH_SOURCE', source.rev) : this.store.absent('OWNER_RESEARCH_SOURCE')]);
  }
  async enqueue(input: Parameters<AccountResearchStore['enqueue']>[0]): Promise<void> {
    const parsed = z.strictObject({ commandId: z.uuid(), accountId: accountIdSchema, limits: researchLimitsSchema }).parse(input);
    const key = jobKey(parsed.commandId);
    const existing = await this.store.get<JobRecord>(key);
    if (existing) {
      if (existing.data.accountId !== parsed.accountId || fingerprint(existing.data.limits) !== fingerprint(parsed.limits)) throw new Error('research_command_fingerprint_conflict');
      return;
    }
    const account = await this.account(parsed.accountId);
    const attemptKey = `RESEARCH_ATTEMPTS#${fingerprint({ accountId: parsed.accountId, limits: parsed.limits })}`;
    const attempts = await this.store.get<{ count: number }>(attemptKey);
    const attempt = integer.parse(attempts?.data.count ?? 0) + 1;
    if (attempt > 3) throw new Error('research_attempt_limit');
    const job: JobRecord = { id: parsed.commandId, accountId: parsed.accountId, limits: parsed.limits, attempt, claimToken: '', receiptCommandId: parsed.commandId,
      receiptCommitted: false, costMicros: null, state: 'queued', reservedCost: 0, claimedAt: null };
    await this.store.transact([this.store.check(accountKey(parsed.accountId), account.rev), this.store.put(key, job, null, jobFields(job)),
      this.store.put(attemptKey, { count: attempt }, attempts?.rev ?? null),
      // A previously used non-evidence command cannot impersonate a job receipt.
      this.store.absent(receiptKey(parsed.commandId))]);
  }
  /** Exact read only. Never settles stale claims or publishes events. */
  async readJob(id: string) {
    const row = await this.store.get<unknown>(jobKey(z.uuid().parse(id)));
    if (!row) return null;
    const job = jobSchema.parse(row.data);
    if (job.id !== id || job.receiptCommandId !== id) throw new Error('research_job_identity_conflict');
    if (job.receiptCommitted) {
      const receipt = await this.store.get<Receipt>(receiptKey(job.receiptCommandId));
      if (!receipt || receipt.data.kind !== 'evidence' || receipt.data.accountId !== job.accountId || receipt.data.claimToken !== job.claimToken) throw new Error('research_receipt_conflict');
    }
    return job;
  }
  /** Selected before ANY mutation. A race/ambiguous acknowledgment never
   * falls through to another job or starts an unreceipted running claim. */
  async claimExact(id: string, asOf: string, expected?: Pick<ResearchJob, 'accountId' | 'limits'>): Promise<ResearchJob | null> {
    accountInstantSchema.parse(asOf); z.uuid().parse(id);
    const stored = await this.store.get<unknown>(jobKey(id));
    if (!stored) return null;
    const job = jobSchema.parse(stored.data);
    if (job.id !== id || job.receiptCommandId !== id || expected && (job.accountId !== expected.accountId || fingerprint(job.limits) !== fingerprint(expected.limits))) throw new Error('research_job_identity_conflict');
    try { return await this.claimRows([{ stored }], asOf); }
    catch (error) {
      const current = await this.readJob(id);
      if (current && current.state !== 'queued') return null;
      throw error;
    }
  }
  async claimNext(asOf: string): Promise<ResearchJob | null> {
    accountInstantSchema.parse(asOf);
    const jobs = await this.store.list<unknown>('JOB#');
    return this.claimRows(jobs, asOf);
  }
  private async claimRows(jobs: { stored: Stored<unknown> }[], asOf: string): Promise<ResearchJob | null> {
    for (const { stored } of jobs) {
      const job = jobSchema.parse(stored.data);
      if (job.state === 'running' && job.receiptCommitted) {
        const receipt = await this.store.get<Receipt>(receiptKey(job.receiptCommandId));
        if (!receipt || receipt.data.kind !== 'evidence' || receipt.data.accountId !== job.accountId || receipt.data.claimToken !== job.claimToken) throw new Error('research_receipt_conflict');
        await this.store.publish(integer.positive().parse(receipt.data.sequence));
        return this.publicJob(job);
      }
      if (job.state === 'running' && job.claimedAt && Date.parse(asOf) - Date.parse(job.claimedAt) >= 300000) {
        // A stale unreceipted claim is ambiguous spend, not another HTTP attempt.
        await this.settle({ jobId: job.id, claimToken: job.claimToken, status: 'parked', receiptCommandId: null, costMicros: null });
      }
    }
    for (const { stored } of jobs) {
      const job = jobSchema.parse(stored.data);
      if (job.state !== 'queued') continue;
      const budgetRow = await this.store.get<Budget>('BUDGET#research');
      if (!budgetRow) return null;
      const budget = budgetSchema.parse(budgetRow.data);
      if (budget.spent + job.limits.maxCostMicros > budget.limit) continue;
      const claimed: JobRecord = { ...job, state: 'running', claimToken: randomUUID(), reservedCost: job.limits.maxCostMicros, claimedAt: asOf };
      const spent = budget.spent + claimed.reservedCost;
      await this.store.transact([this.store.put(jobKey(job.id), claimed, stored.rev, jobFields(claimed), jobFields(job)),
        this.store.put('BUDGET#research', { ...budget, spent }, budgetRow.rev, { limit: budget.limit, spent }, { limit: budget.limit, spent: budget.spent })]);
      return this.publicJob(claimed);
    }
    return null;
  }
  private publicJob(job: JobRecord): ResearchJob {
    return { id: job.id, accountId: job.accountId, limits: job.limits, attempt: job.attempt, claimToken: job.claimToken,
      receiptCommandId: job.receiptCommandId, receiptCommitted: job.receiptCommitted, costMicros: job.costMicros };
  }
  async settle(input: Parameters<AccountResearchStore['settle']>[0]): Promise<void> {
    const parsed = z.strictObject({ jobId: z.uuid(), claimToken: z.string().min(1), status: z.enum(['completed', 'parked']),
      receiptCommandId: z.uuid().nullable(), costMicros: integer.nullable() }).parse(input);
    const row = await this.store.get<unknown>(jobKey(parsed.jobId));
    if (!row) throw new Error('research_claim_fenced');
    const job = jobSchema.parse(row.data);
    if (job.claimToken !== parsed.claimToken) throw new Error('research_claim_fenced');
    if (job.state !== 'running') {
      if (job.state === parsed.status && job.costMicros === parsed.costMicros && (parsed.receiptCommandId === (job.receiptCommitted ? job.receiptCommandId : null))) return;
      throw new Error('research_claim_fenced');
    }
    if ((parsed.status === 'completed' && (!job.receiptCommitted || parsed.receiptCommandId !== job.receiptCommandId))
      || (parsed.status === 'parked' && (job.receiptCommitted || parsed.receiptCommandId !== null))) throw new Error('research_receipt_conflict');
    if (parsed.costMicros !== null && parsed.costMicros > job.reservedCost) throw new Error('cost_exceeds_reservation');
    const account = await this.account(job.accountId);
    const nextAccount = { ...account.data, researchRevision: account.data.researchRevision + 1 };
    const nextJob = { ...job, state: parsed.status, costMicros: parsed.costMicros };
    const outbox = await this.store.eventItems(workerEventSchema.parse({ id: `settle-${fingerprint(parsed)}`, workspaceId: this.store.options.workspaceId,
      accountId: job.accountId, authorityGeneration: 0, aggregateVersion: nextAccount.researchRevision, kind: 'research.receipt', payload: {
        jobId: job.id, receiptCommandId: parsed.receiptCommandId, status: parsed.status, costMicros: parsed.costMicros, observedAt: this.store.now() } }));
    const writes = [this.store.put(jobKey(job.id), nextJob, row.rev, jobFields(nextJob), jobFields(job)),
      this.store.put(accountKey(job.accountId), nextAccount, account.rev, { accountId: job.accountId, version: account.data.account.version }), ...outbox.items];
    if (parsed.costMicros !== null && parsed.costMicros < job.reservedCost) {
      const budgetRow = await this.store.get<Budget>('BUDGET#research');
      if (!budgetRow) throw new Error('budget_missing');
      const budget = budgetSchema.parse(budgetRow.data);
      const spent = integer.parse(budget.spent - (job.reservedCost - parsed.costMicros));
      writes.push(this.store.put('BUDGET#research', { ...budget, spent }, budgetRow.rev, { limit: budget.limit, spent }, { spent: budget.spent, limit: budget.limit }));
    }
    await this.store.transact(writes);
    await this.store.publish(outbox.sequence);
  }
}
export function createWorkerAccountRepository(options: RepositoryOptions): DynamoWorkerAccountRepository { return new DynamoWorkerAccountRepository(options); }
