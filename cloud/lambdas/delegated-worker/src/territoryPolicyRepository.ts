import { z } from 'zod';
import { QueryCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { accountIdSchema as id, accountInstantSchema as instant } from '../../../../src/shared/contracts/accountContract';
import { accountRecordSchema, type AccountRecord } from '../../../../src/shared/contracts/accountRecordContract';
import { commandReceiptSchema, workerEventSchema, type CommandReceipt } from '../../../../src/shared/contracts/delegationContract';
import { ownerSourceConfigurationSchema, ownerSourceKey, type TerritoryPolicyCommand } from '../../../../src/shared/contracts/ownerCommandContract';
import { deriveTerritoryCampaignVersion, territoryCallPolicyId, territoryCallPolicySchema, territoryEnrollmentCommandId, territoryEnrollmentId, territoryExecutionContextId,
  territoryHeldSteps, TERRITORY_EMAIL_HOLD_REASON, type TerritoryCallPolicy, type TerritoryHeldStep } from '../../../../src/shared/contracts/territoryCallPolicyContract';
import { executionAuthorityFields, executionAuthorityKey } from './executionRepository';
import { intakeRegistryKey, intakeRegistrySchema } from './intakeBarrier';
import { WorkerCampaignRepository } from './workerCampaignRepository';
import { DynamoStore, fingerprint, integer, keyPart, type RepositoryOptions, type Stored } from './dynamoStore';

export const territoryCallPolicyKey = (workspaceId: string) => `TERRITORY_CALL_POLICY#${keyPart(workspaceId)}`;
export const territoryEnrollmentKey = (accountId: string) => `TERRITORY_ENROLLMENT#${keyPart(accountId)}`;
/** Where the backfill sweep keeps its position. It wraps: reaching the end of the table returns the cursor to the start, so a firm whose
 *  listed route was admitted after the last pass is picked up on a later one. A firm already enrolled costs one read and nothing else. */
export const territoryBackfillCursorKey = 'TERRITORY_BACKFILL_CURSOR';
const ACCOUNT_PREFIX = 'ACCOUNT#';
/** At most this many firms per scheduled tick (the brief's cap): one bounded query and at most one enrollment transaction each. */
export const TERRITORY_BACKFILL_TICK_LIMIT = 50;
/** What the approval receipt path sweeps inline so the first firms appear on David's click instead of on the next tick. Kept small: it runs inside one HTTP request. */
export const TERRITORY_BACKFILL_APPROVAL_LIMIT = 10;
const territoryBackfillCursorSchema = z.strictObject({ version: z.literal(1), after: z.string().min(1).max(2048).nullable() });
export type TerritoryBackfillCursor = z.infer<typeof territoryBackfillCursorSchema>;
export type TerritoryBackfillReport = { outcome: 'completed' | 'exhausted' | 'no_policy' | 'policy_paused' | 'held'; scanned: number; enrolled: number; replayed: number;
  skipped: { policy_paused: number; authority_exists: number; route_unavailable: number; enrollment_failed: number } };
export const emptyTerritoryBackfillReport = (): TerritoryBackfillReport =>
  ({ outcome: 'no_policy', scanned: 0, enrolled: 0, replayed: 0, skipped: { policy_paused: 0, authority_exists: 0, route_unavailable: 0, enrollment_failed: 0 } });
/** The route the policy enrolls a firm on: an admitted listed business phone, exactly what the Places path admits at create time. */
export function listedBusinessRoute(record: AccountRecord): string | null {
  return record.routes.find(route => route.channel === 'phone' && route.purpose === 'business' && route.verification === 'listed')?.id ?? null;
}
const heldStepSchema = z.strictObject({ stepId: id, channel: z.literal('email'), reason: z.literal(TERRITORY_EMAIL_HOLD_REASON) });
/** What one firm received under the policy, keyed by the firm: the replay record a repeated create answers from. */
export const territoryEnrollmentRecordSchema = z.strictObject({ policyId: id, revision: integer.positive(), accountId: id, routeId: id, commandId: z.uuid(), versionId: id, enrollmentId: id,
  sequence: integer.positive(), heldSteps: z.array(heldStepSchema).max(20), grantedAt: instant });
export type TerritoryEnrollmentRecord = z.infer<typeof territoryEnrollmentRecordSchema>;
export type TerritoryPolicyOutcome =
  | ({ outcome: 'enrolled' | 'replayed' } & TerritoryEnrollmentRecord)
  | { outcome: 'no_policy' | 'policy_paused' | 'authority_exists' | 'route_unavailable'; accountId: string; policyId: string | null; revision: number | null };
export type TerritoryPolicyPlan = { items: TransactWriteItem[]; receipt: CommandReceipt; policy: TerritoryCallPolicy | null };
const definitionOf = (policy: TerritoryCallPolicy) => ({ audience: policy.audience, sequence: policy.sequence, caps: policy.caps, objective: policy.objective, offer: policy.offer });
const ROUTE_REFUSALS = ['campaign_record_missing', 'campaign_route_mismatch'];

/** The one standing territory call policy of a workspace and what it does for each firm the worker prepares (D1, D13).
 * Policy commands are planned for the owner coordinator's receipt transaction. `applyTerritoryPolicy` is the worker's own
 * act at create time: authority, derived approved version, enrollment, the no-mail owner source and the empty intake
 * registry the call path needs, all in one transaction with one `authority.granted` event. Nothing here dials or sends. */
export class TerritoryPolicyRepository {
  readonly store: DynamoStore;
  constructor(options: RepositoryOptions) { this.store = new DynamoStore(options); }
  private get workspaceId() { return this.store.options.workspaceId; }
  async read(): Promise<Stored<TerritoryCallPolicy> | null> {
    const row = await this.store.get<unknown>(territoryCallPolicyKey(this.workspaceId));
    if (!row) return null;
    const policy = territoryCallPolicySchema.parse(row.data);
    if (policy.workspaceId !== this.workspaceId) throw new Error('territory_policy_workspace_mismatch');
    return { data: policy, rev: row.rev };
  }
  /** Plan one policy command. A refusal is a rejected receipt naming its reason with no items; the policy returned is
   * always the one that stands after the plan commits. `policy.read` is a pure read. */
  async planCommand(command: TerritoryPolicyCommand, pairingId: string): Promise<TerritoryPolicyPlan> {
    this.store.workspace(command.workspaceId); id.parse(pairingId);
    const current = await this.read(); const p = command.payload; const now = this.store.now();
    const receipt = (status: CommandReceipt['status'], aggregateVersion: number, reason: string | null): CommandReceipt =>
      commandReceiptSchema.parse({ commandId: command.commandId, status, authorityGeneration: 0, aggregateVersion, reason });
    const reject = (reason: string): TerritoryPolicyPlan => ({ items: [], receipt: receipt('rejected', current?.data.revision ?? 0, reason), policy: current?.data ?? null });
    if (p.kind === 'policy.read') return { items: [], receipt: receipt('applied', current?.data.revision ?? 0, null), policy: current?.data ?? null };
    if ((current?.data.revision ?? 0) !== p.expectedRevision) return reject('policy_revision_conflict');
    let next: TerritoryCallPolicy;
    if (p.kind === 'policy.approve') {
      if (current && current.data.state === 'active' && fingerprint(definitionOf(current.data)) === fingerprint(p.definition)) return reject('policy_unchanged');
      const revision = p.expectedRevision + 1;
      next = territoryCallPolicySchema.parse({ ...p.definition, policyId: territoryCallPolicyId(this.workspaceId), workspaceId: this.workspaceId, pairingId, revision, state: 'active', approvedAt: now, approvedRevision: revision, updatedAt: now });
    } else {
      if (!current) return reject('policy_missing');
      if (current.data.state === p.state) return reject('policy_state_unchanged');
      next = territoryCallPolicySchema.parse({ ...current.data, pairingId, revision: current.data.revision + 1, state: p.state, updatedAt: now });
    }
    return { items: [this.store.put(territoryCallPolicyKey(this.workspaceId), next, current?.rev ?? null)], receipt: receipt('applied', next.revision, null), policy: next };
  }
  private replayed(record: TerritoryEnrollmentRecord): TerritoryPolicyOutcome { return { outcome: 'replayed', ...record }; }
  /** Called once per firm after its listed business route is admitted. Idempotent by (policyId, revision, accountId): a
   * repeated create answers from the enrollment record. Expected holds are outcomes, never throws; a missing or paused
   * policy, an existing authority row or an unusable route each leave the firm untouched. */
  async applyTerritoryPolicy(accountId: string, routeId: string): Promise<TerritoryPolicyOutcome> {
    id.parse(accountId); id.parse(routeId);
    const existing = await this.store.get<unknown>(territoryEnrollmentKey(accountId));
    if (existing) {
      const record = territoryEnrollmentRecordSchema.parse(existing.data);
      if (record.accountId !== accountId) throw new Error('territory_enrollment_identity_conflict');
      await this.store.publish(record.sequence);
      return this.replayed(record);
    }
    const current = await this.read();
    const hold = (outcome: 'no_policy' | 'policy_paused' | 'authority_exists' | 'route_unavailable'): TerritoryPolicyOutcome =>
      ({ outcome, accountId, policyId: current?.data.policyId ?? null, revision: current?.data.revision ?? null });
    if (!current) return hold('no_policy');
    const policy = current.data;
    if (policy.state !== 'active') return hold('policy_paused');
    if (await this.store.get(executionAuthorityKey(accountId))) return hold('authority_exists');
    const campaigns = new WorkerCampaignRepository(this.store.options);
    const version = deriveTerritoryCampaignVersion(policy, accountId);
    const commandId = territoryEnrollmentCommandId(policy, accountId);
    const enrollmentId = territoryEnrollmentId(policy, accountId);
    const grantedAt = this.store.now();
    let plan: Awaited<ReturnType<WorkerCampaignRepository['planTerritoryEnrollment']>>;
    try {
      plan = await campaigns.planTerritoryEnrollment({ commandId, accountId, version, approvedAt: grantedAt, enrollmentId, selectedRouteId: routeId,
        executionContextId: territoryExecutionContextId(policy, accountId), contextRevision: 1, requiredChannel: 'phone' });
    } catch (error) {
      if (error instanceof Error && ROUTE_REFUSALS.includes(error.message)) return hold('route_unavailable');
      throw error;
    }
    const authority = { authority: { accountId, owner: 'worker' as const, state: 'active' as const, generation: 1 }, version: 1 };
    const receipt = commandReceiptSchema.parse({ commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 1, reason: null });
    const event = workerEventSchema.parse({ id: `command-${fingerprint([this.workspaceId, commandId])}`, workspaceId: this.workspaceId, accountId, authorityGeneration: 1, aggregateVersion: 1,
      kind: 'authority.granted', payload: { authority: authority.authority, policyId: policy.policyId, revision: policy.revision, receipt }, campaign: plan.payload });
    const outbox = await this.store.eventItems(event);
    // The call path (prepare-manual, readiness) reads an active no-mail owner source bound to the approving pairing and an
    // intake registry with no relevant adapter; both are what configure-owner writes for a no-mail company today.
    const source = ownerSourceConfigurationSchema.parse({ version: 1, workspaceId: this.workspaceId, accountId, pairingId: policy.pairingId, revision: 1, state: 'active', mailboxSubject: null, calendarId: null, research: null });
    const registry = intakeRegistrySchema.parse({ accountId, adapters: [], manualDependencies: [] });
    const heldSteps: TerritoryHeldStep[] = territoryHeldSteps(version);
    const record = territoryEnrollmentRecordSchema.parse({ policyId: policy.policyId, revision: policy.revision, accountId, routeId, commandId, versionId: version.id, enrollmentId, sequence: outbox.sequence, heldSteps, grantedAt });
    const items = [...plan.items,
      this.store.put(executionAuthorityKey(accountId), authority, null, executionAuthorityFields(authority)),
      this.store.put(ownerSourceKey(accountId), source, null),
      this.store.put(intakeRegistryKey(accountId), registry, null),
      this.store.put(territoryEnrollmentKey(accountId), record, null),
      this.store.check(territoryCallPolicyKey(this.workspaceId), current.rev),
      ...outbox.items];
    try { await this.store.transact(items); }
    catch (error) {
      // A lost acknowledgement of this exact enrollment is a replay, never a second grant.
      const committed = await this.store.get<unknown>(territoryEnrollmentKey(accountId));
      const parsed = committed ? territoryEnrollmentRecordSchema.safeParse(committed.data) : null;
      if (parsed?.success && parsed.data.commandId === commandId) { await this.store.publish(parsed.data.sequence); return this.replayed(parsed.data); }
      throw error;
    }
    await this.store.publish(outbox.sequence);
    return { outcome: 'enrolled', ...record };
  }
  /** One bounded ascending page of account records after the cursor. `truncated` is true whenever there may be more firms
   * beyond the last row returned, so a server-side 1 MB cut is never mistaken for the end of the table. */
  private async accountPage(after: string | null, limit: number): Promise<{ rows: { key: string; record: AccountRecord }[]; truncated: boolean }> {
    const result = await this.store.options.dynamo.send(new QueryCommand({ TableName: this.store.options.tableName, ConsistentRead: true, Limit: limit,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)', ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': this.store.key('').pk, ':prefix': { S: ACCOUNT_PREFIX } }, ...(after ? { ExclusiveStartKey: this.store.key(after) } : {}) }));
    const rows: { key: string; record: AccountRecord }[] = [];
    let truncated = typeof result.LastEvaluatedKey?.sk?.S === 'string';
    for (const item of result.Items ?? []) {
      const key = item.sk?.S;
      if (item.pk?.S !== this.store.key('').pk.S || !key?.startsWith(ACCOUNT_PREFIX) || typeof item.data?.S !== 'string') throw new Error('territory_backfill_page_mismatch');
      // Everything at or before the cursor is already swept; the page cap is enforced here and never left to the server's Limit.
      if (after && key <= after) continue;
      if (rows.length >= limit) { truncated = true; break; }
      rows.push({ key, record: accountRecordSchema.parse(JSON.parse(item.data.S)) });
    }
    return { rows, truncated };
  }
  /** Give territory authority to firms that already existed when the policy was approved (the 97 Places firms admitted before any
   * policy existed). Bounded: at most `limit` firms per call, the position persisted after every firm so a crash or a phase deadline
   * resumes instead of starting the table again. Idempotent by the enrollment record: a repeated sweep replays and creates nothing.
   * Expected holds are counted, never thrown; an unexpected enrollment failure is counted and the sweep moves on. Nothing here dials,
   * sends or books, and it produces exactly the `authority.granted` shape `applyTerritoryPolicy` already produces. */
  async sweepTerritoryBackfill(input: { limit: number; signal?: AbortSignal; onFirm?: (accountId: string) => void }): Promise<TerritoryBackfillReport> {
    const report = emptyTerritoryBackfillReport();
    const limit = Math.max(0, Math.min(Math.trunc(input.limit), TERRITORY_BACKFILL_TICK_LIMIT));
    const current = await this.read();
    if (!current) return report;
    if (current.data.state !== 'active') return { ...report, outcome: 'policy_paused' };
    const row = await this.store.get<unknown>(territoryBackfillCursorKey);
    const stored = row ? territoryBackfillCursorSchema.safeParse(row.data) : null;
    let after = stored?.success ? stored.data.after : null;
    let revision = row?.rev ?? null;
    const persist = async (next: string | null) => {
      await this.store.transact([this.store.put(territoryBackfillCursorKey, { version: 1, after: next } satisfies TerritoryBackfillCursor, revision)]);
      revision = (revision ?? 0) + 1; after = next;
    };
    if (limit === 0 || input.signal?.aborted) return { ...report, outcome: 'held' };
    const page = await this.accountPage(after, limit);
    for (const { key, record } of page.rows) {
      if (input.signal?.aborted) return { ...report, outcome: 'held' };
      report.scanned++;
      const routeId = listedBusinessRoute(record);
      // An enrolled firm is answered from its own record: the sweep never re-enters the enrollment path, so a resting sweep grants and publishes nothing.
      if (await this.store.get(territoryEnrollmentKey(record.account.id))) report.replayed++;
      else if (!routeId) report.skipped.route_unavailable++;
      else {
        try {
          const outcome = await this.applyTerritoryPolicy(record.account.id, routeId);
          if (outcome.outcome === 'enrolled') report.enrolled++;
          else if (outcome.outcome === 'replayed') report.replayed++;
          // A policy that vanished under the sweep is the same condition as a paused one: the firm is untouched and a later pass sweeps it.
          else if (outcome.outcome === 'no_policy') report.skipped.policy_paused++;
          else report.skipped[outcome.outcome]++;
        } catch { report.skipped.enrollment_failed++; }
      }
      // The position advances per firm, after the firm's own transaction, so a resumed sweep continues instead of starting the table again.
      await persist(key);
      input.onFirm?.(record.account.id);
    }
    // Reaching the end wraps the cursor: the next pass starts at the top and costs one read per already-enrolled firm.
    if (!page.truncated) { await persist(null); return { ...report, outcome: 'exhausted' }; }
    return { ...report, outcome: 'completed' };
  }
}
export function createTerritoryPolicyRepository(options: RepositoryOptions): TerritoryPolicyRepository { return new TerritoryPolicyRepository(options); }
