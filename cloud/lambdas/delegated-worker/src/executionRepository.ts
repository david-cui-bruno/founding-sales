import { z } from 'zod';
import { type DynamoDispatchRepository, type SendEvidence } from './dispatchRepository';
import type { GoogleAccessEvidence } from './remoteGoogleAuthorization';
import { authorityStateSchema, commandReceiptSchema, delegationCommandSchema, reservationSchema, workerEventSchema, reserveDispatchInputSchema, appendOutcomeInputSchema,
  actionStateSchema, type AppendOutcomeInput, type CommandReceipt, type DelegationCommand, type ExecutionRepository, type ReserveDispatchInput, type WorkerEvent } from '../../../../src/shared/contracts/delegationContract';
import { accountIdSchema } from '../../../../src/shared/contracts/accountContract';
import { DynamoStore, fingerprint, integer, keyPart, type RepositoryOptions } from './dynamoStore';
const authorityRecordSchema = z.strictObject({ authority: authorityStateSchema, version: integer });
type AuthorityRecord = z.infer<typeof authorityRecordSchema>;
type CommandRecord = { fingerprint: string; receipt: CommandReceipt; sequence: number };
const authKey = (account: string) => `AUTH#${keyPart(account)}`;
const actionKey = (account: string, action: string) => `ACTION#${keyPart(account)}#${keyPart(action)}`;
const authFields = (record: AuthorityRecord) => ({ accountId: record.authority.accountId, generation: record.authority.generation,
  version: record.version, owner: record.authority.owner, state: record.authority.state });
const dispatchSchema = reserveDispatchInputSchema;
const actionIdentitySchema = dispatchSchema.omit({ expectedVersion: true });
function actionIdentity(input: ReserveDispatchInput) {
  return { actionId: input.actionId, workspaceId: input.workspaceId, accountId: input.accountId,
    expectedAuthorityGeneration: input.expectedAuthorityGeneration, approvalId: input.approvalId,
    contentHash: input.contentHash, targetHash: input.targetHash };
}
const preparedSchema = z.strictObject({ input: actionIdentitySchema, state: z.enum(['prepared', 'queued']), queueSequence: integer.positive().optional() });
type ActionRecord = { input: z.infer<typeof actionIdentitySchema>; state: string; queueSequence?: number; reservation?: z.infer<typeof reservationSchema>; outcomeFingerprint?: string; sequence?: number };
/** Explicit C2-authenticated setup and C3/C5-approved intent admission are separate
 * capabilities. Neither is reachable from applyCommand or account research. */
export type ExecutionRepositoryOptions = RepositoryOptions & { dispatchPolicy?: DynamoDispatchRepository };
export class DynamoExecutionRepository implements ExecutionRepository {
  private readonly store: DynamoStore;
  constructor(private readonly options: ExecutionRepositoryOptions) {
    this.store = new DynamoStore(options);
    const binding = options.dispatchPolicy?.store.options;
    if (binding && (binding.dynamo !== options.dynamo || binding.tableName !== options.tableName || binding.workspaceId !== options.workspaceId)) throw new Error('dispatch_policy_binding_conflict');
  }
  async currentVersion(accountId: string): Promise<number> { return (await this.authority(accountId)).data.version; }
  async readDispatch(accountId: string, actionId: string) {
    const row = await this.store.get<unknown>(actionKey(accountId, actionId));
    if (!row) return null;
    const data = z.object({ input: actionIdentitySchema, state: actionStateSchema, reservation: reservationSchema.optional() }).parse(row.data);
    if (data.input.accountId !== accountId || data.input.actionId !== actionId || data.input.workspaceId !== this.options.workspaceId) throw new Error('action_fingerprint_conflict');
    if (data.reservation && (data.reservation.accountId !== accountId || data.reservation.actionId !== actionId
      || data.reservation.workspaceId !== data.input.workspaceId || data.reservation.authorityGeneration !== data.input.expectedAuthorityGeneration
      || data.reservation.contentHash !== data.input.contentHash || data.reservation.targetHash !== data.input.targetHash)) throw new Error('reservation_identity_conflict');
    return { state: data.state, reservation: data.reservation ?? null };
  }
  async seedLocalAuthority(accountId: string): Promise<void> {
    accountIdSchema.parse(accountId);
    const record: AuthorityRecord = { authority: { accountId, owner: 'local', generation: 0, state: 'local' }, version: 0 };
    // Conditional creation only. Never overwrite a delegated/revoked/unknown owner.
    await this.store.transact([this.store.put(authKey(accountId), record, null, authFields(record))]);
  }
  private async authority(accountId: string) {
    const stored = await this.store.get<unknown>(authKey(accountId));
    if (!stored) throw new Error('authority_missing');
    const data = authorityRecordSchema.parse(stored.data);
    if (data.authority.accountId !== accountId) throw new Error('authority_identity_conflict');
    return { ...stored, data };
  }
  private current(record: AuthorityRecord, generation: number, version: number): void {
    if (record.authority.generation !== generation || record.version !== version) throw new Error('stale_authority');
  }
  private async replay(key: string, expected: string): Promise<CommandReceipt | null> {
    const prior = await this.store.get<CommandRecord>(key);
    if (!prior) return null;
    if (prior.data.fingerprint !== expected) throw new Error('command_fingerprint_conflict');
    const receipt = commandReceiptSchema.parse(prior.data.receipt);
    await this.store.publish(integer.positive().parse(prior.data.sequence));
    return receipt;
  }
  async applyCommand(input: DelegationCommand): Promise<CommandReceipt> {
    const command = delegationCommandSchema.parse(input);
    if (!['delegate', 'pause', 'revoke', 'manual-outcome'].includes(command.kind)) throw new Error('owner_command_requires_coordinator');
    this.store.workspace(command.workspaceId);
    const key = `COMMAND#${keyPart(command.commandId)}`;
    const fp = fingerprint(command);
    const prior = await this.replay(key, fp);
    if (prior) return prior;
    const current = await this.authority(command.accountId);
    this.current(current.data, command.expectedAuthorityGeneration, command.expectedVersion);
    const authority = { ...current.data.authority };
    if (command.kind === 'delegate') {
      if (authority.owner !== 'local' || authority.state !== 'local' || authority.generation !== 0) throw new Error('authority_transition_denied');
      authority.owner = 'worker'; authority.state = 'active'; authority.generation++;
    } else if (command.kind === 'pause' || command.kind === 'revoke') {
      if (authority.owner !== 'worker' || !['active', 'paused'].includes(authority.state)) throw new Error('authority_transition_denied');
      authority.state = command.kind === 'pause' ? 'paused' : 'revoked';
      if (command.kind === 'revoke') authority.generation++;
    } else if (authority.owner !== 'worker') throw new Error('authority_transition_denied');
    const next = { authority, version: current.data.version + 1 };
    const receipt = commandReceiptSchema.parse({ commandId: command.commandId, status: 'applied', authorityGeneration: authority.generation,
      aggregateVersion: next.version, reason: null });
    const base = { id: `command-${fingerprint([command.workspaceId, command.commandId])}`, workspaceId: command.workspaceId, accountId: command.accountId,
      authorityGeneration: authority.generation, aggregateVersion: next.version };
    const event = workerEventSchema.parse(command.kind === 'manual-outcome' ? { ...base, kind: 'manual.outcome', receipt, payload: command.payload }
      : { ...base, kind: 'authority.changed', payload: { authority, receipt } });
    const outbox = await this.store.eventItems(event);
    try {
      await this.store.transact([this.store.put(authKey(command.accountId), next, current.rev, authFields(next), authFields(current.data)),
        this.store.put(key, { fingerprint: fp, receipt, sequence: outbox.sequence }, null), ...outbox.items]);
    } catch (error) {
      // Includes ambiguous commit responses. Exact receipts win, altered payloads
      // conflict, absent receipts fail closed. No lease/timer based re-dispatch.
      const committed = await this.replay(key, fp);
      if (committed) return committed;
      throw error;
    }
    await this.store.publish(outbox.sequence);
    return receipt;
  }
  /** Only approved-intent composition may call this. C3/C5 must first persist and
   * verify their exact approval/context/permission snapshot. This does not send. */
  async prepareAction(input: ReserveDispatchInput): Promise<void> {
    const parsed = dispatchSchema.parse(input); this.store.workspace(parsed.workspaceId);
    const current = await this.authority(parsed.accountId);
    this.current(current.data, parsed.expectedAuthorityGeneration, parsed.expectedVersion);
    if (current.data.authority.owner !== 'worker' || current.data.authority.state !== 'active') throw new Error('authority_not_active');
    await this.store.transact([this.store.check(authKey(parsed.accountId), current.rev, authFields(current.data)),
      this.store.put(actionKey(parsed.accountId, parsed.actionId), { input: actionIdentity(parsed), state: 'prepared' }, null, { state: 'prepared' })]);
  }
  /** Trusted preparation primitive, not a permission grant or transport command.
   * Stable action identity is immutable. The caller supplies a fresh CAS version. */
  async queueAction(input: ReserveDispatchInput): Promise<void> {
    const parsed = dispatchSchema.parse(input); this.store.workspace(parsed.workspaceId);
    const identity = actionIdentity(parsed);
    const key = actionKey(parsed.accountId, parsed.actionId);
    const action = await this.store.get<ActionRecord>(key);
    if (!action) throw new Error('action_not_eligible');
    if (fingerprint(actionIdentitySchema.parse(action.data.input)) !== fingerprint(identity)) throw new Error('action_fingerprint_conflict');
    // A prior queue transition is immutable, even if dispatch/outcome happened.
    // Replay can only publish its event, never reset the action to queued.
    if (action.data.queueSequence !== undefined) {
      await this.store.publish(integer.positive().parse(action.data.queueSequence)); return;
    }
    if (action.data.state !== 'prepared') throw new Error('action_not_eligible');
    const prepared = preparedSchema.parse(action.data);
    const authority = await this.authority(parsed.accountId);
    this.current(authority.data, parsed.expectedAuthorityGeneration, parsed.expectedVersion);
    if (authority.data.authority.owner !== 'worker' || authority.data.authority.state !== 'active') throw new Error('authority_not_active');
    const next = { ...authority.data, version: authority.data.version + 1 };
    const outbox = await this.store.eventItems(workerEventSchema.parse({ id: `queue-${fingerprint(identity)}`,
      workspaceId: parsed.workspaceId, accountId: parsed.accountId, authorityGeneration: parsed.expectedAuthorityGeneration,
      aggregateVersion: next.version, kind: 'action.outcome', payload: { actionId: parsed.actionId, state: 'queued',
        contentHash: parsed.contentHash, targetHash: parsed.targetHash, observedAt: this.store.now(), evidenceRef: parsed.approvalId } }));
    try {
      await this.store.transact([this.store.put(authKey(parsed.accountId), next, authority.rev, authFields(next), authFields(authority.data)),
        this.store.put(key, { ...prepared, state: 'queued', queueSequence: outbox.sequence }, action.rev, { state: 'queued' }, { state: 'prepared' }), ...outbox.items]);
    } catch (error) {
      const committed = await this.store.get<ActionRecord>(key);
      if (!committed || fingerprint(committed.data.input) !== fingerprint(identity) || committed.data.queueSequence === undefined) throw error;
      await this.store.publish(integer.positive().parse(committed.data.queueSequence)); return;
    }
    await this.store.publish(outbox.sequence);
  }
  async reserveDispatch(input: ReserveDispatchInput, evidence?: GoogleAccessEvidence) {
    const parsed = dispatchSchema.parse(input); this.store.workspace(parsed.workspaceId);
    const authority = await this.authority(parsed.accountId);
    this.current(authority.data, parsed.expectedAuthorityGeneration, parsed.expectedVersion);
    if (authority.data.authority.owner !== 'worker' || authority.data.authority.state !== 'active') throw new Error('authority_not_active');
    const key = actionKey(parsed.accountId, parsed.actionId);
    const action = await this.store.get<ActionRecord>(key);
    if (!action || !['prepared', 'queued'].includes(action.data.state)) throw new Error('action_not_eligible');
    const prepared = preparedSchema.parse(action.data);
    if (fingerprint(prepared.input) !== fingerprint(actionIdentity(parsed))) throw new Error('action_fingerprint_conflict');
    if (!this.options.dispatchPolicy) throw new Error('dispatch_policy_missing');
    const plan = await this.options.dispatchPolicy.reservationPlan(parsed, evidence);
    const reservation = reservationSchema.parse({ actionId: parsed.actionId, workspaceId: parsed.workspaceId, accountId: parsed.accountId,
      authorityGeneration: parsed.expectedAuthorityGeneration, contentHash: parsed.contentHash, targetHash: parsed.targetHash, state: 'dispatching' });
    // No replay-to-send after an ambiguous transaction result. The caller must
    // reconcile the stable action identity, never call its provider again.
    const next = { ...authority.data, version: authority.data.version + 1 };
    const outbox = await this.store.eventItems(workerEventSchema.parse({ id: `dispatch-${fingerprint(reservation)}`,
      workspaceId: parsed.workspaceId, accountId: parsed.accountId, authorityGeneration: reservation.authorityGeneration,
      aggregateVersion: next.version, kind: 'action.outcome', payload: { actionId: parsed.actionId, state: 'dispatching',
        contentHash: parsed.contentHash, targetHash: parsed.targetHash, observedAt: this.store.now(), evidenceRef: parsed.approvalId } }));
    await this.store.transact([this.store.put(authKey(parsed.accountId), next, authority.rev, authFields(next), authFields(authority.data)),
      this.store.put(key, { ...prepared, state: 'dispatching', reservation }, action.rev, { state: 'dispatching' }, { state: prepared.state }), ...plan.finalize(), ...outbox.items]);
    // The committed outbox is drained separately. No external await may delay
    // the sender continuation after this final reservation boundary.
    return reservation;
  }
  async appendOutcome(input: AppendOutcomeInput, evidence?: SendEvidence): Promise<void> {
    const parsed = appendOutcomeInputSchema.parse(input);
    const reservation = parsed.reservation; this.store.workspace(reservation.workspaceId);
    const key = actionKey(reservation.accountId, reservation.actionId);
    const action = await this.store.get<ActionRecord>(key);
    if (!action || fingerprint(action.data.reservation) !== fingerprint(reservation)) throw new Error('reservation_identity_conflict');
    const fp = evidence ? fingerprint({ parsed, evidence }) : fingerprint(parsed);
    if (action.data.outcomeFingerprint === fp) { if (action.data.sequence) await this.store.publish(action.data.sequence); return; }
    if (!['dispatching', 'unknown'].includes(action.data.state)) throw new Error('outcome_conflict');
    if (evidence && !this.options.dispatchPolicy) throw new Error('dispatch_policy_missing');
    const outcomePlan = evidence ? await this.options.dispatchPolicy!.outcomePlan(parsed, evidence) : { items: [] };
    const authority = await this.authority(reservation.accountId);
    const next = { ...authority.data, version: authority.data.version + 1 };
    // The event generation belongs to the ORIGINAL reservation, even after revoke.
    // Current ownership is preserved byte-for-byte apart from aggregate version.
    const event: WorkerEvent = workerEventSchema.parse({ id: `outcome-${fp}`, workspaceId: reservation.workspaceId, accountId: reservation.accountId,
      authorityGeneration: reservation.authorityGeneration, aggregateVersion: next.version, kind: 'action.outcome', payload: {
        actionId: reservation.actionId, contentHash: reservation.contentHash, targetHash: reservation.targetHash,
        state: parsed.state, observedAt: parsed.observedAt, evidenceRef: parsed.evidenceRef }, ...(outcomePlan.campaign ? { campaign: outcomePlan.campaign } : {}) });
    const outbox = await this.store.eventItems(event);
    await this.store.transact([this.store.put(authKey(reservation.accountId), next, authority.rev, authFields(next), authFields(authority.data)),
      this.store.put(key, { ...action.data, state: parsed.state, outcomeFingerprint: fp, sequence: outbox.sequence }, action.rev,
        { state: parsed.state }, { state: action.data.state }), ...outcomePlan.items, ...outbox.items]);
    await this.store.publish(outbox.sequence);
  }
  eventsAfter(cursor: string | null) { return this.store.eventsAfter(cursor); }
  retryPublications() { return this.store.retryPublications(); }
  retryPublication(sequence: number) { return this.store.publish(integer.positive().parse(sequence)); }
}
export function createExecutionRepository(options: ExecutionRepositoryOptions): DynamoExecutionRepository { return new DynamoExecutionRepository(options); }

// C3 reuses the exact AUTH envelope and scalar fences. Intake must preserve
// authority, advance only version, and atomically commit its state and event.
export { authorityRecordSchema, authKey as executionAuthorityKey, authFields as executionAuthorityFields };
export type { AuthorityRecord };
