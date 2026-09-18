import { z } from 'zod';
import { QueryCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { accountIdSchema as id, accountInstantSchema as instant } from '../../../../src/shared/contracts/accountContract';
import { accountRecordSchema, type AccountRecord } from '../../../../src/shared/contracts/accountRecordContract';
import { commandReceiptSchema, workerEventSchema, type CommandReceipt } from '../../../../src/shared/contracts/delegationContract';
import { ownerSourceConfigurationSchema, ownerSourceKey, type ReplyTemplateCommand, type TerritoryPolicyCommand } from '../../../../src/shared/contracts/ownerCommandContract';
import { decideTemplateEmailStep, workerReplyTemplateApprovalSchema, workerReplyTemplateStateSchema, type ReplyTemplateId, type ReplyTemplateValues, type WorkerReplyTemplateState } from '../../../../src/shared/contracts/replyTemplateContract';
import { decideTerritoryReentry, deriveTerritoryCampaignVersion, territoryAddedStatesSchema, territoryCallPolicyId, territoryCallPolicySchema, territoryEntriesSchema,
  territoryEnrollmentCommandId, territoryEnrollmentId, territoryExecutionContextId, territoryFirstStepId, territoryHeldSteps, TERRITORY_EMAIL_HOLD_REASON,
  type TerritoryAddedStates, type TerritoryCallPolicy, type TerritoryHeldStep } from '../../../../src/shared/contracts/territoryCallPolicyContract';
import { decideTerritoryStateAddition, TERRITORY_RULES_REVISION } from '../../../../src/shared/contracts/territoryClearanceContract';
import { territoryCountsSchema, territoryRemainingNewPerMorning, type TerritoryCounts } from '../../../../src/shared/contracts/researchSetupContract';
import { enrollmentSchema } from '../../../../src/shared/contracts/campaignContract';
import { executionAuthorityFields, executionAuthorityKey } from './executionRepository';
import { intakeRegistryKey, intakeRegistrySchema } from './intakeBarrier';
import { WorkerCampaignRepository, campaignCapKey, campaignEnrollmentKey, campaignSlotKey, territoryEnrollmentKey } from './workerCampaignRepository';
import { DynamoStore, fingerprint, integer, keyPart, type RepositoryOptions, type Stored } from './dynamoStore';
export { territoryEnrollmentKey };

export const territoryCallPolicyKey = (workspaceId: string) => `TERRITORY_CALL_POLICY#${keyPart(workspaceId)}`;
/** Where the backfill sweep keeps its position. It wraps: reaching the end of the table returns the cursor to the start, so a firm whose
 *  listed route was admitted after the last pass is picked up on a later one. A firm already enrolled costs one read and nothing else. */
export const territoryBackfillCursorKey = 'TERRITORY_BACKFILL_CURSOR';
/** Where the workspace's standing template approvals live. One record per workspace, exactly like the territory policy. */
export const replyTemplateStateKey = (workspaceId: string) => `REPLY_TEMPLATE_STATE#${keyPart(workspaceId)}`;
/** Where the states David added on top of the frozen built-in map live. One revisioned record per workspace, like the policy. */
export const territoryAddedStatesKey = (workspaceId: string) => `TERRITORY_ADDED_STATES#${keyPart(workspaceId)}`;
/** Where the worker keeps the territory counts it computed on its last scheduled tick, beside the tick record itself. */
export const territoryCountsKey = 'TERRITORY_COUNTS';
const ACCOUNT_PREFIX = 'ACCOUNT#';
/** At most this many firms per scheduled tick (the brief's cap): one bounded query and at most one enrollment transaction each. */
export const TERRITORY_BACKFILL_TICK_LIMIT = 50;
/** What the approval receipt path sweeps inline so the first firms appear on David's click instead of on the next tick. Kept small: it runs inside one HTTP request. */
export const TERRITORY_BACKFILL_APPROVAL_LIMIT = 10;
const territoryBackfillCursorSchema = z.strictObject({ version: z.literal(1), after: z.string().min(1).max(2048).nullable() });
export type TerritoryBackfillCursor = z.infer<typeof territoryBackfillCursorSchema>;
export type TerritoryBackfillReport = { outcome: 'completed' | 'exhausted' | 'no_policy' | 'policy_paused' | 'held'; scanned: number; enrolled: number; replayed: number;
  /** Firms whose 90-day rest ended and whose sequence the sweep restarted once (D13). Counted here; the tick record
   *  does not carry it yet, and a caller that builds a report by hand may leave it out. */
  reentered?: number;
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
  sequence: integer.positive(), heldSteps: z.array(heldStepSchema).max(20), grantedAt: instant,
  /** D13 single re-entry: which run of the sequence this firm is on. Absent on every record written before the counter existed, which is run 1. */
  entries: territoryEntriesSchema.optional(),
  /** When the worker restarted the sequence for the second and last time. Absent until then. */
  reenteredAt: instant.optional() });
export type TerritoryEnrollmentRecord = z.infer<typeof territoryEnrollmentRecordSchema>;
export type TerritoryPolicyOutcome =
  | ({ outcome: 'enrolled' | 'replayed' } & TerritoryEnrollmentRecord)
  | { outcome: 'no_policy' | 'policy_paused' | 'authority_exists' | 'route_unavailable'; accountId: string; policyId: string | null; revision: number | null };
export type TerritoryPolicyPlan = { items: TransactWriteItem[]; receipt: CommandReceipt; policy: TerritoryCallPolicy | null; added?: TerritoryAddedStates | null };
export type TerritoryTemplatePlan = { items: TransactWriteItem[]; receipt: CommandReceipt; state: WorkerReplyTemplateState | null };
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
    if (p.kind === 'policy.read') return { items: [], receipt: receipt('applied', current?.data.revision ?? 0, null), policy: current?.data ?? null, added: (await this.readAddedStates())?.data ?? null };
    // Adding a state is its own revisioned record: it never touches the policy, never grants and never dials.
    if (p.kind === 'policy.add-state') return this.planAddState(p.state, p.expectedAddedRevision, command.commandId, current?.data ?? null);
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
  /** The states David added on top of the frozen built-in map, or null before he has added one. */
  async readAddedStates(): Promise<Stored<TerritoryAddedStates> | null> {
    const row = await this.store.get<unknown>(territoryAddedStatesKey(this.workspaceId));
    if (!row) return null;
    const added = territoryAddedStatesSchema.parse(row.data);
    if (added.workspaceId !== this.workspaceId) throw new Error('territory_added_states_workspace_mismatch');
    return { data: added, rev: row.rev };
  }
  /**
   * Plan one "Add a state". The zone comes from the fixed contract map and nowhere else, so no calling
   * window is ever computed from a guessed zone; a state that observes two zones is refused by name.
   * CAS on the addition record's own revision. Idempotent by command id: a replayed add answers from the
   * stored record. Adding grants nothing, confirms no clearance and dials nothing: the state appears in
   * Territory clearance as unconfirmed, and the Places regions stay David's own operator decision.
   */
  private async planAddState(state: string, expectedAddedRevision: number, commandId: string, policy: TerritoryCallPolicy | null): Promise<TerritoryPolicyPlan> {
    const row = await this.readAddedStates();
    const current = row?.data ?? null;
    const stored = current?.revision ?? 0;
    const answer = (status: CommandReceipt['status'], aggregateVersion: number, reason: string | null, added: TerritoryAddedStates | null, items: TransactWriteItem[] = []): TerritoryPolicyPlan =>
      ({ items, receipt: commandReceiptSchema.parse({ commandId, status, authorityGeneration: 0, aggregateVersion, reason }), policy, added });
    // A lost acknowledgement of this exact add is a replay, never a second row.
    if (current?.states.some(entry => entry.commandId === commandId)) return answer('applied', current.revision, null, current);
    if (stored !== expectedAddedRevision) return answer('rejected', stored, 'territory_added_revision_conflict', current);
    const decision = decideTerritoryStateAddition(state, current?.states.map(entry => entry.state) ?? []);
    if (decision.kind === 'refused') return answer('rejected', stored, decision.reason, current);
    const now = this.store.now();
    const next = territoryAddedStatesSchema.parse({ version: 1, workspaceId: this.workspaceId, revision: stored + 1, rulesRevision: TERRITORY_RULES_REVISION,
      states: [...(current?.states ?? []), { state: decision.state, timezone: decision.timezone, addedAt: now, commandId }]
        .sort((a, b) => a.state < b.state ? -1 : a.state > b.state ? 1 : 0),
      updatedAt: now });
    return answer('applied', next.revision, null, next, [this.store.put(territoryAddedStatesKey(this.workspaceId), next, row?.rev ?? null)]);
  }
  /** The counts the last scheduled tick computed, or null before the first tick computed them. Settings reports null as unknown. */
  async readTerritoryCounts(): Promise<TerritoryCounts | null> {
    const row = await this.store.get<unknown>(territoryCountsKey);
    const parsed = row ? territoryCountsSchema.safeParse(row.data) : null;
    return parsed?.success ? parsed.data : null;
  }
  /**
   * Count what is left in the territory from the worker's own records (design section 8): firms with an
   * admitted listed business phone, firms the policy already holds authority over, and firms whose first
   * call has not happened yet. Four prefix queries, never one read per firm. Counts only: no firm name,
   * phone number or account id leaves this method.
   */
  async computeTerritoryCounts(): Promise<TerritoryCounts> {
    const policy = await this.read();
    const newFirmsPerDay = policy?.data.caps.newFirmsPerDay ?? null;
    const listed: string[] = [];
    for (const { stored } of await this.store.list<unknown>(ACCOUNT_PREFIX)) {
      const record = accountRecordSchema.safeParse(stored.data);
      if (record.success && listedBusinessRoute(record.data)) listed.push(record.data.account.id);
    }
    const enrollments = new Map<string, TerritoryEnrollmentRecord>();
    for (const { stored } of await this.store.list<unknown>('TERRITORY_ENROLLMENT#')) {
      const parsed = territoryEnrollmentRecordSchema.safeParse(stored.data);
      if (parsed.success) enrollments.set(parsed.data.accountId, parsed.data);
    }
    const live = new Map<string, { state: string; currentStepId: string | null }>();
    for (const { stored } of await this.store.list<unknown>('CAMPAIGN_ENROLLMENT#')) {
      const parsed = enrollmentSchema.safeParse(stored.data);
      if (parsed.success) live.set(parsed.data.id, { state: parsed.data.state, currentStepId: parsed.data.currentStepId });
    }
    let withAuthority = 0;
    for (const { stored } of await this.store.list<{ authority?: { state?: string; owner?: string } }>('AUTH#')) {
      if (stored.data.authority?.owner === 'worker' && stored.data.authority.state === 'active') withAuthority++;
    }
    let notYetCalled = 0;
    for (const accountId of listed) {
      const enrollment = enrollments.get(accountId);
      // A firm with a listed route and no enrollment yet has certainly not been called.
      if (!enrollment) { notYetCalled++; continue; }
      const current = live.get(enrollment.enrollmentId);
      // Still standing on the first step of its own derived version: the day-0 call has not been consumed.
      if (current && current.state === 'active' && current.currentStepId === territoryFirstStepId(enrollment.versionId)) notYetCalled++;
    }
    return territoryCountsSchema.parse({ computedAt: this.store.now(), listedFirms: listed.length, withAuthority, notYetCalled,
      remainingNewPerMorningEstimate: territoryRemainingNewPerMorning(notYetCalled, newFirmsPerDay), newFirmsPerDay });
  }
  /** Compute the counts and store them beside the tick record, at most once per scheduled tick. Writes nothing else. */
  async recordTerritoryCounts(): Promise<TerritoryCounts> {
    const counts = await this.computeTerritoryCounts();
    const row = await this.store.get<unknown>(territoryCountsKey);
    await this.store.transact([this.store.put(territoryCountsKey, counts, row?.rev ?? null)]);
    return counts;
  }
  /**
   * D13 single re-entry. A firm whose 90-day rest has ended starts the sequence again once, at day 0 with
   * `entries: 2`; the second completed run rests 180 days and never re-enters. The per-firm caps counted
   * the first run, so the second run's caps are reset in the same transaction, and a firm with an action
   * still reserved is left for a later sweep instead of having its reservation counted twice. Nothing here
   * dials, sends or books: it only moves the enrollment back to its first step.
   */
  private async reenterRestedFirm(row: Stored<unknown>): Promise<boolean> {
    const parsed = territoryEnrollmentRecordSchema.safeParse(row.data);
    if (!parsed.success) return false;
    const record = parsed.data;
    const enrollmentRow = await this.store.get<unknown>(campaignEnrollmentKey(record.enrollmentId));
    if (!enrollmentRow) return false;
    const enrollment = enrollmentSchema.parse(enrollmentRow.data);
    if (enrollment.accountId !== record.accountId || enrollment.campaignVersionId !== record.versionId) throw new Error('territory_reentry_identity_conflict');
    const decision = decideTerritoryReentry({ firstStepId: territoryFirstStepId(record.versionId),
      enrollment: { state: enrollment.state, restingUntil: enrollment.restingUntil ?? null }, entries: record.entries, now: this.store.now() });
    if (decision.kind !== 'reenter') return false;
    const caps: TransactWriteItem[] = [];
    for (const channel of ['call', 'email', 'linkedin'] as const) {
      const key = campaignCapKey(record.versionId, channel);
      const capRow = await this.store.get<{ reserved?: number; sent?: number }>(key);
      if (!capRow) continue;
      if ((capRow.data.reserved ?? 0) > 0) return false;
      caps.push(this.store.put(key, { reserved: 0, sent: 0 }, capRow.rev));
    }
    const next = enrollmentSchema.parse({ ...enrollment, version: enrollment.version + 1, state: 'active',
      currentStepId: decision.currentStepId, startedAt: decision.startedAt, nextDueAt: decision.startedAt, restingUntil: null });
    const nextRecord = territoryEnrollmentRecordSchema.parse({ ...record, entries: decision.entries, reenteredAt: decision.startedAt });
    const slotRow = await this.store.get<unknown>(campaignSlotKey(record.accountId));
    await this.store.transact([this.store.put(campaignEnrollmentKey(enrollment.id), next, enrollmentRow.rev),
      ...(slotRow ? [this.store.put(campaignSlotKey(record.accountId), { enrollmentId: enrollment.id, state: next.state }, slotRow.rev)] : []),
      this.store.put(territoryEnrollmentKey(record.accountId), nextRecord, row.rev), ...caps]);
    return true;
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
  /** The standing template approvals of this workspace, or null when David has approved none yet. */
  async readTemplateState(): Promise<Stored<WorkerReplyTemplateState> | null> {
    const row = await this.store.get<unknown>(replyTemplateStateKey(this.workspaceId));
    return row ? { data: workerReplyTemplateStateSchema.parse(row.data), rev: row.rev } : null;
  }
  /**
   * Plan one reply-template command for the owner coordinator's receipt transaction (D13). The payload schema has
   * already re-derived the sha256 from the subject and body it carries and re-checked every body rule, so a hash
   * that does not match the text never reaches this method. What is left is the CAS on the stored state.
   *
   * Approving is standing permission to send one already approved template as a sequence step. It is never a send:
   * no dispatch intent, no reservation and no outbox event is created here.
   */
  async planTemplateCommand(command: ReplyTemplateCommand): Promise<TerritoryTemplatePlan> {
    this.store.workspace(command.workspaceId);
    const current = await this.readTemplateState(); const p = command.payload; const now = this.store.now();
    const receipt = (status: CommandReceipt['status'], reason: string | null): CommandReceipt =>
      commandReceiptSchema.parse({ commandId: command.commandId, status, authorityGeneration: 0, aggregateVersion: (current?.data.approvals.length ?? 0) + 1, reason });
    const base = current?.data ?? { approvals: [], paused: false, updatedAt: now };
    const others = base.approvals.filter(approval => approval.templateId !== ('templateId' in p ? p.templateId : ''));
    let next: WorkerReplyTemplateState;
    if (p.kind === 'template-pause') {
      if (base.paused === p.paused) return { items: [], receipt: receipt('rejected', 'template_pause_unchanged'), state: current?.data ?? null };
      next = workerReplyTemplateStateSchema.parse({ ...base, paused: p.paused, updatedAt: now });
    } else if (p.kind === 'template-revoke') {
      const existing = base.approvals.find(approval => approval.templateId === p.templateId);
      if (!existing || existing.revision !== p.revision) return { items: [], receipt: receipt('rejected', 'template_not_approved'), state: current?.data ?? null };
      next = workerReplyTemplateStateSchema.parse({ ...base, approvals: others, updatedAt: now });
    } else {
      const existing = base.approvals.find(approval => approval.templateId === p.templateId);
      // An identical re-approval is a read: the standing permission already names this revision and this hash.
      if (existing && existing.revision === p.revision && existing.contentHash === p.contentHash) return { items: [], receipt: receipt('applied', null), state: base };
      const approval = workerReplyTemplateApprovalSchema.parse({ templateId: p.templateId, revision: p.revision, subject: p.subject,
        body: p.body, contentHash: p.contentHash, approvedAt: now, commandId: command.commandId });
      next = workerReplyTemplateStateSchema.parse({ ...base, approvals: [...others, approval].sort((a, b) => a.templateId < b.templateId ? -1 : 1), updatedAt: now });
    }
    return { items: [this.store.put(replyTemplateStateKey(this.workspaceId), next, current?.rev ?? null)], receipt: receipt('applied', null), state: next };
  }
  /**
   * Whether one sequence email step may send, and with exactly what text. Reads the standing approvals, the
   * worker-held grant and the sender's own recorded arithmetic; decides nothing else. Every refusal is one of the
   * closed hold reasons David reads on Today, never a silent skip and never an inferred success.
   */
  async planTemplateEmailStep(input: { templateId: ReplyTemplateId; pairingId: string; values: ReplyTemplateValues;
    grant(pairingId: string): Promise<boolean>; senderCap(): Promise<{ today: number; sentToday: number } | null> }):
  Promise<ReturnType<typeof decideTemplateEmailStep>> {
    const state = await this.readTemplateState();
    // Read the grant and the cap only when the approval already permits this template, so an unapproved
    // template never touches the Google boundary at all.
    const approved = !!state?.data.approvals.some(approval => approval.templateId === input.templateId) && !state.data.paused;
    const grantConnected = approved ? await input.grant(input.pairingId) : false;
    const senderCap = approved && grantConnected ? await input.senderCap() : null;
    return decideTemplateEmailStep({ templateId: input.templateId, state: state?.data ?? null, grantConnected, senderCap, values: input.values });
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
      const record = accountRecordSchema.parse(JSON.parse(item.data.S));
      // The record must be the account its own key names, or the sweep would act on one firm and advance past another.
      if (key !== `${ACCOUNT_PREFIX}${keyPart(record.account.id)}`) throw new Error('territory_backfill_identity_conflict');
      rows.push({ key, record });
    }
    return { rows, truncated };
  }
  /** Give territory authority to firms that already existed when the policy was approved (the 97 Places firms admitted before any
   * policy existed). Bounded: at most `limit` firms per call, the position persisted after every firm so a crash or a phase deadline
   * resumes instead of starting the table again. Idempotent by the enrollment record: a repeated sweep replays and creates nothing.
   * Expected holds are counted, never thrown; an unexpected enrollment failure is counted and the sweep moves on. Nothing here dials,
   * sends or books, and it produces exactly the `authority.granted` shape `applyTerritoryPolicy` already produces. */
  async sweepTerritoryBackfill(input: { limit: number; signal?: AbortSignal; onFirm?: (accountId: string) => void; count?: boolean }): Promise<TerritoryBackfillReport> {
    const report = emptyTerritoryBackfillReport();
    const limit = Math.max(0, Math.min(Math.trunc(input.limit), TERRITORY_BACKFILL_TICK_LIMIT));
    // The counts are what Settings shows for the whole territory, so they are computed whether or not a policy
    // stands and before any enrollment work. A failure here is never allowed to hold the sweep.
    if (input.count !== false) { try { await this.recordTerritoryCounts(); } catch { /* Settings reports the last stored counts, or unknown. */ } }
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
      const enrolled = await this.store.get<unknown>(territoryEnrollmentKey(record.account.id));
      if (enrolled) {
        report.replayed++;
        // The one thing an already enrolled firm can still need: the single re-entry after its 90-day rest.
        try { if (await this.reenterRestedFirm(enrolled)) report.reentered = (report.reentered ?? 0) + 1; }
        catch { report.skipped.enrollment_failed++; }
      }
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
