import { z } from 'zod';
import { CampaignExecution } from './campaignExecution';
import type { CampaignEventPayload } from '../../../../src/shared/contracts/campaignContract';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { accountIdSchema as id, accountInstantSchema as instant, accountSchema, accountRouteSchema } from '../../../../src/shared/contracts/accountContract';
import { reserveDispatchInputSchema, reservationSchema, type AppendOutcomeInput, type ReserveDispatchInput } from '../../../../src/shared/contracts/delegationContract';
import { accountReplyDraftSchema, threadProjectionSchema } from '../../../../src/shared/contracts/mailThreadContract';
import { DynamoStore, fingerprint, integer, keyPart, type RepositoryOptions } from './dynamoStore';
import { type GoogleAccessEvidence, RemoteGoogleAuthorization } from './remoteGoogleAuthorization';
import { mailThreadKey, mailSuppressionKey } from './threadIntakeRepository';
import { createIntakeBarrier, intakeRegistrySchema, intakeRegistryKey } from './intakeBarrier';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const header = z.string().min(1).max(998).refine(value => !/[\r\n\u0000]/.test(value)); // eslint-disable-line no-control-regex
const rfcId = z.string().max(200).regex(/^<[^<>\s\r\n]+@[^<>\s\r\n]+>$/);
export const frozenDispatchMessageSchema = z.strictObject({ commandId: z.uuid(), from: z.email(), to: z.email(), subject: header.max(240),
  body: z.string().min(1).max(24000).refine(value => !value.includes('\0')), threadId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  inReplyTo: rfcId, references: z.array(rfcId).min(1).max(50) }).refine(message => message.references.includes(message.inReplyTo));
const bindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('thread_participant'), threadId: id, sourceMessageId: id, sourceMessageHash: hash }),
  z.strictObject({ kind: z.literal('account_route'), routeId: id, routeVersion: integer.positive(), accountVersion: integer.positive() }),
]);
const intentBase = { commandId: z.uuid(), action: reserveDispatchInputSchema.omit({ expectedVersion: true }), draftId: id, draftRevision: integer.positive(),
  pairingId: z.uuid(), mailboxSubject: id, frozenMessage: frozenDispatchMessageSchema, binding: bindingSchema };
export const campaignDispatchBindingSchema = z.strictObject({ campaignId: id, campaignRevision: integer.positive(), enrollmentId: id, enrollmentRevision: integer.positive(), stepId: id });
/** D1 consumption contract, not a permit: D1 must persist/fence campaign and enrollment,
 * approved content/target and campaign caps inside the SAME final transaction. */
export const campaignDispatchStateSchema = campaignDispatchBindingSchema.extend({ accountId: id, state: z.literal('active'), approvedRevision: integer.positive(),
  allowedContentHash: hash, allowedTargetHash: hash, capsRevision: integer.positive() });
export const dispatchIntentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...intentBase, kind: z.literal('standalone_reply') }),
  z.strictObject({ ...intentBase, kind: z.literal('campaign_step'), campaign: campaignDispatchBindingSchema }),
]);
export type DispatchIntent = z.infer<typeof dispatchIntentSchema>;
export const dispatchApprovalSchema = z.strictObject({ id, commandId: z.uuid(), intentHash: hash, draft: accountReplyDraftSchema,
  permissionEvidenceId: id, approvedAt: instant, expiresAt: instant });
export const dispatchPermissionSchema = z.strictObject({ id, accountId: id, recipient: z.email(), sender: z.email(), threadId: id,
  sourceMessageId: id, sourceMessageHash: hash, basis: z.enum(['requested_followup', 'ongoing_correspondence']), recordedAt: instant, expiresAt: instant });
const flightSchema = z.strictObject({ accountId: id, commandId: z.uuid(), actionId: id, state: z.enum(['dispatching', 'unknown', 'provider_accepted', 'cancelled']) });
export const dispatchAccountKey = (account: string) => `DISPATCH_ACCOUNT#${keyPart(account)}`;
const capPolicySchema = z.strictObject({ sender: z.email(), dailyLimit: integer });
const capSchema = z.strictObject({ sender: z.email(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), used: integer });
export const dispatchIntentKey = (command: string) => `DISPATCH_INTENT#${keyPart(command)}`;
export const dispatchApprovalKey = (approval: string) => `DISPATCH_APPROVAL#${keyPart(approval)}`;
export const dispatchPermissionKey = (account: string, permission: string) => `DISPATCH_PERMISSION#${keyPart(account)}#${keyPart(permission)}`;
export const dispatchCapPolicyKey = (sender: string) => `DISPATCH_CAP_POLICY#${keyPart(sender)}`;
const actionIndexKey = (account: string, action: string) => `DISPATCH_ACTION#${keyPart(account)}#${keyPart(action)}`;
const draftKey = (account: string, draft: string) => `MAIL_DRAFT#${keyPart(account)}#${keyPart(draft)}`;
const revokedKey = (key: string) => `REVOKED#${key}`;
export const sendEvidenceSchema = z.strictObject({ commandId: z.uuid(), reservation: reservationSchema, state: z.enum(['unknown', 'provider_accepted', 'cancelled']), observedAt: instant,
  kind: z.enum(['provider_result', 'sent_lookup']), reason: z.enum(['provider_accepted', 'provider_not_sent', 'provider_result_unknown', 'sent_match']),
  rfcMessageId: rfcId, providerIdentity: z.strictObject({ messageId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), threadId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/).nullable() }).nullable() });
export type SendEvidence = z.infer<typeof sendEvidenceSchema>;
export type DispatchReservationPlan = { finalize(): TransactWriteItem[] };

/** A persisted policy reader/admission capability, NOT an execution repository.
 * It cannot reserve or send. C1 alone atomically consumes its conditions and caps.
 * Admission methods are trusted operator composition only, never public payload handlers. */
export class DynamoDispatchRepository {
  readonly store: DynamoStore;
  constructor(options: RepositoryOptions, private readonly authorization: RemoteGoogleAuthorization, private readonly campaignExecution?: CampaignExecution) {
    this.store = new DynamoStore(options);
    const other = campaignExecution?.repository.store.options;
    if (other && (other.dynamo !== options.dynamo || other.tableName !== options.tableName || other.workspaceId !== options.workspaceId)) throw new Error('campaign_store_mismatch');
  }
  private async required(key: string) {
    const row = await this.store.get<unknown>(key);
    if (!row) throw new Error('dispatch_evidence_missing');
    return row;
  }
  private async immutable(key: string, data: unknown, checks: TransactWriteItem[] = []) {
    // Even exact replay cannot remove a revocation tombstone.
    await this.store.transact([this.store.put(key, data, null), this.store.absent(revokedKey(key)), ...checks]);
  }
  async admitIntent(input: DispatchIntent): Promise<void> {
    const intent = dispatchIntentSchema.parse(input); this.store.workspace(intent.action.workspaceId);
    if (intent.commandId !== intent.frozenMessage.commandId || intent.action.contentHash !== fingerprint(intent.frozenMessage)
      || intent.action.targetHash !== fingerprint({ sender: intent.frozenMessage.from, recipient: intent.frozenMessage.to, threadId: intent.frozenMessage.threadId })) throw new Error('dispatch_identity_conflict');
    await this.immutable(dispatchIntentKey(intent.commandId), intent, [this.store.put(actionIndexKey(intent.action.accountId, intent.action.actionId), { commandId: intent.commandId }, null)]);
  }
  async admitApproval(input: z.infer<typeof dispatchApprovalSchema>): Promise<void> {
    const approval = dispatchApprovalSchema.parse(input);
    const key = draftKey(approval.draft.accountId, approval.draft.id); const draft = await this.required(key);
    if (fingerprint(accountReplyDraftSchema.parse(draft.data)) !== fingerprint(approval.draft)
      || approval.approvedAt > this.store.now() || approval.expiresAt <= this.store.now() || approval.approvedAt > approval.expiresAt) throw new Error('approval_not_current');
    await this.immutable(dispatchApprovalKey(approval.id), approval, [this.store.check(key, draft.rev)]);
  }
  async admitPermission(input: z.infer<typeof dispatchPermissionSchema>): Promise<void> {
    const permission = dispatchPermissionSchema.parse(input);
    const key = mailThreadKey(permission.accountId, permission.threadId); const row = await this.required(key);
    const projection = threadProjectionSchema.parse(row.data);
    this.permissionSource(permission, projection);
    if (permission.recordedAt > this.store.now() || permission.expiresAt <= this.store.now()) throw new Error('permission_not_current');
    await this.immutable(dispatchPermissionKey(permission.accountId, permission.id), permission, [this.store.check(key, row.rev), this.store.absent(mailSuppressionKey(permission.accountId))]);
  }
  private permissionSource(permission: z.infer<typeof dispatchPermissionSchema>, projection: z.infer<typeof threadProjectionSchema>) {
    const source = projection.thread.messages.find(message => message.id === permission.sourceMessageId);
    if (projection.thread.accountId !== permission.accountId || projection.thread.providerThreadId !== permission.threadId || !source
      || fingerprint(source) !== permission.sourceMessageHash || source.from.length !== 1 || source.from[0] !== permission.recipient
      || !source.to.includes(permission.sender) || source.cc.length !== 0 || source.bodyParts.length === 0 || source.bodyParts.some(part => part.truncated)
      || source.date > permission.recordedAt || source.date > this.store.now()) throw new Error('recipient_permission_unproven');
    return source;
  }
  async revokeApproval(approvalId: string): Promise<void> { await this.immutable(revokedKey(dispatchApprovalKey(approvalId)), { revokedAt: this.store.now() }); }
  async revokePermission(accountId: string, permissionId: string): Promise<void> { await this.immutable(revokedKey(dispatchPermissionKey(accountId, permissionId)), { revokedAt: this.store.now() }); }
  async configureIntake(input: z.infer<typeof intakeRegistrySchema>, expectedRevision: number | null): Promise<void> {
    const registry = intakeRegistrySchema.parse(input);
    await this.store.transact([this.store.put(intakeRegistryKey(registry.accountId), registry, expectedRevision)]);
  }
  async configureCaps(input: z.infer<typeof capPolicySchema>, expectedRevision: number | null): Promise<void> {
    const policy = capPolicySchema.parse(input); await this.store.transact([this.store.put(dispatchCapPolicyKey(policy.sender), policy, expectedRevision)]);
  }
  async loadIntent(commandId: string): Promise<DispatchIntent | null> {
    const row = await this.store.get<unknown>(dispatchIntentKey(commandId));
    if (!row) return null;
    const intent = dispatchIntentSchema.parse(row.data); this.store.workspace(intent.action.workspaceId);
    if (intent.commandId !== commandId || intent.frozenMessage.commandId !== commandId || intent.action.contentHash !== fingerprint(intent.frozenMessage)
      || intent.action.targetHash !== fingerprint({ sender: intent.frozenMessage.from, recipient: intent.frozenMessage.to, threadId: intent.frozenMessage.threadId })) throw new Error('dispatch_identity_conflict');
    return intent;
  }
  async outcomePlan(outcome: AppendOutcomeInput, raw: SendEvidence): Promise<{ items: TransactWriteItem[]; campaign?: CampaignEventPayload }> {
    const evidence = sendEvidenceSchema.parse(raw); const intent = await this.loadIntent(evidence.commandId);
    if (!intent || fingerprint(evidence.reservation) !== fingerprint(outcome.reservation) || evidence.state !== outcome.state
      || evidence.observedAt !== outcome.observedAt || evidence.rfcMessageId !== `<${intent.commandId}@callie.invalid>`
      || intent.action.actionId !== outcome.reservation.actionId || intent.action.accountId !== outcome.reservation.accountId
      || intent.action.contentHash !== outcome.reservation.contentHash || intent.action.targetHash !== outcome.reservation.targetHash
      || intent.action.expectedAuthorityGeneration !== outcome.reservation.authorityGeneration
      || (evidence.state === 'provider_accepted') !== (evidence.providerIdentity !== null)) throw new Error('send_evidence_conflict');
    const flightKey = dispatchAccountKey(intent.action.accountId); const flightRow = await this.required(flightKey);
    const flight = flightSchema.parse(flightRow.data);
    if (flight.commandId !== intent.commandId || flight.accountId !== intent.action.accountId || flight.actionId !== intent.action.actionId
      || !['dispatching', 'unknown'].includes(flight.state)) throw new Error('account_dispatch_conflict');
    const items = [this.store.put(`DISPATCH_EVIDENCE#${keyPart(intent.commandId)}#${fingerprint(evidence)}`, evidence, null),
      this.store.put(flightKey, { ...flight, state: evidence.state }, flightRow.rev)];
    if (intent.kind !== 'campaign_step') return { items };
    if (!this.campaignExecution) throw new Error('campaign_binding_unavailable');
    const hash = fingerprint(evidence);
    const commandId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const campaign = await this.campaignExecution.repository.prepareOutcomePlan({ commandId, accountId: intent.action.accountId,
      actionId: intent.action.actionId, state: evidence.state, observedAt: evidence.observedAt });
    return { items: mergeDispatchConditions([...items, ...campaign.items]), campaign: campaign.payload };
  }
  async sendEvidence(commandId: string): Promise<SendEvidence[]> {
    return (await this.store.list<unknown>(`DISPATCH_EVIDENCE#${keyPart(commandId)}#`)).map(row => {
      const evidence = sendEvidenceSchema.parse(row.stored.data);
      if (evidence.commandId !== commandId) throw new Error('send_evidence_conflict');
      return evidence;
    });
  }
  async reservationPlan(input: ReserveDispatchInput, evidence?: GoogleAccessEvidence): Promise<DispatchReservationPlan> {
    const parsed = reserveDispatchInputSchema.parse(input); this.store.workspace(parsed.workspaceId);
    const indexKey = actionIndexKey(parsed.accountId, parsed.actionId); const index = await this.required(indexKey);
    const commandId = z.strictObject({ commandId: z.uuid() }).parse(index.data).commandId;
    const key = dispatchIntentKey(commandId); const row = await this.required(key); const intent = dispatchIntentSchema.parse(row.data);
    const identity = { actionId: parsed.actionId, workspaceId: parsed.workspaceId, accountId: parsed.accountId,
      expectedAuthorityGeneration: parsed.expectedAuthorityGeneration, approvalId: parsed.approvalId, contentHash: parsed.contentHash, targetHash: parsed.targetHash };
    if (intent.commandId !== commandId || fingerprint(identity) !== fingerprint(intent.action)) throw new Error('dispatch_identity_conflict');
    if (intent.kind === 'campaign_step' && (!this.campaignExecution || intent.binding.kind !== 'account_route')) throw new Error('campaign_binding_unavailable');
    const approvalKey = dispatchApprovalKey(parsed.approvalId); const approvalRow = await this.required(approvalKey);
    const approval = dispatchApprovalSchema.parse(approvalRow.data);
    const dKey = draftKey(parsed.accountId, intent.draftId); const draftRow = await this.required(dKey); const draft = accountReplyDraftSchema.parse(draftRow.data);
    const message = intent.frozenMessage;
    if (approval.id !== parsed.approvalId || approval.commandId !== commandId || approval.intentHash !== fingerprint(intent)
      || fingerprint(approval.draft) !== fingerprint(draft) || draft.id !== intent.draftId || draft.accountId !== parsed.accountId
      || draft.revision !== intent.draftRevision || draft.mailboxSubject !== intent.mailboxSubject || message.commandId !== commandId
      || message.from !== draft.sender || message.to !== draft.recipient || message.subject !== draft.subject || message.body !== draft.body
      || message.threadId !== draft.threadId || parsed.contentHash !== fingerprint(message)
      || parsed.targetHash !== fingerprint({ sender: message.from, recipient: message.to, threadId: message.threadId })) throw new Error('approval_not_current');
    const tKey = mailThreadKey(parsed.accountId, draft.threadId); const threadRow = await this.required(tKey); const thread = threadProjectionSchema.parse(threadRow.data);
    if (thread.thread.accountId !== parsed.accountId || thread.thread.mailboxSubject !== intent.mailboxSubject || thread.thread.providerThreadId !== draft.threadId
      || thread.revision !== draft.threadRevision || thread.contextRevision !== draft.contextRevision
      || thread.signals.some(signal => ['opt_out', 'rejection'].includes(signal.kind))) throw new Error('thread_not_current');
    const pKey = dispatchPermissionKey(parsed.accountId, approval.permissionEvidenceId); const permissionRow = await this.required(pKey);
    const permission = dispatchPermissionSchema.parse(permissionRow.data);
    if (permission.id !== approval.permissionEvidenceId || permission.accountId !== parsed.accountId || permission.recipient !== message.to
      || permission.sender !== message.from || permission.threadId !== draft.threadId) throw new Error('recipient_permission_unproven');
    const source = this.permissionSource(permission, thread);
    if (!source.rfcMessageId || message.inReplyTo !== source.rfcMessageId || !message.references.includes(source.rfcMessageId)) throw new Error('reply_headers_conflict');
    const flightKey = dispatchAccountKey(parsed.accountId); const flightRow = await this.store.get<unknown>(flightKey);
    if (flightRow) {
      const flight = flightSchema.parse(flightRow.data);
      if (flight.accountId !== parsed.accountId || ['dispatching', 'unknown'].includes(flight.state)) throw new Error('account_dispatch_unresolved');
    }
    const checks = [this.store.put(flightKey, { accountId: parsed.accountId, commandId, actionId: parsed.actionId, state: 'dispatching' }, flightRow?.rev ?? null), this.store.check(indexKey, index.rev), this.store.check(key, row.rev), this.store.check(approvalKey, approvalRow.rev),
      this.store.check(dKey, draftRow.rev), this.store.check(tKey, threadRow.rev), this.store.check(pKey, permissionRow.rev)];
    for (const absent of [revokedKey(key), revokedKey(approvalKey), revokedKey(pKey), mailSuppressionKey(parsed.accountId)]) {
      if (await this.store.get(absent)) throw new Error('dispatch_suppressed');
      checks.push(this.store.absent(absent));
    }
    if (intent.binding.kind === 'thread_participant') {
      if (intent.binding.threadId !== draft.threadId || intent.binding.sourceMessageId !== source.id || intent.binding.sourceMessageHash !== fingerprint(source)) throw new Error('recipient_permission_unproven');
    } else {
      const aKey = `ACCOUNT#${keyPart(parsed.accountId)}`; const accountRow = await this.required(aKey);
      // Parse the actual B1 account/route projection, not a parallel route catalog.
      const account = z.object({ account: accountSchema, routes: z.array(accountRouteSchema) }).parse(accountRow.data);
      const binding = intent.binding; const route = account.routes.find(route => route.id === binding.routeId);
      if (account.account.id !== parsed.accountId || account.account.version !== binding.accountVersion || !route || route.accountId !== parsed.accountId
        || route.version !== binding.routeVersion || route.channel !== 'email' || route.value !== message.to || route.purpose !== 'business' || route.verification === 'unverified') throw new Error('route_not_current');
      checks.push(this.store.check(aKey, accountRow.rev));
    }
    const campaign = intent.kind === 'campaign_step' && intent.binding.kind === 'account_route'
      ? await this.campaignExecution!.prepareDispatchChecks({ ...intent.campaign, workspaceId: parsed.workspaceId, accountId: parsed.accountId,
        actionId: parsed.actionId, channel: 'email', authorityGeneration: parsed.expectedAuthorityGeneration, selectedRouteId: intent.binding.routeId,
        contextRevision: draft.contextRevision, contentHash: parsed.contentHash, targetHash: parsed.targetHash }) : null;
    const intake = await createIntakeBarrier(this.store).check({ accountId: parsed.accountId, mailboxSubject: intent.mailboxSubject, requiredRecipient: message.to, requiredThreadId: message.threadId }, new AbortController().signal);
    if (intake.status !== 'ready') throw new Error(intake.reason);
    checks.push(...intake.checks);
    const policyKey = dispatchCapPolicyKey(message.from); const policyRow = await this.required(policyKey); const policy = capPolicySchema.parse(policyRow.data);
    const day = this.store.now().slice(0, 10); const capKey = `DISPATCH_CAP#${keyPart(message.from)}#${day}`;
    const capRow = await this.store.get<unknown>(capKey); const cap = capRow ? capSchema.parse(capRow.data) : { sender: message.from, day, used: 0 };
    if (policy.sender !== message.from || cap.sender !== message.from || cap.day !== day || cap.used >= policy.dailyLimit) throw new Error('dispatch_cap_reached');
    checks.push(this.store.check(policyKey, policyRow.rev), this.store.put(capKey, { ...cap, used: cap.used + 1 }, capRow?.rev ?? null));
    const start = Math.max(Date.parse(approval.approvedAt), Date.parse(permission.recordedAt));
    const end = Math.min(Date.parse(approval.expiresAt), Date.parse(permission.expiresAt), intake.validUntil);
    const finalize = () => {
      const now = Date.parse(this.store.now());
      if (now < start || now >= end || this.store.now().slice(0, 10) !== day) throw new Error('dispatch_evidence_expired');
      if (!evidence) throw new Error('google_access_evidence_missing');
      return mergeDispatchConditions([...checks, ...(campaign?.finalize() ?? []), ...this.authorization.accessChecks(evidence, { pairingId: intent.pairingId, subject: intent.mailboxSubject, requiredCapabilities: ['send', 'relevant_read'] })]);
    };
    finalize();
    return { finalize };
  }
}

/** Dynamo forbids repeated targets. Only byte-equivalent read fences may coalesce. */
function mergeDispatchConditions(items: TransactWriteItem[]): TransactWriteItem[] {
  const targets = new Map<string, TransactWriteItem>();
  for (const item of items) {
    const operation = item.ConditionCheck ?? item.Put ?? item.Update ?? item.Delete;
    if (!operation) throw new Error('dispatch_condition_conflict');
    const key = item.Put ? { pk: item.Put.Item?.pk, sk: item.Put.Item?.sk } : (item.ConditionCheck ?? item.Update ?? item.Delete)!.Key;
    const identity = fingerprint({ table: operation.TableName, key });
    const previous = targets.get(identity);
    if (previous) {
      if (!previous.ConditionCheck || !item.ConditionCheck || fingerprint(previous) !== fingerprint(item)) throw new Error('dispatch_condition_conflict');
    } else targets.set(identity, item);
  }
  return [...targets.values()];
}
