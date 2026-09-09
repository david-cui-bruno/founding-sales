import { WorkerCampaignRepository, campaignReservationKey, campaignReservationSchema } from './workerCampaignRepository';
import { z } from 'zod';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { accountRecordSchema } from '../../../../src/shared/contracts/accountRecordContract';
import { ownerSourceConfigurationSchema, ownerSourceKey } from '../../../../src/shared/contracts/ownerCommandContract';
import { commandReceiptSchema, workerEventSchema } from '../../../../src/shared/contracts/delegationContract';
import { prepareRequestedFollowupSchema, requestedFollowupDraftSchema, type PrepareRequestedFollowup, type RequestedFollowupDraft, type SavedRequestedFollowup } from '../../../../src/shared/contracts/requestedFollowupContract';
import { requestedMailContext, validateRequestedOriginalCall, validateRequestedRecipient, validateRequestedDraftContext, validateRequestedDraftRevision, validateRequestedDraftIdentity, type RequestedFollowupContext } from '../../../../src/main/outreach/requestedFollowupService';
import { DynamoStore, fingerprint, integer, keyPart, type RepositoryOptions, type Stored } from './dynamoStore';
import { authorityRecordSchema, executionAuthorityKey, executionAuthorityFields, type AuthorityRecord } from './executionRepository';
import { DynamoThreadIntakeRepository, mailCursorKey, mailSuppressionKey } from './threadIntakeRepository';
import type { MailCursorEnvelope } from '../../../../src/shared/contracts/mailThreadContract';
import { googleGrantSchema } from './googleGrantCapabilities';
export const requestedFollowupDraftKey = (accountId: string, draftId: string) => `MAIL_REQUESTED_DRAFT#${keyPart(accountId)}#${keyPart(draftId)}`;
export type RequestedContextPlan = RequestedFollowupContext & { authority: Stored<AuthorityRecord> & { key: string }; cursor: (Stored<MailCursorEnvelope> & { key: string }) | null; checks: TransactWriteItem[] };
export type RequestedFollowupPlan = RequestedContextPlan & { draft: RequestedFollowupDraft };
const commandRecordSchema = z.strictObject({ fingerprint: z.string(), receipt: commandReceiptSchema, sequence: integer.positive(), command: z.unknown() });
/** Actual SDK persistence. This adapter never grants permission or writes AUTH. */
export class DynamoRequestedFollowupRepository {
  readonly store: DynamoStore;
  readonly intake: DynamoThreadIntakeRepository;
  constructor(options: RepositoryOptions) { this.store = new DynamoStore(options); this.intake = new DynamoThreadIntakeRepository(options); }
  async readContext(raw: PrepareRequestedFollowup): Promise<RequestedContextPlan> {
    const input = prepareRequestedFollowupSchema.parse(raw), accountId = input.accountId;
    const authKey = executionAuthorityKey(accountId), auth = await this.store.get<unknown>(authKey);
    if (!auth) throw new Error('authority_missing');
    const authority = { key: authKey, rev: auth.rev, data: authorityRecordSchema.parse(auth.data) };
    if (authority.data.authority.accountId !== accountId || !((authority.data.authority.owner === 'local' && authority.data.authority.state === 'local')
      || authority.data.authority.owner === 'worker' && ['active', 'paused'].includes(authority.data.authority.state))) throw new Error('requested_wrong_authority');
    const sourceKey = ownerSourceKey(accountId), sourceRow = await this.store.get<unknown>(sourceKey);
    if (!sourceRow) throw new Error('requested_mailbox_missing');
    const source = ownerSourceConfigurationSchema.parse(sourceRow.data);
    if (source.accountId !== accountId || source.workspaceId !== this.store.options.workspaceId || !source.mailboxSubject) throw new Error('requested_mailbox_mismatch');
    const grantKey = `GOOGLE_GRANT#${keyPart(source.pairingId)}`, grantRow = await this.store.get<unknown>(grantKey);
    const grantRecord = z.object({ grant: googleGrantSchema, revoked: z.literal(false) }).parse(grantRow?.data), grant = grantRecord.grant;
    if (grant.subject !== source.mailboxSubject || grant.owner !== 'remote') throw new Error('requested_mailbox_mismatch');
    const cursorRow = await this.intake.cursorState(accountId, source.mailboxSubject);
    const cursor = cursorRow ? { ...cursorRow, key: mailCursorKey(accountId, source.mailboxSubject) } : null;
    const accountKey = `ACCOUNT#${keyPart(accountId)}`, accountRow = await this.store.get<unknown>(accountKey);
    const account = accountRecordSchema.parse(accountRow?.data);
    if (account.account.id !== accountId || account.account.version !== input.expectedAccountVersion) throw new Error('requested_account_stale');
    validateRequestedRecipient(account, input.recipientBinding, input.originalCall);
    const commandKey = `COMMAND#${keyPart(input.originalCall.commandId)}`, commandRow = await this.store.get<unknown>(commandKey);
    const command = commandRecordSchema.parse(commandRow?.data);
    if (command.receipt.status !== 'applied') throw new Error('requested_call_not_applied');
    const eventKey = this.store.eventKey(command.sequence), eventRow = await this.store.get<unknown>(eventKey);
    const outbox = z.strictObject({ sequence: integer.positive(), event: workerEventSchema, published: z.boolean() }).parse(eventRow?.data);
    if (outbox.sequence !== command.sequence || !('receipt' in outbox.event) || fingerprint(outbox.event.receipt) !== fingerprint(command.receipt)) throw new Error('requested_call_receipt_mismatch');
    const handoffKey = `MANUAL_HANDOFF#${keyPart(input.originalCall.handoffId)}`, handoffRow = await this.store.get<unknown>(handoffKey);
    const handoff = z.object({ handoff: z.unknown(), accountId: z.string(), generation: integer, pairingId: z.string() }).parse(handoffRow?.data);
    if (handoff.pairingId !== source.pairingId) throw new Error('requested_call_pairing_mismatch');
    const originalCall = validateRequestedOriginalCall({ workspaceId: this.store.options.workspaceId, accountId, reference: input.originalCall, command: command.command,
      commandFingerprint: command.fingerprint, event: outbox.event, handoff: handoff.handoff, handoffAccountId: handoff.accountId, handoffGeneration: handoff.generation });
    const campaign = await new WorkerCampaignRepository(this.store.options).requestedFollowupPreparationChecks({ accountId, originalActionId: input.originalCall.actionId, originalOutcomeCommandId: input.originalCall.commandId });
    const reservationKey = campaignReservationKey(accountId, input.originalCall.actionId), reservationRow = await this.store.get<unknown>(reservationKey);
    const reservation = campaignReservationSchema.parse(reservationRow?.data), binding = reservation.input, h = originalCall.handoff;
    if (binding.workspaceId !== this.store.options.workspaceId || binding.authorityGeneration !== handoff.generation
      || binding.contentHash !== h.contentHash || binding.targetHash !== h.targetHash || binding.contextRevision !== h.contextRevision
      || binding.selectedRouteId !== h.routeId || reservation.routeVersion !== h.routeVersion
      || fingerprint({ campaignId: binding.campaignId, campaignRevision: binding.campaignRevision, enrollmentId: binding.enrollmentId, enrollmentRevision: binding.enrollmentRevision, stepId: binding.stepId }) !== fingerprint(h.campaign)
      || !campaign.items.some(item => fingerprint(item) === fingerprint(this.store.check(reservationKey, reservationRow!.rev)))) throw new Error('requested_call_reservation_mismatch');
    if (originalCall.event.authorityGeneration > authority.data.authority.generation || originalCall.event.aggregateVersion > authority.data.version) throw new Error('requested_call_future');
    if (await this.intake.isSuppressed(accountId)) throw new Error('requested_suppressed');
    const mailContext = requestedMailContext(cursor?.data ?? null, await this.intake.inboundContext(accountId, source.mailboxSubject));
    const checks = [...campaign.items, this.store.check(authKey, auth.rev, executionAuthorityFields(authority.data)), this.store.check(sourceKey, sourceRow.rev), this.store.check(grantKey, grantRow!.rev),
      cursor ? this.store.check(cursor.key, cursor.rev) : this.store.absent(mailCursorKey(accountId, source.mailboxSubject)), this.store.check(accountKey, accountRow!.rev),
      this.store.check(commandKey, commandRow!.rev), this.store.check(eventKey, eventRow!.rev), this.store.check(handoffKey, handoffRow!.rev), this.store.absent(mailSuppressionKey(accountId))];
    return { authority, cursor, checks, account, originalCall, mailContext, mailbox: { subject: grant.subject, sender: grant.email } };
  }
  async planCurrent(input: RequestedFollowupDraft): Promise<RequestedFollowupPlan> {
    const draft = requestedFollowupDraftSchema.parse(input);
    const plan = await this.readContext({ accountId: draft.accountId, originalCall: draft.originalCall, recipientBinding: draft.recipientBinding, expectedAccountVersion: draft.accountVersion, mode: 'manual' });
    validateRequestedDraftContext(draft, plan); return { ...plan, draft };
  }
  async get(accountId: string, draftId: string): Promise<SavedRequestedFollowup | null> {
    const row = await this.store.get<unknown>(requestedFollowupDraftKey(accountId, draftId)); if (!row) return null;
    const draft = requestedFollowupDraftSchema.parse(row.data);
    if (draft.accountId !== accountId || draft.id !== draftId) throw new Error('requested_draft_identity_conflict');
    let stale = true;
    try { const plan = await this.planCurrent(draft); stale = !plan.cursor?.data.scope || plan.mailContext.inboundContextRevision === null || plan.cursor.data.poll?.status !== 'complete'; } catch { /* Preserve editable content, never invent readiness. */ }
    return { draft, stale, approval: null };
  }
  /** Authenticated owner capture only: preserve real offline edit revision, no
   * synthetic intermediate writes. Caller joins current evidence and COMMAND CAS. */
  async planCaptureDraft(input: RequestedFollowupDraft, expectedRevision: number | null): Promise<TransactWriteItem> {
    const draft = requestedFollowupDraftSchema.parse(input), key = requestedFollowupDraftKey(draft.accountId, draft.id);
    const row = await this.store.get<unknown>(key);
    if (!row) { if (expectedRevision !== null) throw new Error('stale_requested_draft'); return this.store.put(key, draft, null); }
    const previous = requestedFollowupDraftSchema.parse(row.data);
    if (previous.revision !== expectedRevision) throw new Error('stale_requested_draft');
    if (fingerprint(previous) === fingerprint(draft)) return this.store.check(key, row.rev);
    if (draft.revision <= previous.revision) throw new Error('stale_requested_draft');
    validateRequestedDraftIdentity(draft, previous); return this.store.put(key, draft, row.rev);
  }
  async save(input: RequestedFollowupDraft, expectedRevision: number | null): Promise<RequestedFollowupDraft> {
    const draft = requestedFollowupDraftSchema.parse(input), key = requestedFollowupDraftKey(draft.accountId, draft.id);
    const previous = await this.store.get<unknown>(key);
    validateRequestedDraftRevision(draft, previous ? requestedFollowupDraftSchema.parse(previous.data) : null, expectedRevision);
    const plan = await this.planCurrent(draft);
    await this.store.transact([...plan.checks, this.store.put(key, draft, previous?.rev ?? null)]); return draft;
  }
}
