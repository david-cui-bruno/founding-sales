import { z } from 'zod';
import { accountIdSchema as id, accountInstantSchema as instant } from '../../../../src/shared/contracts/accountContract';
import { requestedFollowupDraftSchema, requestedMailContextSchema, originalCallRefSchema, requestedApprovalStatusSchema } from '../../../../src/shared/contracts/requestedFollowupContract';
import { mailAccountScopeSchema } from '../../../../src/shared/contracts/mailThreadContract';
import { approveRequestedFollowupCommandSchema } from '../../../../src/shared/contracts/ownerCommandContract';
import { commandReceiptSchema, workerEventSchema } from '../../../../src/shared/contracts/delegationContract';
import { DynamoStore, fingerprint, keyPart, integer } from './dynamoStore';
import type { WorkerPrincipal } from './workerAuth';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const requestedApprovalKey = (commandId: string) => `REQUESTED_APPROVAL#${keyPart(commandId)}`;
export const requestedApprovalCommandSchema = approveRequestedFollowupCommandSchema;
export type RequestedApprovalCommand = z.infer<typeof requestedApprovalCommandSchema>;
const principalSchema = z.strictObject({ pairingId: z.uuid(), credentialHash: hash, generation: integer });
const requestSnapshotSchema = z.strictObject({ statement: z.literal('recipient_requested_information_by_email'), recipient: z.email(), attestationCommandId: z.uuid(),
  principal: principalSchema, recordedAt: instant, attestationHash: hash });
export const requestedApprovalRecordSchema = z.strictObject({ commandId: z.uuid(), commandFingerprint: hash, accountId: id, pairingId: z.uuid(), mailboxSubject: id,
  authorityGeneration: integer, draftSnapshot: requestedFollowupDraftSchema, requestSnapshot: requestSnapshotSchema, originalCall: originalCallRefSchema,
  baselineMailContext: requestedMailContextSchema, expiresAt: instant, state: z.enum(['pending_preflight', 'materialized', 'needs_review', 'expired', 'revoked']),
  scopePlan: z.strictObject({ expectedEnvelopeRevision: integer.positive().nullable(), previousScopeFingerprint: hash.nullable(), desiredScope: mailAccountScopeSchema }).nullable(),
  lastReason: z.string().max(1000).nullable(), materializedIntentId: z.uuid().nullable() }).refine(record => (record.state === 'materialized') === (record.materializedIntentId !== null));
export type RequestedApprovalRecord = z.infer<typeof requestedApprovalRecordSchema>;
/** Pure captured-submission construction for an already authenticated owner.
 * No permission, executable intent, action or external side effect is produced. */
export function createRequestedApprovalRecord(raw: unknown, principal: Pick<WorkerPrincipal, 'pairingId' | 'credentialHash' | 'generation' | 'workspaceId'>, recordedAt: string): RequestedApprovalRecord {
  const command = requestedApprovalCommandSchema.parse(raw); const at = instant.parse(recordedAt);
  const actor = principalSchema.parse({ pairingId: principal.pairingId, credentialHash: principal.credentialHash, generation: principal.generation });
  if (principal.workspaceId !== command.workspaceId || command.payload.draft.accountId !== command.accountId || at >= command.payload.expiresAt || command.payload.draft.updatedAt > at) throw new Error('requested_capture_identity');
  const commandFingerprint = fingerprint(command);
  const attestationHash = fingerprint({ commandId: command.commandId, commandFingerprint, principal: actor, recordedAt: at, request: command.payload.request });
  return requestedApprovalRecordSchema.parse({ commandId: command.commandId, commandFingerprint, accountId: command.accountId, pairingId: actor.pairingId,
    mailboxSubject: command.payload.draft.mailboxSubject, authorityGeneration: command.expectedAuthorityGeneration, draftSnapshot: command.payload.draft,
    requestSnapshot: { ...command.payload.request, attestationCommandId: command.commandId, principal: actor, recordedAt: at, attestationHash }, originalCall: command.payload.draft.originalCall,
    baselineMailContext: command.payload.draft.mailContext, expiresAt: command.payload.expiresAt, state: 'pending_preflight', scopePlan: null, lastReason: null, materializedIntentId: null });
}
/** Load and fence original immutable capture, never resubmit its stale expectedVersion. */
export async function loadRequestedApproval(store: DynamoStore, commandId: string) {
  const key = requestedApprovalKey(commandId); const row = await store.get<unknown>(key); if (!row) return null;
  const record = requestedApprovalRecordSchema.parse(row.data);
  const commandKey = `COMMAND#${keyPart(commandId)}`; const commandRow = await store.get<unknown>(commandKey);
  if (!commandRow) throw new Error('requested_capture_missing');
  const stored = z.strictObject({ fingerprint: hash, command: requestedApprovalCommandSchema, receipt: commandReceiptSchema, sequence: integer.positive() }).parse(commandRow.data);
  const command = stored.command; store.workspace(command.workspaceId);
  const expected = createRequestedApprovalRecord(command, { ...record.requestSnapshot.principal, workspaceId: command.workspaceId }, record.requestSnapshot.recordedAt);
  const immutable = (value: RequestedApprovalRecord) => ({ commandId: value.commandId, commandFingerprint: value.commandFingerprint, accountId: value.accountId, pairingId: value.pairingId, mailboxSubject: value.mailboxSubject, authorityGeneration: value.authorityGeneration, draftSnapshot: value.draftSnapshot, requestSnapshot: value.requestSnapshot, originalCall: value.originalCall, baselineMailContext: value.baselineMailContext, expiresAt: value.expiresAt });
  if (record.commandId !== commandId || stored.fingerprint !== fingerprint(command) || fingerprint(immutable(record)) !== fingerprint(immutable(expected))
    || stored.receipt.commandId !== commandId || stored.receipt.status !== 'applied' || stored.receipt.authorityGeneration !== record.authorityGeneration
    || stored.receipt.aggregateVersion !== command.expectedVersion + 1 || record.materializedIntentId !== null && record.materializedIntentId !== command.payload.intentCommandId) throw new Error('requested_capture_conflict');
  const claimKey = `OWNER_COMMAND_CLAIM#${keyPart(commandId)}`; const claim = await store.get<unknown>(claimKey);
  const captured = z.strictObject({ fingerprint: hash, pairingId: z.uuid(), at: instant }).parse(claim?.data);
  if (captured.fingerprint !== record.commandFingerprint || captured.pairingId !== record.pairingId || captured.at !== record.requestSnapshot.recordedAt) throw new Error('requested_capture_conflict');
  const eventKey = store.eventKey(stored.sequence); const eventRow = await store.get<{ event: unknown }>(eventKey);
  // Canonical parser first: an absent wire extension cannot become a local fallback.
  const event = workerEventSchema.parse(eventRow?.data.event);
  const capture = z.object({ kind: z.literal('requested_followup.status'), workspaceId: id, accountId: id, authorityGeneration: integer, aggregateVersion: integer,
    payload: z.strictObject({ commandId: z.uuid(), draftId: id, status: requestedApprovalStatusSchema }) }).parse(event);
  if (capture.workspaceId !== command.workspaceId || capture.accountId !== command.accountId || capture.authorityGeneration !== record.authorityGeneration
    || capture.aggregateVersion !== stored.receipt.aggregateVersion || capture.payload.commandId !== commandId || capture.payload.draftId !== record.draftSnapshot.id
    || capture.payload.status.state !== 'pending_preflight' || capture.payload.status.intentCommandId !== null || fingerprint(capture.payload.status.receipt) !== fingerprint(stored.receipt)) throw new Error('requested_capture_conflict');
  return { record, revision: row.rev, command, receipt: stored.receipt, checks: [store.check(key, row.rev), store.check(commandKey, commandRow.rev), store.check(claimKey, claim!.rev), store.check(eventKey, eventRow!.rev)] };
}
