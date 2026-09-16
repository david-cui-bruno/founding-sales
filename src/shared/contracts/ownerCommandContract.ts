import {requestedFollowupDraftSchema,approveRequestedFollowupSchema,prepareRequestedFollowupSchema,requestedMailContextSchema} from './requestedFollowupContract';
import {accountRecordSchema} from './accountRecordContract';
import { saveMeetingOfferSchema, reserveMeetingSchema } from './meetingContract';
import { z } from 'zod';
import { acquisitionMilestoneReportSchema } from './acquisitionReportContract';
import { audienceQuerySchema, researchCapabilitySchema, researchLimitsSchema } from '../../main/research/companyResearchTypes';
import { campaignCommandPayloadSchema } from './campaignContract';
import { mailCursorEnvelopeSchema, accountReplyDraftSchema } from './mailThreadContract';
import { accountIdSchema as id, accountInstantSchema as instant } from './accountContract';
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const manualBase = { actionId: id, observedAt: instant, evidenceRef: id, replyText: z.string().max(10000).nullable().optional() };
export const manualOutcomeSchema = z.discriminatedUnion('channel', [
  z.strictObject({ ...manualBase, channel: z.literal('call'), outcome: z.enum(['connected', 'no_answer', 'voicemail', 'busy', 'wrong_number', 'cancelled', 'not_called', 'unknown', 'opt_out']) }),
  z.strictObject({ ...manualBase, channel: z.literal('linkedin'), outcome: z.enum(['human_reported_sent', 'reply', 'no_reply', 'opt_out', 'cancelled', 'not_sent', 'unknown']) }),
]);
export type ManualOutcome = Readonly<z.infer<typeof manualOutcomeSchema>>;
export const ownerResearchConfigurationSchema = z.strictObject({ workspaceId: id, budgetId: id, audience: audienceQuerySchema,
  audienceRevision: revision.min(1), sourceRevision: revision.min(1), budgetRevision: revision.min(1),
  discoveryLimits: researchLimitsSchema, researchLimits: researchLimitsSchema, capability: researchCapabilitySchema,
  maxAccountBudgetMicros: revision.min(1), permittedSources: z.array(z.url().max(2048)).max(500), preparationCommandId: z.uuid() });
/** Activation selector only. AUTH, actual grants, budgets and exact approvals
 * remain independent mandatory authority. No per-message scheduler allowlist. */
export const ownerSourceConfigurationSchema = z.strictObject({ version: z.literal(1), workspaceId: id, accountId: id, pairingId: id,
  revision: revision.min(1), state: z.enum(['paused','active']), mailboxSubject: id.nullable(), calendarId: id.nullable(), research: ownerResearchConfigurationSchema.nullable() });
export type OwnerSourceConfiguration = z.infer<typeof ownerSourceConfigurationSchema>;
export const ownerSourceKey = (accountId: string): string => `OWNER_SOURCE#${encodeURIComponent(id.parse(accountId))}`;
export const ownerCommandBase = { commandId: z.uuid(), workspaceId: id, accountId: id, expectedAuthorityGeneration: revision, expectedVersion: revision };
/** Explicit approval queues this exact create for the existing meeting poller. */
export const approveMeetingCommandSchema = z.strictObject({ ...ownerCommandBase, kind: z.literal('approve-meeting'), payload: reserveMeetingSchema }).refine(command => {
  const intent = command.payload.intent;
  return intent.workspaceId === command.workspaceId && intent.accountId === command.accountId
    && intent.expectedAuthorityGeneration === command.expectedAuthorityGeneration && intent.expectedVersion === command.expectedVersion + 1
    && intent.commandId === command.commandId && intent.approvalId === command.commandId
    && intent.operation === 'create' && intent.agreement?.kind === 'explicit_slot' && intent.agreementEvidenceId !== null
    && intent.attendeeEmails.length === 1 && intent.etag === null;
}, 'meeting_approval_binding');
export const ownerCampaignBindingSchema = z.strictObject({ campaignId: id, campaignRevision: revision.min(1), enrollmentId: id,
  enrollmentRevision: revision.min(1), stepId: id });
export const manualHandoffBindingSchema = z.strictObject({ actionId: id, channel: z.enum(['call', 'linkedin']), routeId: id,
  routeVersion: revision.min(1), targetHash: hash, contentHash: hash, contextRevision: id, campaign: ownerCampaignBindingSchema });
export const submitApprovedReplyCommandSchema = z.strictObject({ ...ownerCommandBase, kind: z.literal('submit-approved-reply'),
  payload: z.strictObject({ intentCommandId: z.uuid() }) });
export const prepareManualCommandSchema = z.strictObject({ ...ownerCommandBase, kind: z.literal('prepare-manual'), payload: manualHandoffBindingSchema });
export const completeManualCommandSchema = z.strictObject({ ...ownerCommandBase, kind: z.literal('complete-manual'),
  payload: z.strictObject({ handoffId: id, targetHash: hash, outcome: manualOutcomeSchema }) });
export const manualHandoffSchema = manualHandoffBindingSchema.extend({ handoffId: id, expiresAt: instant });
export type ManualHandoff = z.infer<typeof manualHandoffSchema>;
export const ownerReplyBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('thread_participant'), threadId: id, sourceMessageId: id, sourceMessageHash: hash }),
  z.strictObject({ kind: z.literal('account_route'), routeId: id, routeVersion: revision.min(1), accountVersion: revision.min(1) }),
]);
export const approveReplyCommandSchema = z.strictObject({ ...ownerCommandBase, kind: z.literal('approve-reply'), payload: z.strictObject({
  draft: accountReplyDraftSchema, expectedRemoteDraftRevision: revision.min(1), approvalId: id, actionId: id, intentCommandId: z.uuid(),
  permission: z.strictObject({ id, sourceMessageId: id, sourceMessageHash: hash, basis: z.enum(['requested_followup', 'ongoing_correspondence']), expiresAt: instant }),
  binding: ownerReplyBindingSchema, expiresAt: instant, schedulingOffer: saveMeetingOfferSchema.optional(),
}) });
/** Canonical owner command members. DelegationCommand imports these exact schemas
 * during its serialized integration turn. No arbitrary execute payload exists. */
export const ownerCampaignCommandSchema = z.strictObject({ ...ownerCommandBase, kind: z.literal('campaign-command'), payload: campaignCommandPayloadSchema.refine(value => value.kind !== 'campaign.outcome', 'Outcomes require actual reserved action evidence') });
export const configureOwnerCommandSchema = z.strictObject({ ...ownerCommandBase, kind: z.literal('configure-owner'), payload: z.strictObject({
  expectedConfigurationRevision: revision, configuration: ownerSourceConfigurationSchema,
  mailScope: z.strictObject({ expectedEnvelopeRevision: revision.min(1).nullable(), since: instant }).nullable(),
}) });
export const reportAcquisitionMilestoneCommandSchema = z.strictObject({ ...ownerCommandBase, kind: z.literal('report-acquisition-milestone'), payload: acquisitionMilestoneReportSchema });
export const selectedAccountSuppressionSchema=z.strictObject({id,observedAt:instant,source:id,evidenceRef:id});
export const bootstrapSelectedAccountCommandSchema=z.strictObject({...ownerCommandBase,kind:z.literal('bootstrap-selected-account'),payload:z.strictObject({record:accountRecordSchema,asOf:instant,expectedResearchRevision:revision.min(1).nullable(),suppression:z.array(selectedAccountSuppressionSchema).max(100)})});
export const bootstrapSelectedAccountSchema=z.strictObject({commandId:z.uuid(),accountId:id});
export const accountBootstrapPayloadSchema=z.strictObject({commandId:z.uuid(),recordFingerprint:hash,researchRevision:revision.min(1)});
/** Explicit owner resubmission of the current saved record to a worker that already owns the company. Unlike
 * bootstrap, generation and version are the real mirror values and the record is bound to the research revision
 * the desktop read. The trusted main SQL exporter constructs the record; the renderer only names command and company. */
export const refreshSelectedAccountRecordCommandSchema=z.strictObject({...ownerCommandBase,kind:z.literal('refresh-selected-account-record'),payload:z.strictObject({record:accountRecordSchema,asOf:instant,expectedResearchRevision:revision.min(1)})})
 .refine(command=>command.payload.record.account.id===command.accountId&&command.payload.record.researchRevision===command.payload.expectedResearchRevision,'refresh_record_binding');
export const refreshSelectedAccountRecordSchema=z.strictObject({commandId:z.uuid(),accountId:id});
export type RefreshSelectedAccountRecord=z.infer<typeof refreshSelectedAccountRecordSchema>;
export const selectedAccountFreshnessRequestSchema=z.strictObject({accountId:id});
export type SelectedAccountFreshnessRequest=z.infer<typeof selectedAccountFreshnessRequestSchema>;
/** Desktop-only comparison of the saved record with the copy the worker last applied. `unknown` means no applied
 * copy is known locally; the state is derived from the two fingerprints and never asserted independently. */
export const selectedAccountFreshnessSchema=z.strictObject({accountId:id,state:z.enum(['current','stale','unknown']),localFingerprint:hash,sentFingerprint:hash.nullable(),sentAt:instant.nullable()})
 .refine(value=>(value.sentFingerprint===null)===(value.sentAt===null)&&value.state===(value.sentFingerprint===null?'unknown':value.sentFingerprint===value.localFingerprint?'current':'stale'),'selected_account_freshness_binding');
export type SelectedAccountFreshness=z.infer<typeof selectedAccountFreshnessSchema>;

export const approveRequestedFollowupCommandSchema=z.strictObject({...ownerCommandBase,kind:z.literal('approve-requested-followup'),payload:approveRequestedFollowupSchema});
export const ownerCommandSchemas = [approveMeetingCommandSchema,approveRequestedFollowupCommandSchema,bootstrapSelectedAccountCommandSchema,refreshSelectedAccountRecordCommandSchema, submitApprovedReplyCommandSchema, prepareManualCommandSchema, completeManualCommandSchema, approveReplyCommandSchema, ownerCampaignCommandSchema, configureOwnerCommandSchema, reportAcquisitionMilestoneCommandSchema] as const;
export const ownerCommandSchema = z.discriminatedUnion('kind', ownerCommandSchemas);
export type OwnerCommand = z.infer<typeof ownerCommandSchema>;

export const localDelegationConfigurationSchema = z.strictObject({version:z.literal(1),state:z.enum(['paused','active']),research:ownerResearchConfigurationSchema.nullable()});
export type LocalDelegationConfiguration = z.infer<typeof localDelegationConfigurationSchema>;
export const configureLocalDelegationSchema = z.strictObject({expectedRevision:revision,configuration:localDelegationConfigurationSchema});
export const localDelegationConfigurationRecordSchema = z.strictObject({revision:revision.min(1),configuration:localDelegationConfigurationSchema,updatedAt:instant});

/** Workspace discovery activation never creates an account or execution authority. */
export const ownerResearchSourceKey = (): string => 'OWNER_RESEARCH_SOURCE';
export const ownerResearchSourceSchema = z.strictObject({version:z.literal(1),workspaceId:id,pairingId:id,revision:revision.min(1),state:z.enum(['paused','active']),research:ownerResearchConfigurationSchema.nullable()}).refine(value=>!value.research||value.research.workspaceId===value.workspaceId,'Workspace mismatch');
export type OwnerResearchSource = z.infer<typeof ownerResearchSourceSchema>;
export const configureResearchSourceSchema = z.strictObject({commandId:z.uuid(),workspaceId:id,pairingId:id,expectedRevision:revision,configuration:ownerResearchSourceSchema});
export const localDelegationStatusSchema=z.strictObject({state:z.enum(['unconfigured','paused','active','locked']),workspaceId:id.nullable(),endpoint:z.url().nullable(),configuration:localDelegationConfigurationRecordSchema.nullable()});
export const ownerCheckpointRequestSchema=z.strictObject({workspaceId:id,accountId:id,handoffId:id.optional()});
export const ownerCheckpointSchema=z.strictObject({workspaceId:id,accountId:id,handoffId:id.optional(),generation:revision,version:revision,revision:hash,validUntil:revision.min(1)});
export const redeemLocalPairingSchema=z.strictObject({endpoint:z.url(),expectedWorkspaceId:id,code:z.string().min(1).max(128)});
export const redeemedLocalPairingSchema=z.strictObject({state:z.literal('paired'),workspaceId:id,pairingId:id});
export const delegationSyncReportSchema=z.strictObject({applied:revision,gaps:revision,cursor:z.string().nullable(),ownerFresh:z.boolean()});

export const delegatedPhoneHandoffRequestSchema=z.strictObject({command:prepareManualCommandSchema.refine(command=>command.payload.channel==='call'),expectedEvidenceFingerprint:hash});
export type DelegatedPhoneHandoffRequest=z.infer<typeof delegatedPhoneHandoffRequestSchema>;

/** Authenticated owner-only bounded proof. Never accepts caller authority or expiry. */
export const requestedOwnerContextRequestSchema=z.strictObject({workspaceId:id,input:prepareRequestedFollowupSchema});
export const requestedOwnerContextSchema=z.strictObject({workspaceId:id,accountId:id,
 mailbox:z.strictObject({subject:id,sender:z.string().email().max(254)}),mailContext:requestedMailContextSchema,
 accountVersion:revision.min(1),researchRevision:revision.min(1),authorityGeneration:revision,aggregateVersion:revision,
 cursor:z.strictObject({data:mailCursorEnvelopeSchema,rev:revision.min(1)}).nullable(),expiresAt:instant});

export const requestedOwnerDraftRequestSchema=z.strictObject({workspaceId:id,previousDraft:requestedFollowupDraftSchema,draft:requestedFollowupDraftSchema});
