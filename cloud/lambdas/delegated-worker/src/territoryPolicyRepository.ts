import { z } from 'zod';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { accountIdSchema as id, accountInstantSchema as instant } from '../../../../src/shared/contracts/accountContract';
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
}
export function createTerritoryPolicyRepository(options: RepositoryOptions): TerritoryPolicyRepository { return new TerritoryPolicyRepository(options); }
