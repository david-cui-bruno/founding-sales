import { accountBootstrapPayloadSchema, ownerCommandSchemas, manualOutcomeSchema, manualHandoffSchema } from './ownerCommandContract';
import { acquisitionMilestonePayloadSchema } from './acquisitionReportContract';
import { campaignEventPayloadSchema } from './campaignContract';
import { meetingOutcomePayloadSchema } from './meetingContract';
import { z } from 'zod';
import { threadObservedPayloadSchema } from './mailThreadContract';
import { accountIdSchema, accountInstantSchema, accountSchema, accountEvidenceBatchSchema } from './accountContract';

const id = accountIdSchema;
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const reason = z.string().trim().min(1).max(2000);
export const actionStateSchema = z.enum(['prepared', 'queued', 'dispatching', 'unknown', 'human_reported_sent', 'provider_accepted', 'cancelled']);
export type ActionState = z.infer<typeof actionStateSchema>;
export const authorityStateSchema = z.strictObject({ accountId: id, owner: z.enum(['local', 'worker']), generation: revision,
  state: z.enum(['local', 'delegating', 'active', 'paused', 'revoked']) });
export type AuthorityState = Readonly<z.infer<typeof authorityStateSchema>>;
export const commandReceiptSchema = z.strictObject({ commandId: id, status: z.enum(['pending', 'applied', 'rejected']),
  authorityGeneration: revision, aggregateVersion: revision, reason: reason.nullable() });
export type CommandReceipt = Readonly<z.infer<typeof commandReceiptSchema>>;
export const approvalSnapshotSchema = z.strictObject({ id, accountId: id, recipient: z.string().min(1).max(2048),
  sender: z.string().min(1).max(2048), footerHash: hash, subjectHash: hash, bodyHash: hash,
  routeId: id, routeVersion: revision.min(1), threadId: id.nullable(), threadRevision: revision,
  contextRevision: id, campaignId: id.nullable(), campaignRevision: revision, permissionEvidenceId: id,
  approvedAt: accountInstantSchema });
export type ApprovalSnapshot = Readonly<z.infer<typeof approvalSnapshotSchema>>;
export { manualOutcomeSchema, type ManualOutcome } from './ownerCommandContract';
const commandBase = { commandId: id, workspaceId: id, accountId: id, expectedAuthorityGeneration: revision, expectedVersion: revision };
/** C3/C4/C5 extend this union explicitly. Arbitrary payloads never execute. */
export const delegationCommandSchema = z.discriminatedUnion('kind', [
  ...ownerCommandSchemas,
  z.strictObject({ ...commandBase, kind: z.literal('delegate'), payload: z.strictObject({ delegationId: id, approvedAt: accountInstantSchema }) }),
  z.strictObject({ ...commandBase, kind: z.literal('pause'), payload: z.strictObject({ reason }) }),
  z.strictObject({ ...commandBase, kind: z.literal('revoke'), payload: z.strictObject({ reason }) }),
  z.strictObject({ ...commandBase, kind: z.literal('manual-outcome'), payload: manualOutcomeSchema }),
]);
export type DelegationCommand = Readonly<z.infer<typeof delegationCommandSchema>>;
const eventBase = { id, workspaceId: id, accountId: id, authorityGeneration: revision, aggregateVersion: revision.min(1) };
export const workerEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({...eventBase,kind:z.literal('account.bootstrap'),payload:accountBootstrapPayloadSchema,receipt:commandReceiptSchema}),
  z.strictObject({ ...eventBase, kind: z.literal('acquisition.milestone_reported'), payload: acquisitionMilestonePayloadSchema, receipt: commandReceiptSchema }),
  z.strictObject({ ...eventBase, kind: z.literal('meeting.outcome'), payload: meetingOutcomePayloadSchema }),
  z.strictObject({ ...eventBase, kind: z.literal('thread.observed'), payload: threadObservedPayloadSchema }),
  z.strictObject({ ...eventBase, kind: z.literal('manual.handoff'), payload: manualHandoffSchema, receipt: commandReceiptSchema, campaign: campaignEventPayloadSchema.optional() }),
  z.strictObject({ ...eventBase, kind: z.literal('campaign.changed'), payload: campaignEventPayloadSchema, receipt: commandReceiptSchema }),
  z.strictObject({ ...eventBase, kind: z.literal('manual.outcome'), payload: manualOutcomeSchema, receipt: commandReceiptSchema, campaign: campaignEventPayloadSchema.optional() }),
  z.strictObject({ ...eventBase, kind: z.literal('authority.changed'), payload: z.strictObject({ authority: authorityStateSchema, receipt: commandReceiptSchema }) }),
  z.strictObject({ ...eventBase, kind: z.literal('action.outcome'), campaign: campaignEventPayloadSchema.optional(), payload: z.strictObject({ actionId: id, state: actionStateSchema,
    contentHash: hash, targetHash: hash, observedAt: accountInstantSchema, evidenceRef: id }) }),
  z.strictObject({ ...eventBase, authorityGeneration: z.literal(0), kind: z.literal('research.created'),
    payload: z.strictObject({ account: accountSchema, createdAt: accountInstantSchema }) }),
  z.strictObject({ ...eventBase, authorityGeneration: z.literal(0), kind: z.literal('research.evidence'),
    payload: z.strictObject({ batch: accountEvidenceBatchSchema, admittedAt: accountInstantSchema }) }),
  z.strictObject({ ...eventBase, authorityGeneration: z.literal(0), kind: z.literal('research.receipt'), payload: z.strictObject({ jobId: id,
    receiptCommandId: id.nullable(), status: z.enum(['completed', 'parked']), costMicros: revision.nullable(), observedAt: accountInstantSchema }) }),
]).superRefine((event, ctx) => {
  if (event.kind === 'thread.observed' && event.payload.projection.thread.accountId !== event.accountId) {
    ctx.addIssue({ code: 'custom', message: 'Thread event account mismatch' });
  }
  if (['account.bootstrap','manual.outcome', 'manual.handoff', 'campaign.changed', 'acquisition.milestone_reported'].includes(event.kind) && 'receipt' in event && (event.receipt.status !== 'applied' || event.receipt.authorityGeneration !== event.authorityGeneration
    || event.receipt.aggregateVersion !== event.aggregateVersion)) {
    ctx.addIssue({ code: 'custom', message: 'Manual acknowledgment receipt mismatch' });
  }
  const campaign = event.kind === 'campaign.changed' ? event.payload : 'campaign' in event ? event.campaign : undefined;
  if (campaign && (campaign.enrollment && campaign.enrollment.accountId !== event.accountId
    || campaign.version && !campaign.version.cohortAccountIds.includes(event.accountId)
    || event.kind === 'campaign.changed' && campaign.commandId !== event.receipt.commandId
    || (event.kind === 'manual.outcome' || event.kind === 'action.outcome') && campaign.evidence !== null && campaign.evidence.actionId !== event.payload.actionId)) {
    ctx.addIssue({ code: 'custom', message: 'Campaign event identity mismatch' });
  }
  if (campaign && (event.kind === 'manual.handoff' || event.kind === 'manual.outcome' || event.kind === 'action.outcome')) {
    const channel = event.kind === 'action.outcome' ? 'email' : event.payload.channel;
    if (campaign.cap && campaign.cap.channel !== channel || campaign.evidence === null && (!campaign.cap || campaign.version !== null || campaign.enrollment !== null)
      || event.kind === 'manual.handoff' && (campaign.evidence !== null || campaign.commandId !== event.receipt.commandId)
      || event.kind === 'action.outcome' && campaign.evidence === null && event.payload.state !== 'dispatching') {
      ctx.addIssue({code:'custom',message:'Invalid campaign cap-only action projection'});
    }
  }
  if (event.kind === 'authority.changed' && (event.payload.authority.accountId !== event.accountId
    || event.payload.authority.generation !== event.authorityGeneration || event.payload.receipt.authorityGeneration !== event.authorityGeneration
    || event.payload.receipt.aggregateVersion !== event.aggregateVersion || event.payload.receipt.status === 'pending')) {
    ctx.addIssue({ code: 'custom', message: 'Authority event identity or receipt mismatch' });
  }
  if ((event.kind === 'research.created' && (event.payload.account.id !== event.accountId || event.payload.account.version !== 1))
    || (event.kind === 'research.evidence' && (event.payload.batch.accountId !== event.accountId
      || event.payload.batch.routes.some(route => route.accountId !== event.accountId)))) {
    ctx.addIssue({ code: 'custom', message: 'Research event account mismatch' });
  }
});
export type WorkerEvent = Readonly<z.infer<typeof workerEventSchema>>;
export const reservationSchema = z.strictObject({ actionId: id, workspaceId: id, accountId: id, authorityGeneration: revision,
  contentHash: hash, targetHash: hash, state: z.literal('dispatching') });
export type Reservation = Readonly<z.infer<typeof reservationSchema>>;
export const reserveDispatchInputSchema = z.strictObject({ actionId: id, workspaceId: id, accountId: id,
  expectedAuthorityGeneration: revision, expectedVersion: revision, approvalId: id, contentHash: hash, targetHash: hash });
export type ReserveDispatchInput = Readonly<z.infer<typeof reserveDispatchInputSchema>>;
export const appendOutcomeInputSchema = z.strictObject({ reservation: reservationSchema, state: z.enum(['unknown', 'provider_accepted', 'cancelled']),
  observedAt: accountInstantSchema, evidenceRef: id });
export type AppendOutcomeInput = Readonly<z.infer<typeof appendOutcomeInputSchema>>;
const transportCursor = z.string().regex(/^[a-f0-9]{64}:[1-9][0-9]*$/).nullable();
export const eventPageSchema = z.strictObject({ events: z.array(workerEventSchema).max(1000), nextCursor: transportCursor, headCursor: transportCursor, complete: z.boolean() })
  .refine(page => page.complete === (page.nextCursor === page.headCursor), 'Transport completeness mismatch');
export type EventPage = Readonly<z.infer<typeof eventPageSchema>>;
export interface ExecutionRepository {
  applyCommand(command: DelegationCommand): Promise<CommandReceipt>;
  reserveDispatch(input: ReserveDispatchInput): Promise<Reservation>;
  appendOutcome(input: AppendOutcomeInput): Promise<void>;
  eventsAfter(cursor: string | null): Promise<EventPage>;
}
