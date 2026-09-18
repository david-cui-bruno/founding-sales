import { z } from 'zod';
import { requestedFollowupDraftSchema, requestedRecipientSchema, originalCallRefSchema, type RequestedFollowupDraft } from '../../../../src/shared/contracts/requestedFollowupContract';
import { requestedFollowupContextRevision } from '../../../../src/main/outreach/requestedFollowupService';
import { mailScopeFingerprint } from '../../../../src/main/outreach/providers/gmailThreadProvider';
import { DynamoRequestedFollowupRepository, requestedFollowupDraftKey, type RequestedFollowupPlan } from './requestedFollowupRepository';
import { loadRequestedApproval, requestedApprovalKey, requestedApprovalRecordSchema, type RequestedApprovalRecord } from './requestedFollowupApproval';
import { executionAuthorityFields } from './executionRepository';
import { pairingKey } from './workerAuth';
import { campaignEnrollmentKey, campaignSlotKey, type RequestedFollowupCampaignOrigin } from './workerCampaignRepository';
import { CampaignExecution, type CampaignExecutionPlan } from './campaignExecution';
import { ownerSourceConfigurationSchema, ownerSourceKey } from '../../../../src/shared/contracts/ownerCommandContract';
import type { CampaignEventPayload } from '../../../../src/shared/contracts/campaignContract';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { accountIdSchema as id, accountInstantSchema as instant, accountSchema, accountRouteSchema, accountClaimSchema,
  accountSourceSchema as citedSourceSchema } from '../../../../src/shared/contracts/accountContract';
import { createHash } from 'node:crypto';
import { REPLY_TEMPLATE_IDS, REPLY_TEMPLATE_PURPOSES, workerReplyTemplateStateSchema } from '../../../../src/shared/contracts/replyTemplateContract';
import { replyTemplateStateKey } from './territoryPolicyRepository';
import { reserveDispatchInputSchema, reservationSchema, type AppendOutcomeInput, type ReserveDispatchInput } from '../../../../src/shared/contracts/delegationContract';
import { accountReplyDraftSchema, threadProjectionSchema } from '../../../../src/shared/contracts/mailThreadContract';
import { DynamoStore, fingerprint, integer, keyPart, type RepositoryOptions } from './dynamoStore';
import { type GoogleAccessEvidence, RemoteGoogleAuthorization, dispatchCapPolicyKey, dispatchCapUsageKey, senderFirstSendKey } from './remoteGoogleAuthorization';
import { senderCapForDay, senderCapPolicySchema as capPolicySchema, senderFirstSendSchema } from '../../../../src/shared/contracts/workerPolicyContract';
import { mailThreadKey, mailSuppressionKey } from './threadIntakeRepository';
import { createIntakeBarrier, intakeRegistrySchema, intakeRegistryKey } from './intakeBarrier';

/** Historically exported from this module; the definitions now live beside the grant so the one
 * grant status read and this cap check share them without the two modules importing each other. */
export { dispatchCapPolicyKey, dispatchCapUsageKey, senderFirstSendKey };

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
const commonIntentBase = { commandId: z.uuid(), action: reserveDispatchInputSchema.omit({ expectedVersion: true }), draftId: id, draftRevision: integer.positive(),
  pairingId: z.uuid(), mailboxSubject: id };
const intentBase = { ...commonIntentBase, frozenMessage: frozenDispatchMessageSchema, binding: bindingSchema };
export const frozenFirstEmailSchema = z.strictObject({ commandId: z.uuid(), from: z.email(), to: z.email(), subject: header.max(240), body: z.string().min(1).max(24000).refine(value => !value.includes('\0')) });
export const phoneRequestedFollowupIntentSchema = z.strictObject({ ...commonIntentBase, kind: z.literal('phone_requested_followup'), requestedApprovalCommandId: z.uuid(), frozenMessage: frozenFirstEmailSchema });
export type PhoneRequestedFollowupIntent = z.infer<typeof phoneRequestedFollowupIntentSchema>;
function targetHash(message: z.infer<typeof frozenDispatchMessageSchema> | z.infer<typeof frozenFirstEmailSchema>) {
  return fingerprint('threadId' in message ? { sender: message.from, recipient: message.to, threadId: message.threadId } : { sender: message.from, recipient: message.to });
}
export const campaignDispatchBindingSchema = z.strictObject({ campaignId: id, campaignRevision: integer.positive(), enrollmentId: id, enrollmentRevision: integer.positive(), stepId: id });
/** D1 consumption contract, not a permit: D1 must persist/fence campaign and enrollment,
 * approved content/target and campaign caps inside the SAME final transaction. */
export const campaignDispatchStateSchema = campaignDispatchBindingSchema.extend({ accountId: id, state: z.literal('active'), approvedRevision: integer.positive(),
  allowedContentHash: hash, allowedTargetHash: hash, capsRevision: integer.positive() });
/**
 * The cold first email of a territory sequence step (D13, lane 39). Lane 31 shipped the standing template approval
 * and the send-or-hold decision, and then had nowhere to hand a send: every intent kind but `phone_requested_followup`
 * assumes a reply thread, and a firm that has never written to us has none.
 *
 * What makes this intent admissible is not a thread and not a route: it is one cited `business_email` claim on the
 * firm's own record, and one standing approval of the exact template revision whose text this message was rendered
 * from. Both are re-checked at reservation, so an edited template or a changed claim holds the step instead of
 * sending. The intent carries the template's hash, never its text: the text that goes out is the frozen message, and
 * the frozen message is what the content hash of the action already fences.
 */
export const templateSequenceBindingSchema = z.strictObject({ kind: z.literal('account_claim'),
  claimIndex: integer.max(199), accountVersion: integer.positive(), email: z.email() });
export const templateSequenceEmailIntentSchema = z.strictObject({ ...commonIntentBase, kind: z.literal('template_sequence_email'),
  frozenMessage: frozenFirstEmailSchema, binding: templateSequenceBindingSchema,
  /** The sequence step this send belongs to. One send per step: the action index already admits one intent per action. */
  stepId: id, campaignVersionId: id, enrollmentId: id,
  template: z.strictObject({ templateId: z.enum(REPLY_TEMPLATE_IDS), revision: integer.positive(), contentHash: hash,
    purpose: z.enum(REPLY_TEMPLATE_PURPOSES) }) });
export type TemplateSequenceEmailIntent = z.infer<typeof templateSequenceEmailIntentSchema>;
export const dispatchIntentSchema = z.discriminatedUnion('kind', [
  phoneRequestedFollowupIntentSchema,
  templateSequenceEmailIntentSchema,
  z.strictObject({ ...intentBase, kind: z.literal('standalone_reply') }),
  z.strictObject({ ...intentBase, kind: z.literal('campaign_step'), campaign: campaignDispatchBindingSchema }),
]);
export type DispatchIntent = z.infer<typeof dispatchIntentSchema>;
/** The two first-email kinds answer no thread; every other kind replies inside one and is fenced on its thread id. */
export function threadedDispatchIntent(intent: DispatchIntent): intent is Extract<DispatchIntent, { kind: 'standalone_reply' | 'campaign_step' }> {
  return intent.kind === 'standalone_reply' || intent.kind === 'campaign_step';
}
/**
 * Permission to write one cold first email to a firm's published business inbox. Its whole basis is the firm's own
 * published page: the cited `business_email` claim, the source that carries it, and that source's recorded sha256.
 * It is recorded once, against the exact account version the claim was read at, and it expires. Recording it is not
 * a send and not a standing permission: each send still needs its own approved template and its own reservation.
 */
export const templateSequencePermissionSchema = z.strictObject({ basis: z.literal('listed_business_email'), id, accountId: id,
  recipient: z.email(), sender: z.email(), mailboxSubject: id, accountVersion: integer.positive(), claimIndex: integer.max(199),
  claimFingerprint: hash, sourceId: id, sourceSha256: hash, recordedAt: instant, expiresAt: instant });
export type TemplateSequencePermission = z.infer<typeof templateSequencePermissionSchema>;
export const templateSequencePermissionKey = (account: string, permission: string) => `TEMPLATE_PERMISSION#${keyPart(account)}#${keyPart(permission)}`;
export const dispatchApprovalSchema = z.strictObject({ id, commandId: z.uuid(), intentHash: hash, draft: accountReplyDraftSchema,
  permissionEvidenceId: id, approvedAt: instant, expiresAt: instant });
export const dispatchPermissionSchema = z.strictObject({ id, accountId: id, recipient: z.email(), sender: z.email(), threadId: id,
  sourceMessageId: id, sourceMessageHash: hash, basis: z.enum(['requested_followup', 'ongoing_correspondence']), recordedAt: instant, expiresAt: instant });
const flightSchema = z.strictObject({ accountId: id, commandId: z.uuid(), actionId: id, state: z.enum(['dispatching', 'unknown', 'provider_accepted', 'cancelled']) });
export const dispatchAccountKey = (account: string) => `DISPATCH_ACCOUNT#${keyPart(account)}`;
export const dispatchConflictKey = (account: string) => `DISPATCH_CONFLICT#${keyPart(account)}`;
const conflictSchema = z.strictObject({ accountId: id, actionId: id, commandId: z.uuid(), evidenceRef: id, observedAt: instant });
const capSchema = z.strictObject({ sender: z.email(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), used: integer });
export const dispatchIntentKey = (command: string) => `DISPATCH_INTENT#${keyPart(command)}`;
export const dispatchApprovalKey = (approval: string) => `DISPATCH_APPROVAL#${keyPart(approval)}`;
export const dispatchPermissionKey = (account: string, permission: string) => `DISPATCH_PERMISSION#${keyPart(account)}#${keyPart(permission)}`;
const actionIndexKey = (account: string, action: string) => `DISPATCH_ACTION#${keyPart(account)}#${keyPart(action)}`;
const draftKey = (account: string, draft: string) => `MAIL_DRAFT#${keyPart(account)}#${keyPart(draft)}`;
const revokedKey = (key: string) => `REVOKED#${key}`;
export const sendEvidenceSchema = z.strictObject({ commandId: z.uuid(), reservation: reservationSchema, state: z.enum(['unknown', 'provider_accepted', 'cancelled']), observedAt: instant,
  kind: z.enum(['provider_result', 'sent_lookup']), reason: z.enum(['provider_accepted', 'provider_not_sent', 'provider_result_unknown', 'sent_match']),
  rfcMessageId: rfcId, providerIdentity: z.strictObject({ messageId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), threadId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/).nullable() }).nullable() });
export type SendEvidence = z.infer<typeof sendEvidenceSchema>;
const requestedCampaignOriginSchema = z.strictObject({ accountId: id, campaignVersionId: id, enrollmentId: id, stepId: id, actionId: id, originalOutcomeCommandId: z.uuid(), routeId: id, routeVersion: integer.positive(), executionContextId: id, contextRevision: integer });
export const phoneRequestPermissionSchema = z.strictObject({ basis: z.literal('phone_request'), id, accountId: id, recipient: z.email(), sender: z.email(), mailboxSubject: id,
  originalCall: originalCallRefSchema, recipientBinding: requestedRecipientSchema, accountVersion: integer.positive(), researchRevision: integer.positive(), contextRevision: hash,
  attestationCommandId: z.uuid(), attestationHash: hash, recordedAt: instant, expiresAt: instant, campaignOrigin: requestedCampaignOriginSchema });
export const requestedDispatchApprovalSchema = z.strictObject({ kind: z.literal('phone_requested_followup'), id, commandId: z.uuid(), requestedApprovalCommandId: z.uuid(),
  intentHash: hash, draft: requestedFollowupDraftSchema, permission: phoneRequestPermissionSchema, approvedAt: instant, expiresAt: instant });
type LoadedRequestedApproval = NonNullable<Awaited<ReturnType<typeof loadRequestedApproval>>>;
export type DispatchReservationPlan = { finalize(): TransactWriteItem[]; campaign?: CampaignEventPayload };

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
    if (intent.kind === 'phone_requested_followup') throw new Error('requested_admission_required');
    if (intent.commandId !== intent.frozenMessage.commandId || intent.action.contentHash !== fingerprint(intent.frozenMessage)
      || intent.action.targetHash !== targetHash(intent.frozenMessage)) throw new Error('dispatch_identity_conflict');
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
  /**
   * The recorded business email of one firm, read from the account row exactly as a recipient binding names it: the
   * claim at that index must be a `business_email` fact naming that address, and its citation must be a permitted
   * source whose stored excerpt still hashes to its recorded sha256. Returns the proof, or throws `no_business_email`
   * — lane 31's own closed reason, so a step that loses its address reads the same on Today as one that never had one.
   */
  private async businessEmailProof(accountId: string, binding: z.infer<typeof templateSequenceBindingSchema>) {
    const key = `ACCOUNT#${keyPart(accountId)}`; const row = await this.store.get<unknown>(key);
    const record = z.object({ account: accountSchema, claims: z.array(accountClaimSchema) }).safeParse(row?.data);
    if (!row || !record.success || record.data.account.id !== accountId || record.data.account.version !== binding.accountVersion) throw new Error('no_business_email');
    const claim = record.data.claims[binding.claimIndex];
    if (!claim || claim.key !== 'business_email' || claim.kind !== 'fact' || claim.value !== binding.email || claim.evidenceIds.length !== 1) throw new Error('no_business_email');
    const sourceId = claim.evidenceIds[0]!;
    const sources = z.object({ sources: z.array(citedSourceSchema) }).safeParse(row.data);
    const cited = sources.success ? sources.data.sources.filter(source => source.id === sourceId) : [];
    const source = cited[0];
    if (cited.length !== 1 || !source || !source.permitted
      || createHash('sha256').update(source.excerpt).digest('hex') !== source.sha256) throw new Error('no_business_email');
    return { key, rev: row.rev, claim, claimFingerprint: fingerprint(claim), sourceId, sourceSha256: source.sha256 };
  }
  /**
   * Record permission to write one cold first email to a firm's published business inbox, from the firm's own page.
   * Immutable and fenced on the account row it was read from; a second admission with the same id must carry the
   * identical proof. This writes no intent, reserves nothing and sends nothing.
   */
  async admitTemplateSequencePermission(input: TemplateSequencePermission): Promise<void> {
    const permission = templateSequencePermissionSchema.parse(input);
    const proof = await this.businessEmailProof(permission.accountId, { kind: 'account_claim', claimIndex: permission.claimIndex,
      accountVersion: permission.accountVersion, email: permission.recipient });
    if (proof.claimFingerprint !== permission.claimFingerprint || proof.sourceId !== permission.sourceId
      || proof.sourceSha256 !== permission.sourceSha256) throw new Error('no_business_email');
    if (permission.recordedAt > this.store.now() || permission.expiresAt <= this.store.now()
      || permission.recordedAt > permission.expiresAt) throw new Error('permission_not_current');
    await this.immutable(templateSequencePermissionKey(permission.accountId, permission.id), permission,
      [this.store.check(proof.key, proof.rev), this.store.absent(mailSuppressionKey(permission.accountId))]);
  }
  async revokeApproval(approvalId: string): Promise<void> { await this.immutable(revokedKey(dispatchApprovalKey(approvalId)), { revokedAt: this.store.now() }); }
  async revokeTemplateSequencePermission(accountId: string, permissionId: string): Promise<void> {
    await this.immutable(revokedKey(templateSequencePermissionKey(accountId, permissionId)), { revokedAt: this.store.now() });
  }
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
      || intent.action.targetHash !== targetHash(intent.frozenMessage)) throw new Error('dispatch_identity_conflict');
    return intent;
  }
  async outcomePlan(outcome: AppendOutcomeInput, raw: SendEvidence, terminalState?: 'cancelled' | 'provider_accepted'): Promise<{ items: TransactWriteItem[]; campaign?: CampaignEventPayload }> {
    const evidence = sendEvidenceSchema.parse(raw); const intent = await this.loadIntent(evidence.commandId);
    if (evidence.state === 'cancelled' && (evidence.kind !== 'provider_result' || evidence.reason !== 'provider_not_sent' || evidence.providerIdentity !== null)) throw new Error('send_evidence_conflict');
    if (!intent || fingerprint(evidence.reservation) !== fingerprint(outcome.reservation) || evidence.state !== outcome.state
      || evidence.observedAt !== outcome.observedAt || evidence.rfcMessageId !== `<${intent.commandId}@callie.invalid>`
      || intent.action.actionId !== outcome.reservation.actionId || intent.action.accountId !== outcome.reservation.accountId
      || intent.action.contentHash !== outcome.reservation.contentHash || intent.action.targetHash !== outcome.reservation.targetHash
      || intent.action.expectedAuthorityGeneration !== outcome.reservation.authorityGeneration
      || (evidence.state === 'provider_accepted') !== (evidence.providerIdentity !== null)) throw new Error('send_evidence_conflict');
    const flightKey = dispatchAccountKey(intent.action.accountId); const flightRow = await this.required(flightKey);
    const flight = flightSchema.parse(flightRow.data);
    if (terminalState && (terminalState === evidence.state || !['provider_accepted', 'cancelled'].includes(evidence.state)
      || evidence.state === 'provider_accepted' && !(evidence.kind === 'provider_result' && evidence.reason === 'provider_accepted'
        || evidence.kind === 'sent_lookup' && evidence.reason === 'sent_match' && (threadedDispatchIntent(intent) ? evidence.providerIdentity?.threadId === intent.frozenMessage.threadId : evidence.providerIdentity?.threadId != null)))) throw new Error('send_evidence_conflict');
    if (!terminalState && (flight.commandId !== intent.commandId || flight.accountId !== intent.action.accountId || flight.actionId !== intent.action.actionId
      || !['dispatching', 'unknown'].includes(flight.state))) throw new Error('account_dispatch_conflict');
    const items = [this.store.put(`DISPATCH_EVIDENCE#${keyPart(intent.commandId)}#${fingerprint(evidence)}`, evidence, null),
      terminalState ? this.store.check(flightKey, flightRow.rev) : this.store.put(flightKey, { ...flight, state: evidence.state }, flightRow.rev)];
    if (terminalState) {
      // The original terminal fact must already be immutable and bound to this reservation.
      const original = (await this.store.list<unknown>(`DISPATCH_EVIDENCE#${keyPart(intent.commandId)}#`)).find(row => {
        const parsed = sendEvidenceSchema.parse(row.stored.data);
        return parsed.state === terminalState && fingerprint(parsed.reservation) === fingerprint(evidence.reservation);
      });
      if (!original) throw new Error('terminal_evidence_missing');
      items.push(this.store.check(original.key, original.stored.rev));
      const holdKey = dispatchConflictKey(intent.action.accountId); const hold = await this.store.get<unknown>(holdKey);
      if (hold && conflictSchema.parse(hold.data).accountId !== intent.action.accountId) throw new Error('dispatch_identity_conflict');
      items.push(hold ? this.store.check(holdKey, hold.rev) : this.store.put(holdKey, conflictSchema.parse({ accountId: intent.action.accountId,
        actionId: intent.action.actionId, commandId: intent.commandId, evidenceRef: outcome.evidenceRef, observedAt: evidence.observedAt }), null));
    }
    if (intent.kind !== 'campaign_step') return { items };
    if (!this.campaignExecution) throw new Error('campaign_binding_unavailable');
    const hash = fingerprint(evidence);
    const commandId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const campaign = await this.campaignExecution.repository.prepareOutcomePlan({ commandId, accountId: intent.action.accountId,
      actionId: intent.action.actionId, state: evidence.state, observedAt: evidence.observedAt,
      ...(evidence.state === 'cancelled' ? { cancellationEvidence: { kind: 'provider_result' as const, reason: 'provider_not_sent' as const, providerIdentity: null, evidenceRef: `send-${hash}` } } : {}) });
    if (terminalState && campaign.payload.evidence?.conflict !== 'contradictory_finalized_outcome') throw new Error('campaign_conflict_missing');
    return { items: mergeDispatchConditions([...items, ...campaign.items]), campaign: campaign.payload };
  }
  private requestedArtifacts(loaded: LoadedRequestedApproval, draft: RequestedFollowupDraft, origin: RequestedFollowupCampaignOrigin) {
    const { record, command } = loaded; const snapshot = record.draftSnapshot;
    const content = (value: RequestedFollowupDraft) => ({ ...value, mailContext: null as null, contextRevision: '' });
    if (fingerprint(content(draft)) !== fingerprint(content(snapshot)) || draft.mailContext.inboundContextFingerprint !== record.baselineMailContext.inboundContextFingerprint
      || draft.contextRevision !== requestedFollowupContextRevision(draft)) throw new Error('requested_evidence_changed');
    if (fingerprint(draft.mailContext) !== fingerprint(snapshot.mailContext)) {
      const scope = record.scopePlan?.desiredScope;
      if (!scope || record.scopePlan!.previousScopeFingerprint !== snapshot.mailContext.scopeFingerprint
        || draft.mailContext.scopeFingerprint !== mailScopeFingerprint(scope) || draft.mailContext.scopeRevision !== scope.revision
        || draft.mailContext.inboundContextRevision !== (snapshot.mailContext.inboundContextRevision ?? 0) + 1) throw new Error('requested_evidence_changed');
    }
    const frozenMessage = frozenFirstEmailSchema.parse({ commandId: command.payload.intentCommandId, from: draft.sender, to: draft.recipient, subject: draft.subject, body: draft.body });
    const intent = phoneRequestedFollowupIntentSchema.parse({ kind: 'phone_requested_followup', commandId: frozenMessage.commandId, requestedApprovalCommandId: command.commandId,
      pairingId: record.pairingId, mailboxSubject: record.mailboxSubject, draftId: draft.id, draftRevision: draft.revision, frozenMessage,
      action: { actionId: command.payload.actionId, workspaceId: command.workspaceId, accountId: record.accountId, expectedAuthorityGeneration: record.authorityGeneration,
        approvalId: command.payload.approvalId, contentHash: fingerprint(frozenMessage), targetHash: targetHash(frozenMessage) } });
    const permission = phoneRequestPermissionSchema.parse({ basis: 'phone_request', id: `phone-request-${record.commandId}`, accountId: record.accountId, recipient: draft.recipient,
      sender: draft.sender, mailboxSubject: draft.mailboxSubject, originalCall: draft.originalCall, recipientBinding: draft.recipientBinding, accountVersion: draft.accountVersion,
      researchRevision: draft.researchRevision, contextRevision: draft.contextRevision, attestationCommandId: record.commandId, attestationHash: record.requestSnapshot.attestationHash,
      recordedAt: record.requestSnapshot.recordedAt, expiresAt: record.expiresAt, campaignOrigin: origin });
    const approval = requestedDispatchApprovalSchema.parse({ kind: 'phone_requested_followup', id: command.payload.approvalId, commandId: intent.commandId,
      requestedApprovalCommandId: record.commandId, intentHash: fingerprint(intent), draft, permission, approvedAt: permission.recordedAt, expiresAt: record.expiresAt });
    return { intent, permission, approval };
  }
  private withoutRequestedAuthority(checks: TransactWriteItem[], authority: RequestedFollowupPlan['authority']) {
    const expected = this.store.check(authority.key, authority.rev, executionAuthorityFields(authority.data)); let count = 0;
    const result = checks.filter(item => {
      if (item.ConditionCheck?.Key?.sk?.S !== authority.key) return true;
      if (fingerprint(item) !== fingerprint(expected)) throw new Error('requested_authority_changed');
      count++; return false;
    });
    if (count !== 1) throw new Error('requested_authority_changed');
    return result;
  }
  private async requestedLiveChecks(record: RequestedApprovalRecord, plan: RequestedFollowupPlan) {
    const authority = plan.authority.data;
    if (authority.authority.accountId !== record.accountId || authority.authority.generation !== record.authorityGeneration) throw new Error('requested_authority_changed');
    if (authority.authority.state === 'revoked') throw new Error('requested_revoked');
    if (authority.authority.state === 'paused') throw new Error('requested_authority_paused');
    if (authority.authority.owner !== 'worker' || authority.authority.state !== 'active') throw new Error('requested_authority_changed');
    if (this.store.now() >= record.expiresAt) throw new Error('requested_expired');
    const sourceKey = ownerSourceKey(record.accountId); const sourceRow = await this.required(sourceKey); const source = ownerSourceConfigurationSchema.parse(sourceRow.data);
    if (source.workspaceId !== this.store.options.workspaceId || source.accountId !== record.accountId || source.pairingId !== record.pairingId || source.mailboxSubject !== record.mailboxSubject) throw new Error('requested_authority_changed');
    if (source.state !== 'active') throw new Error('requested_authority_paused');
    const pair = await this.authorization.input.auth.activePairing(record.pairingId);
    if (this.authorization.input.auth.options.workspaceId !== this.store.options.workspaceId || this.authorization.input.auth.options.tableName !== this.store.options.tableName
      || pair.data.generation !== record.requestSnapshot.principal.generation) throw new Error('requested_authority_changed');
    const checks = [this.store.check(sourceKey, sourceRow.rev), this.store.check(pairingKey(record.pairingId), pair.rev)];
    for (const key of [dispatchConflictKey(record.accountId), mailSuppressionKey(record.accountId), revokedKey(requestedApprovalKey(record.commandId))]) {
      if (await this.store.get(key)) throw new Error('requested_revoked'); checks.push(this.store.absent(key));
    }
    if (plan.mailContext.scopeRevision === null || plan.mailContext.scopeFingerprint === null || plan.mailContext.inboundContextRevision === null
      || !plan.cursor?.data.scope || plan.cursor.data.inboundContextFingerprint !== plan.mailContext.inboundContextFingerprint) throw new Error('requested_preflight_incomplete');
    const intake = await createIntakeBarrier(this.store).check({ accountId: record.accountId, mailboxSubject: record.mailboxSubject, requiredRecipient: plan.draft.recipient }, new AbortController().signal);
    if (intake.status !== 'ready') throw new Error('requested_preflight_incomplete');
    return { checks: [...checks, ...intake.checks], validUntil: Math.min(intake.validUntil, Date.parse(record.expiresAt)) };
  }
  /** One transaction plan, never sequential permission/approval/action writers. */
  async planRequestedAdmission(commandId: string) {
    const loaded = await loadRequestedApproval(this.store, commandId); if (!loaded) throw new Error('requested_capture_missing');
    const { record } = loaded;
    if (record.state === 'materialized') throw new Error('requested_already_materialized');
    if (record.state !== 'pending_preflight') throw new Error('requested_submission_inactive');
    const drafts = new DynamoRequestedFollowupRepository(this.store.options);
    const context = await drafts.readContext({ accountId: record.accountId, originalCall: record.originalCall, recipientBinding: record.draftSnapshot.recipientBinding, expectedAccountVersion: record.draftSnapshot.accountVersion, mode: 'manual' });
    const candidate = { ...record.draftSnapshot, mailContext: context.mailContext };
    candidate.contextRevision = requestedFollowupContextRevision(candidate);
    const plan = await drafts.planCurrent(candidate); const live = await this.requestedLiveChecks(record, plan);
    if (!this.campaignExecution) throw new Error('campaign_binding_unavailable');
    const campaign = await this.campaignExecution.repository.prepareRequestedFollowupPlan({ commandId, accountId: record.accountId, originalActionId: record.originalCall.actionId, originalOutcomeCommandId: record.originalCall.commandId });
    // Only these two D1 state writes may replace C3 preparation checks. The
    // write must enforce the entire identical prior-image predicate, not just key/rev.
    const replaceable = new Set([campaignEnrollmentKey(campaign.origin.enrollmentId), campaignSlotKey(record.accountId)]);
    const replaced = new Set<TransactWriteItem>();
    for (const item of campaign.items) {
      const put = item.Put; if (!put) continue;
      const key = put.Item?.sk?.S;
      if (!key || !replaceable.has(key)) throw new Error('requested_campaign_condition_conflict');
      const matching = plan.checks.filter(check => check.ConditionCheck?.Key?.sk?.S === key);
      const prior = matching[0]?.ConditionCheck;
      const revision = Number(prior?.ExpressionAttributeValues?.[':rev']?.N);
      const required = { TableName: put.TableName, Key: { pk: put.Item?.pk, sk: put.Item?.sk }, ConditionExpression: put.ConditionExpression,
        ExpressionAttributeNames: put.ExpressionAttributeNames, ExpressionAttributeValues: put.ExpressionAttributeValues };
      if (matching.length !== 1 || !prior || !Number.isSafeInteger(revision) || !Number.isSafeInteger(revision + 1) || revision < 1
        || put.TableName !== this.store.options.tableName || fingerprint(required.Key) !== fingerprint(this.store.key(key))
        || put.Item?.workspaceId?.S !== this.store.options.workspaceId || prior.ExpressionAttributeValues?.[':workspace']?.S !== this.store.options.workspaceId
        || put.Item?.rev?.N !== String(revision + 1) || fingerprint(prior) !== fingerprint(required)) throw new Error('requested_campaign_condition_conflict');
      replaced.add(matching[0]!);
    }
    const preparationChecks = plan.checks.filter(item => !replaced.has(item));
    const artifacts = this.requestedArtifacts(loaded, candidate, campaign.origin);
    const dKey = requestedFollowupDraftKey(record.accountId, record.draftSnapshot.id); const draftRow = await this.required(dKey);
    if (fingerprint(requestedFollowupDraftSchema.parse(draftRow.data)) !== fingerprint(record.draftSnapshot)) throw new Error('requested_evidence_changed');
    const flightKey = dispatchAccountKey(record.accountId); const flight = await this.store.get<unknown>(flightKey);
    if (flight && ['dispatching', 'unknown'].includes(flightSchema.parse(flight.data).state)) throw new Error('account_dispatch_unresolved');
    const entries = [[dispatchPermissionKey(record.accountId, artifacts.permission.id), artifacts.permission], [dispatchApprovalKey(artifacts.approval.id), artifacts.approval],
      [dispatchIntentKey(artifacts.intent.commandId), artifacts.intent], [actionIndexKey(record.accountId, artifacts.intent.action.actionId), { commandId: artifacts.intent.commandId }]] as const;
    const items = [...loaded.checks.filter(item => item.ConditionCheck?.Key?.sk?.S !== requestedApprovalKey(commandId)), ...this.withoutRequestedAuthority(preparationChecks, plan.authority),
      ...live.checks, ...campaign.items, this.store.check(dKey, draftRow.rev), flight ? this.store.check(flightKey, flight.rev) : this.store.absent(flightKey)];
    for (const [key, value] of entries) {
      if (await this.store.get(revokedKey(key))) throw new Error('requested_revoked');
      items.push(this.store.absent(revokedKey(key)), this.store.put(key, value, null));
    }
    items.push(this.store.put(requestedApprovalKey(commandId), requestedApprovalRecordSchema.parse({ ...record, state: 'materialized', materializedIntentId: artifacts.intent.commandId, lastReason: null }), loaded.revision));
    return { items: mergeDispatchConditions(items), intent: artifacts.intent, preparedInput: { ...artifacts.intent.action, expectedVersion: plan.authority.data.version },
      authority: plan.authority, validUntil: live.validUntil, campaign: campaign.payload };
  }
  private async requestedMaterialization(commandId: string) {
    const loaded = await loadRequestedApproval(this.store, commandId); if (!loaded || loaded.record.state !== 'materialized') throw new Error('requested_submission_inactive');
    const aKey = dispatchApprovalKey(loaded.command.payload.approvalId); const approvalRow = await this.required(aKey); const approval = requestedDispatchApprovalSchema.parse(approvalRow.data);
    const expected = this.requestedArtifacts(loaded, approval.draft, approval.permission.campaignOrigin);
    const iKey = dispatchIntentKey(expected.intent.commandId); const pKey = dispatchPermissionKey(loaded.record.accountId, expected.permission.id);
    const intentRow = await this.required(iKey); const permissionRow = await this.required(pKey);
    if (fingerprint(approval) !== fingerprint(expected.approval) || fingerprint(intentRow.data) !== fingerprint(expected.intent) || fingerprint(permissionRow.data) !== fingerprint(expected.permission)) throw new Error('requested_evidence_changed');
    return { ...expected, loaded, checks: [...loaded.checks, this.store.check(aKey, approvalRow.rev), this.store.check(iKey, intentRow.rev), this.store.check(pKey, permissionRow.rev)] };
  }
  /** Immutable admission proof only, never current eligibility to reserve a new send. */
  async loadRequestedMaterializedIntent(commandId: string): Promise<PhoneRequestedFollowupIntent> { return (await this.requestedMaterialization(commandId)).intent; }
  private async requestedReservationPlan(input: ReserveDispatchInput, intent: PhoneRequestedFollowupIntent, evidence: GoogleAccessEvidence | undefined, checks: TransactWriteItem[]) {
    const materialized = await this.requestedMaterialization(intent.requestedApprovalCommandId);
    if (fingerprint(materialized.intent) !== fingerprint(intent)) throw new Error('requested_evidence_changed');
    // Mutable draft eligibility belongs only to a NEW reservation. Historical
    // lookup/association must retain the exact originally approved identity.
    const dKey = requestedFollowupDraftKey(materialized.loaded.record.accountId, materialized.loaded.record.draftSnapshot.id);
    const draftRow = await this.required(dKey);
    if (fingerprint(draftRow.data) !== fingerprint(materialized.loaded.record.draftSnapshot)) throw new Error('requested_evidence_changed');
    checks.push(this.store.check(dKey, draftRow.rev));
    const plan = await new DynamoRequestedFollowupRepository(this.store.options).planCurrent(materialized.approval.draft);
    if (plan.authority.data.version !== input.expectedVersion) throw new Error('stale_authority');
    const live = await this.requestedLiveChecks(materialized.loaded.record, plan);
    if (!this.campaignExecution) throw new Error('campaign_binding_unavailable');
    const campaign = await this.campaignExecution.repository.requestedFollowupChecks({ accountId: intent.action.accountId, originalActionId: materialized.permission.originalCall.actionId, originalOutcomeCommandId: materialized.permission.originalCall.commandId });
    if (fingerprint(campaign.origin) !== fingerprint(materialized.permission.campaignOrigin)) throw new Error('requested_evidence_changed');
    checks.push(...materialized.checks, ...this.withoutRequestedAuthority(plan.checks, plan.authority), ...live.checks, ...campaign.items);
    for (const key of [dispatchIntentKey(intent.commandId), dispatchApprovalKey(intent.action.approvalId), dispatchPermissionKey(intent.action.accountId, materialized.permission.id)]) {
      if (await this.store.get(revokedKey(key))) throw new Error('requested_revoked'); checks.push(this.store.absent(revokedKey(key)));
    }
    return this.finishReservationPlan(input, intent, evidence, checks, Date.parse(materialized.permission.recordedAt), live.validUntil);
  }
  /** Read-only linkage from an actual accepted first email to actual retained inbound evidence.
   * This creates neither a provider thread nor permission to answer it. */
  async requestedReplyAssociation(commandId: string, threadId: string) {
    const intent = await this.loadIntent(commandId); if (intent?.kind !== 'phone_requested_followup') return null;
    const holdKey = dispatchConflictKey(intent.action.accountId); if (await this.store.get(holdKey)) return null;
    const materialized = await this.requestedMaterialization(intent.requestedApprovalCommandId);
    if (fingerprint(materialized.intent) !== fingerprint(intent)) return null;
    const actionKey = `ACTION#${keyPart(intent.action.accountId)}#${keyPart(intent.action.actionId)}`;
    const actionRow = await this.store.get<unknown>(actionKey);
    const action = z.object({ input: reserveDispatchInputSchema.omit({ expectedVersion: true }), state: z.string(), reservation: reservationSchema.optional() }).safeParse(actionRow?.data);
    if (!action.success || action.data.state !== 'provider_accepted' || !action.data.reservation || fingerprint(action.data.input) !== fingerprint(intent.action)) return null;
    const reservation = action.data.reservation;
    if (reservation.workspaceId !== intent.action.workspaceId || reservation.accountId !== intent.action.accountId || reservation.actionId !== intent.action.actionId
      || reservation.authorityGeneration !== intent.action.expectedAuthorityGeneration || reservation.contentHash !== intent.action.contentHash || reservation.targetHash !== intent.action.targetHash) return null;
    const evidenceRows = await this.store.list<unknown>(`DISPATCH_EVIDENCE#${keyPart(commandId)}#`);
    const accepted = evidenceRows.flatMap(row => { const parsed = sendEvidenceSchema.safeParse(row.stored.data);
      if (!parsed.success) return []; const evidence = parsed.data;
      return evidence.commandId === commandId && evidence.state === 'provider_accepted' && evidence.providerIdentity?.threadId === threadId
        && evidence.rfcMessageId === `<${commandId}@callie.invalid>` && fingerprint(evidence.reservation) === fingerprint(reservation)
        && (evidence.kind === 'provider_result' && evidence.reason === 'provider_accepted' || evidence.kind === 'sent_lookup' && evidence.reason === 'sent_match')
        ? [{ row, evidence, provider: evidence.providerIdentity }] : []; });
    if (!accepted.length || new Set(accepted.map(item => fingerprint(item.provider))).size !== 1) return null;
    const threadKey = mailThreadKey(intent.action.accountId, threadId); const threadRow = await this.store.get<unknown>(threadKey);
    const projection = threadProjectionSchema.safeParse(threadRow?.data); if (!projection.success) return null;
    const thread = projection.data.thread;
    if (thread.accountId !== intent.action.accountId || thread.mailboxSubject !== intent.mailboxSubject || thread.providerThreadId !== threadId) return null;
    // Acceptance observation may follow the reply after a lost send response.
    // Bind to the original provider/RFC identity, not later reconciliation time.
    const matches = thread.messages.filter(message => message.from.length === 1 && message.from[0] === intent.frozenMessage.to
      && message.to.length === 1 && message.to[0] === intent.frozenMessage.from && message.cc.length === 0
      && message.references.includes(`<${commandId}@callie.invalid>`));
    if (!matches.length) return null;
    return { commandId, providerMessageId: accepted[0]!.provider!.messageId, threadId, inboundMessageId: matches[0]!.id,
      checks: mergeDispatchConditions([...materialized.checks, this.store.absent(holdKey), this.store.check(actionKey, actionRow!.rev),
        this.store.check(threadKey, threadRow!.rev), ...accepted.map(item => this.store.check(item.row.key, item.row.stored.rev))]) };
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
    const holdKey = dispatchConflictKey(parsed.accountId);
    if (await this.store.get(holdKey)) throw new Error('dispatch_conflict_hold');
    const indexKey = actionIndexKey(parsed.accountId, parsed.actionId); const index = await this.required(indexKey);
    const commandId = z.strictObject({ commandId: z.uuid() }).parse(index.data).commandId;
    const key = dispatchIntentKey(commandId); const row = await this.required(key); const intent = dispatchIntentSchema.parse(row.data);
    const identity = { actionId: parsed.actionId, workspaceId: parsed.workspaceId, accountId: parsed.accountId,
      expectedAuthorityGeneration: parsed.expectedAuthorityGeneration, approvalId: parsed.approvalId, contentHash: parsed.contentHash, targetHash: parsed.targetHash };
    if (intent.commandId !== commandId || fingerprint(identity) !== fingerprint(intent.action)) throw new Error('dispatch_identity_conflict');
    if (intent.kind === 'phone_requested_followup') return this.requestedReservationPlan(parsed, intent, evidence, [this.store.absent(holdKey), this.store.check(indexKey, index.rev), this.store.check(key, row.rev)]);
    if (intent.kind === 'template_sequence_email') return this.templateSequenceReservationPlan(parsed, intent, evidence, [this.store.absent(holdKey), this.store.check(indexKey, index.rev), this.store.check(key, row.rev)]);
    if (intent.kind === 'campaign_step' && (!this.campaignExecution || intent.binding.kind !== 'account_route')) throw new Error('campaign_binding_unavailable');
    const sourceKey = ownerSourceKey(parsed.accountId); const sourceRow = await this.store.get<unknown>(sourceKey);
    const configuration = ownerSourceConfigurationSchema.safeParse(sourceRow?.data);
    if (!sourceRow || !configuration.success || configuration.data.state !== 'active' || configuration.data.workspaceId !== parsed.workspaceId
      || configuration.data.accountId !== parsed.accountId || configuration.data.pairingId !== intent.pairingId
      || configuration.data.mailboxSubject !== intent.mailboxSubject) throw new Error('source_configuration_unavailable');
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
    const checks = [this.store.absent(holdKey), this.store.check(sourceKey, sourceRow.rev), this.store.check(indexKey, index.rev), this.store.check(key, row.rev), this.store.check(approvalKey, approvalRow.rev),
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
    return this.finishReservationPlan(parsed, intent, evidence, checks, Math.max(Date.parse(approval.approvedAt), Date.parse(permission.recordedAt)),
      Math.min(Date.parse(approval.expiresAt), Date.parse(permission.expiresAt)), campaign);
  }
  /**
   * One cold sequence email, re-checked against everything it was admitted on. The refusals are lane 31's own closed
   * hold reasons wherever one applies, so the founder reads the same words here as on the send decision that produced
   * this intent: `template_not_approved` when the standing approval no longer names this revision and hash (an edit
   * revokes it, and a pause holds it), `no_business_email` when the claim no longer names this recipient, and
   * `dispatch_cap_reached` from the shared sender cap and ramp below. The approved text is never re-read here: the
   * hash is what proves the frozen message came from text David approved, and the action's content hash freezes that
   * message. Nothing about a thread is required or implied — this firm has never written to us.
   */
  private async templateSequenceReservationPlan(parsed: ReserveDispatchInput, intent: TemplateSequenceEmailIntent, evidence: GoogleAccessEvidence | undefined, checks: TransactWriteItem[]) {
    const sourceKey = ownerSourceKey(parsed.accountId); const sourceRow = await this.store.get<unknown>(sourceKey);
    const configuration = ownerSourceConfigurationSchema.safeParse(sourceRow?.data);
    if (!sourceRow || !configuration.success || configuration.data.state !== 'active' || configuration.data.workspaceId !== parsed.workspaceId
      || configuration.data.accountId !== parsed.accountId || configuration.data.pairingId !== intent.pairingId
      || configuration.data.mailboxSubject !== intent.mailboxSubject) throw new Error('source_configuration_unavailable');
    // The standing approval as the worker holds it now, not as it stood when the step was planned.
    const stateKey = replyTemplateStateKey(parsed.workspaceId); const stateRow = await this.store.get<unknown>(stateKey);
    const state = stateRow ? workerReplyTemplateStateSchema.safeParse(stateRow.data) : null;
    const approval = state?.success ? state.data.approvals.find(entry => entry.templateId === intent.template.templateId) : undefined;
    if (!stateRow || !state?.success || state.data.paused || !approval || approval.revision !== intent.template.revision
      || approval.contentHash !== intent.template.contentHash) throw new Error('template_not_approved');
    const proof = await this.businessEmailProof(parsed.accountId, intent.binding);
    if (intent.frozenMessage.to !== intent.binding.email) throw new Error('no_business_email');
    const permissionKey = templateSequencePermissionKey(parsed.accountId, parsed.approvalId);
    const permissionRow = await this.required(permissionKey);
    const permission = templateSequencePermissionSchema.parse(permissionRow.data);
    if (permission.id !== parsed.approvalId || permission.accountId !== parsed.accountId || permission.recipient !== intent.frozenMessage.to
      || permission.sender !== intent.frozenMessage.from || permission.mailboxSubject !== intent.mailboxSubject
      || permission.accountVersion !== intent.binding.accountVersion || permission.claimIndex !== intent.binding.claimIndex
      || permission.claimFingerprint !== proof.claimFingerprint || permission.sourceId !== proof.sourceId
      || permission.sourceSha256 !== proof.sourceSha256) throw new Error('no_business_email');
    checks.push(this.store.check(sourceKey, sourceRow.rev), this.store.check(stateKey, stateRow.rev),
      this.store.check(proof.key, proof.rev), this.store.check(permissionKey, permissionRow.rev));
    for (const absent of [revokedKey(dispatchIntentKey(intent.commandId)), revokedKey(permissionKey), mailSuppressionKey(parsed.accountId)]) {
      if (await this.store.get(absent)) throw new Error('dispatch_suppressed');
      checks.push(this.store.absent(absent));
    }
    return this.finishReservationPlan(parsed, intent, evidence, checks, Date.parse(permission.recordedAt), Date.parse(permission.expiresAt));
  }
  /** Shared final flight, intake, sender cap and C2 grant conditions for every email kind. */
  private async finishReservationPlan(parsed: ReserveDispatchInput, intent: DispatchIntent, evidence: GoogleAccessEvidence | undefined, checks: TransactWriteItem[], validFrom: number, validUntil: number, campaign: CampaignExecutionPlan | null = null): Promise<DispatchReservationPlan> {
    const message = intent.frozenMessage; const commandId = intent.commandId;
    const flightKey = dispatchAccountKey(parsed.accountId); const flightRow = await this.store.get<unknown>(flightKey);
    if (flightRow) {
      const flight = flightSchema.parse(flightRow.data);
      if (flight.accountId !== parsed.accountId || ['dispatching', 'unknown'].includes(flight.state)) throw new Error('account_dispatch_unresolved');
    }
    checks.push(this.store.put(flightKey, { accountId: parsed.accountId, commandId, actionId: parsed.actionId, state: 'dispatching' }, flightRow?.rev ?? null));
    const intake = await createIntakeBarrier(this.store).check({ accountId: parsed.accountId, mailboxSubject: intent.mailboxSubject, requiredRecipient: message.to,
      ...(threadedDispatchIntent(intent) ? { requiredThreadId: intent.frozenMessage.threadId } : {}) }, new AbortController().signal);
    if (intake.status !== 'ready') throw new Error(intake.reason);
    checks.push(...intake.checks);
    const policyKey = dispatchCapPolicyKey(message.from); const policyRow = await this.required(policyKey); const policy = capPolicySchema.parse(policyRow.data);
    const day = this.store.now().slice(0, 10); const capKey = dispatchCapUsageKey(message.from, day);
    const capRow = await this.store.get<unknown>(capKey); const cap = capRow ? capSchema.parse(capRow.data) : { sender: message.from, day, used: 0 };
    // The warm-up ramp is anchored on the first cap this sender ever consumed. The anchor is
    // written once, inside this same final transaction, and fenced on every later reservation
    // so a concurrent reservation cannot move it and widen today's cap.
    const anchorKey = senderFirstSendKey(message.from); const anchorRow = await this.store.get<unknown>(anchorKey);
    const anchor = anchorRow ? senderFirstSendSchema.parse(anchorRow.data) : { sender: message.from, firstSendAt: this.store.now() };
    if (anchor.sender !== message.from) throw new Error('dispatch_cap_reached');
    const senderCap = senderCapForDay(policy, anchorRow ? anchor.firstSendAt : null, this.store.now());
    if (policy.sender !== message.from || cap.sender !== message.from || cap.day !== day || cap.used >= senderCap.today) throw new Error('dispatch_cap_reached');
    checks.push(this.store.check(policyKey, policyRow.rev), this.store.put(capKey, { ...cap, used: cap.used + 1 }, capRow?.rev ?? null),
      anchorRow ? this.store.check(anchorKey, anchorRow.rev) : this.store.put(anchorKey, anchor, null));
    const start = validFrom; const end = Math.min(validUntil, intake.validUntil);
    const finalize = () => {
      const now = Date.parse(this.store.now());
      if (now < start || now >= end || this.store.now().slice(0, 10) !== day) throw new Error('dispatch_evidence_expired');
      if (!evidence) throw new Error('google_access_evidence_missing');
      return mergeDispatchConditions([...checks, ...(campaign?.finalize() ?? []), ...this.authorization.accessChecks(evidence, { pairingId: intent.pairingId, subject: intent.mailboxSubject, requiredCapabilities: ['send', 'relevant_read'] })]);
    };
    finalize();
    return { finalize, ...(campaign ? { campaign: { commandId: intent.commandId, version: null, enrollment: null, evidence: null, cap: campaign.cap } } : {}) };
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
