import {requestedFollowupDraftSchema,approveRequestedFollowupSchema,prepareRequestedFollowupSchema,requestedMailContextSchema} from './requestedFollowupContract';
import {accountRecordSchema} from './accountRecordContract';
import { saveMeetingOfferSchema } from './meetingContract';
import { z } from 'zod';
import { acquisitionMilestoneReportSchema } from './acquisitionReportContract';
import { audienceQuerySchema, discoveryProviderSchema, researchCapabilitySchema, researchLimitsSchema, PLACES_MAX_COMPANIES } from '../../main/research/companyResearchTypes';
import { campaignCommandPayloadSchema } from './campaignContract';
import { mailCursorEnvelopeSchema, accountReplyDraftSchema } from './mailThreadContract';
import { accountIdSchema as id, accountInstantSchema as instant } from './accountContract';
import { manualCallOutcomes } from './accountOutboundContract';
import { territoryCallPolicyCommandPayloadSchema, TERRITORY_CALL_POLICY_SUBJECT } from './territoryCallPolicyContract';
import { replyTemplateCommandPayloadSchema, REPLY_TEMPLATE_SUBJECT } from './replyTemplateContract';
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const manualBase = { actionId: id, observedAt: instant, evidenceRef: id, replyText: z.string().max(10000).nullable().optional() };
export const manualOutcomeSchema = z.discriminatedUnion('channel', [
  z.strictObject({ ...manualBase, channel: z.literal('call'), outcome: z.enum(manualCallOutcomes) }),
  z.strictObject({ ...manualBase, channel: z.literal('linkedin'), outcome: z.enum(['human_reported_sent', 'reply', 'no_reply', 'opt_out', 'cancelled', 'not_sent', 'unknown']) }),
]);
export type ManualOutcome = Readonly<z.infer<typeof manualOutcomeSchema>>;
export const ownerResearchConfigurationSchema = z.strictObject({ workspaceId: id, budgetId: id, audience: audienceQuerySchema,
  audienceRevision: revision.min(1), sourceRevision: revision.min(1), budgetRevision: revision.min(1),
  discoveryLimits: researchLimitsSchema, researchLimits: researchLimitsSchema, capability: researchCapabilitySchema,
  maxAccountBudgetMicros: revision.min(1), permittedSources: z.array(z.url().max(2048)).max(500), preparationCommandId: z.uuid(),
  /** Only ever stored as `places`; cited configurations keep no key so their fingerprints stay byte-identical. */
  discoveryProvider: discoveryProviderSchema.optional() })
  .refine(value => value.discoveryProvider !== 'places' || value.discoveryLimits.maxCompanies <= PLACES_MAX_COMPANIES, 'places_batch_size');
/** Activation selector only. AUTH, actual grants, budgets and exact approvals
 * remain independent mandatory authority. No per-message scheduler allowlist. */
export const ownerSourceConfigurationSchema = z.strictObject({ version: z.literal(1), workspaceId: id, accountId: id, pairingId: id,
  revision: revision.min(1), state: z.enum(['paused','active']), mailboxSubject: id.nullable(), calendarId: id.nullable(), research: ownerResearchConfigurationSchema.nullable() });
export type OwnerSourceConfiguration = z.infer<typeof ownerSourceConfigurationSchema>;
export const ownerSourceKey = (accountId: string): string => `OWNER_SOURCE#${encodeURIComponent(id.parse(accountId))}`;
export const ownerCommandBase = { commandId: z.uuid(), workspaceId: id, accountId: id, expectedAuthorityGeneration: revision, expectedVersion: revision };
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
/** The workspace-level territory call policy (D1). It names the fixed policy subject, never a company, and carries no
 * authority CAS: its own revision is the CAS. The coordinator answers with the receipt and the resulting policy. */
export const territoryPolicyCommandSchema=z.strictObject({...ownerCommandBase,kind:z.literal('territory-policy'),payload:territoryCallPolicyCommandPayloadSchema})
 .refine(command=>command.accountId===TERRITORY_CALL_POLICY_SUBJECT&&command.expectedAuthorityGeneration===0&&command.expectedVersion===0,'territory_policy_envelope');
export type TerritoryPolicyCommand=z.infer<typeof territoryPolicyCommandSchema>;
/** The workspace-level standing approval of one follow-up template (D13). Like the territory policy it names the
 * fixed templates subject, never a company, and carries no authority CAS. Approving carries the template id, the
 * revision and the sha256 of exactly that revision's subject and body, so the worker can never send text David
 * did not approve; it is standing permission to send an already approved template, not a send. */
export const replyTemplateCommandSchema=z.strictObject({...ownerCommandBase,kind:z.literal('reply-template'),payload:replyTemplateCommandPayloadSchema})
 .refine(command=>command.accountId===REPLY_TEMPLATE_SUBJECT&&command.expectedAuthorityGeneration===0&&command.expectedVersion===0,'reply_template_envelope');
export type ReplyTemplateCommand=z.infer<typeof replyTemplateCommandSchema>;
export const ownerCommandSchemas = [replyTemplateCommandSchema,territoryPolicyCommandSchema,approveRequestedFollowupCommandSchema,bootstrapSelectedAccountCommandSchema,refreshSelectedAccountRecordCommandSchema, submitApprovedReplyCommandSchema, prepareManualCommandSchema, completeManualCommandSchema, approveReplyCommandSchema, ownerCampaignCommandSchema, configureOwnerCommandSchema, reportAcquisitionMilestoneCommandSchema] as const;
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
/** The worker's scope vocabulary as the desktop stores it. `emergency:stop` only ever travels on the emergency credential. */
export const pairingScopeSchema=z.enum(['commands:write','events:read','google:grant','pairing:revoke','emergency:stop']);
export type PairingScope=z.infer<typeof pairingScopeSchema>;
/** What Settings may know about the stored pairing: identity, generation and scopes. Never a credential. */
export const storedPairingSummarySchema=z.strictObject({workspaceId:id,pairingId:id,endpoint:z.url(),generation:revision,scopes:z.array(pairingScopeSchema).min(1)});
export type StoredPairingSummary=z.infer<typeof storedPairingSummarySchema>;
/** Rotate the stored pairing's credential in place. The pairing id and generation the renderer read must still be the
 * stored ones, so a stale screen can never rotate a pairing it did not show. Endpoint and workspace come from the store. */
export const rotateLocalPairingSchema=z.strictObject({pairingId:id,expectedGeneration:revision,code:z.string().min(1).max(128)});
export const rotatedLocalPairingSchema=z.strictObject({state:z.literal('rotated'),workspaceId:id,pairingId:id,generation:revision.min(1),scopes:z.array(pairingScopeSchema).min(1)});
/** Why a bounded replay stopped short, from a closed set. Never a message, path or cause. */
/** `apply`: this Mac refused to record an event the worker served (a local constraint or validation), which is not a transport fault. */
export const syncFailureSchema=z.enum(['timeout','transport','invalid_event','gap','apply']).nullable();
/** The budget for one whole sync run. Named once so the main process and the report line cannot drift. */
export const SYNC_BUDGET_SECONDS=120;
/** `failure` is optional on the wire: a report that names no reason is read as naming no reason, never
 * as a reason it did not give. The main process always states it; `ownerFresh` stays the only proof. */
export const delegationSyncReportSchema=z.strictObject({applied:revision,gaps:revision,cursor:z.string().nullable(),ownerFresh:z.boolean(),failure:syncFailureSchema.optional(),
  /** The stage that stopped the run and the error it raised, bounded, for the report line; null when the run completed. */
  detail:z.string().max(400).nullable().optional()});

/** `manual` states that the founder will dial the number himself on this Mac. It is a routing flag the
 * desktop carries, never a permission: absent or present, the handoff, the evidence and the approvals are
 * identical. Only the literal `true` is accepted, so `false` can never be read as "the worker may dial". */
export const delegatedPhoneHandoffRequestSchema=z.strictObject({command:prepareManualCommandSchema.refine(command=>command.payload.channel==='call'),expectedEvidenceFingerprint:hash,manual:z.literal(true).optional()});
export type DelegatedPhoneHandoffRequest=z.infer<typeof delegatedPhoneHandoffRequestSchema>;

/** Authenticated owner-only bounded proof. Never accepts caller authority or expiry. */
export const requestedOwnerContextRequestSchema=z.strictObject({workspaceId:id,input:prepareRequestedFollowupSchema});
export const requestedOwnerContextSchema=z.strictObject({workspaceId:id,accountId:id,
 mailbox:z.strictObject({subject:id,sender:z.string().email().max(254)}),mailContext:requestedMailContextSchema,
 accountVersion:revision.min(1),researchRevision:revision.min(1),authorityGeneration:revision,aggregateVersion:revision,
 cursor:z.strictObject({data:mailCursorEnvelopeSchema,rev:revision.min(1)}).nullable(),expiresAt:instant});

export const requestedOwnerDraftRequestSchema=z.strictObject({workspaceId:id,previousDraft:requestedFollowupDraftSchema,draft:requestedFollowupDraftSchema});
