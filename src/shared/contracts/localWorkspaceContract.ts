import type { AdmitCompanyDraftEmail, OpenCompanyDraft, GetCompanyDraft, SaveCompanyDraft, CompanyDraftAdmissionReceipt, CompanyDraftRead, CompanyDraftMutationResult, PrepareCompanyDraft, PreparedCompanyDraft } from './localCompanyDraftContract';
import type { ConfirmTerritoryClearance, RevokeTerritoryClearance, TerritoryClearanceSnapshot } from './territoryClearanceContract';
import type { AdmitCompanyPhoneRoute, CompanyPhoneRouteReceipt } from './localCompanyPhoneRouteContract';
import { companyDraftEmailSchema } from './localCompanyDraftContract';
import type { CompanyResearchSettings, UpdateCompanyResearchSettingsRequest } from './localCompanyResearchSettingsContract';
export * from './localCompanyResearchSettingsContract';
import { z } from 'zod';
import type { LocalCompanyInput, LocalCompanyCreateRequest, LocalCompanyReview, LocalCompanyCreateResult, LocalCompanyCreateStatus } from './localCompanyIntakeContract';
import { accountIdSchema, accountInstantSchema, accountLinkSchema, accountSchema, accountSourceSchema, type AccountLink, type AccountEvidenceReceipt } from './accountContract';
import { dailyAccountSchema } from './dailyContract';
import { todayItemSchema } from './todayContract';
const id = z.string().min(1);
const counter = z.number().int().nonnegative().safe();
export const meetingFirstAccountCallSettingsSchema = z.strictObject({
  newCallSlots: counter.nullable(), totalCallCapacity: counter.nullable(),
  revision: counter, updatedAt: accountInstantSchema,
}).transform(row => ({ newCallSlots: row.newCallSlots, totalCallCapacity: row.totalCallCapacity, revision: row.revision, updatedAt: row.updatedAt }));
export const updateCallSettingsRequestSchema = z.strictObject({
  expectedRevision: counter, newCallSlots: counter.nullable(), totalCallCapacity: counter.nullable(),
}).transform(row => ({ expectedRevision: row.expectedRevision, newCallSlots: row.newCallSlots, totalCallCapacity: row.totalCallCapacity }));
export type MeetingFirstAccountCallSettings = Readonly<{ newCallSlots: number | null; totalCallCapacity: number | null; revision: number; updatedAt: string }>;
export type UpdateCallSettingsRequest = Readonly<{ expectedRevision: number; newCallSlots: number | null; totalCallCapacity: number | null }>;
export const callSettingsUpdateReplySchema = (input: UpdateCallSettingsRequest) =>
  meetingFirstAccountCallSettingsSchema.refine(result => input.expectedRevision < Number.MAX_SAFE_INTEGER
    && result.revision === input.expectedRevision + 1
    && result.newCallSlots === input.newCallSlots && result.totalCallCapacity === input.totalCallCapacity,
  'Call settings update mismatch');
export const selectedCompanySchema = z.strictObject({ accountId: accountIdSchema });
export const selectedResearchSchema = z.strictObject({ commandId: z.uuid(), accountId: accountIdSchema });
export const accountEvidenceReceiptSchema = z.strictObject({
  accountId: accountIdSchema, version: accountSchema.shape.version, duplicate: z.boolean(),
});
export type ReviewedPersonLink = Omit<Extract<AccountLink, { kind: 'person_role' }>, 'authority' | 'authorityEvidenceIds' | 'validTo'> & {
  authority: 'unconfirmed'; authorityEvidenceIds: []; validTo: null;
};
// Both intersection branches reject unknown keys. The existing strict union
// retains all link-field bounds and refinements while the overlay narrows review.
export const reviewedPersonLinkSchema: z.ZodType<ReviewedPersonLink> = z.intersection(accountLinkSchema,
  z.strictObject({ kind: z.literal('person_role'), authority: z.literal('unconfirmed'), authorityEvidenceIds: z.tuple([]), validTo: z.null() }));
export const linkCompanyPersonRequestSchema = z.strictObject({
  commandId: z.uuid(), accountId: accountIdSchema, expectedVersion: accountSchema.shape.version,
  link: reviewedPersonLinkSchema,
  sourceQuotes: z.array(z.strictObject({ sourceId: accountIdSchema,
    quote: accountSourceSchema.shape.excerpt.refine(quote => quote.trim().length > 0, 'Relationship quote required'),
  })).min(1).max(100),
}).refine(command => {
  const quoted = new Set(command.sourceQuotes.map(item => item.sourceId));
  return quoted.size === command.sourceQuotes.length && quoted.size === command.link.evidenceIds.length
    && command.link.evidenceIds.every(id => quoted.has(id));
}, 'Relationship evidence mismatch');
export type LinkCompanyPersonRequest = z.infer<typeof linkCompanyPersonRequestSchema>;
export const localCompanyResearchStatusSchema = z.strictObject({
  commandId: z.uuid(), accountId: accountIdSchema,
  state: z.enum(['not_recorded', 'queued', 'running', 'completed', 'parked', 'held']),
  receipt: accountEvidenceReceiptSchema.nullable(), reason: z.string().nullable(),
}).refine(status => (status.state === 'completed') === (status.receipt !== null)
  && (status.receipt === null || status.receipt.accountId === status.accountId), 'local_company_research_receipt_mismatch');
export type SelectedResearch = z.infer<typeof selectedResearchSchema>;
export type LocalCompanyResearchStatus = z.infer<typeof localCompanyResearchStatusSchema>;
// SQL selects source/link ownership. The wire contract binds every evidence reference
// to the complete selected source set without changing the existing authority rules.
export const localCompanyDetailSchema = z.strictObject({
  scope: z.literal('local_database'), generatedAt: accountInstantSchema,
  snapshot: dailyAccountSchema, sources: z.array(accountSourceSchema), links: z.array(accountLinkSchema),
}).refine(detail => {
  const sourceIds = new Set(detail.sources.map(source => source.id));
  const hasEvidence = (ids: readonly string[]) => ids.every(id => sourceIds.has(id));
  return sourceIds.size === detail.sources.length
    && detail.sources.every(source => source.permitted && source.fetchedAt <= detail.generatedAt)
    && new Set(detail.snapshot.routes.map(route => route.id)).size === detail.snapshot.routes.length
    && detail.snapshot.routes.every(route => route.accountId === detail.snapshot.account.id && hasEvidence(route.evidenceIds))
    && detail.snapshot.claims.every(claim => hasEvidence(claim.evidenceIds))
    && detail.snapshot.portfolio.every(item => hasEvidence(item.evidenceIds))
    && new Set(detail.links.map(link => link.id)).size === detail.links.length
    && detail.links.every(link => link.validFrom <= detail.generatedAt
      && (link.validTo === null || link.validTo > detail.generatedAt)
      && hasEvidence(link.evidenceIds)
      && (link.kind !== 'person_role' || hasEvidence(link.authorityEvidenceIds)));
}, 'local_company_evidence_mismatch');
export type SelectedCompany = z.infer<typeof selectedCompanySchema>;
export type LocalCompanyDetail = z.infer<typeof localCompanyDetailSchema>;
export const localWorkflowTransitionSchema = z.strictObject({ commandId: z.string().trim().min(1), expectedMode: z.literal('legacy'), manifestId: z.string().trim().min(1) });
export const localWorkflowReceiptSchema = z.strictObject({
  commandId: id, manifestId: id, mode: z.literal('meeting_first'), revision: counter.positive(), occurredAt: z.string().datetime(),
  cancelledActionIds: z.array(id), stoppedEnrollmentIds: z.array(id), preservedActionIds: z.array(id), parkedPersonIds: z.array(id),
  callbackEvidenceIds: z.array(id), unknownDraftIds: z.array(id),
  parkedReviewActions: z.array(z.strictObject({ id, cycleId: id, version: counter.positive() })),
  parkedActions: z.array(z.strictObject({ id, supersededActionId: id, cycleId: id })),
});
/** Local evidence only: saved research or sources, an unsent local draft, a published business inbox route.
 *  Never worker ownership; never a started action. Enum order is readiness order, most ready first. Unknown stays unknown. */
export const localAccountPreparationStepSchema = z.enum(['reopen_draft', 'draft', 'add_route', 'research', 'unknown']);
export const localAccountPreparationSchema = z.strictObject({
  researched: z.boolean().nullable(), unsentDraft: z.boolean().nullable(), businessRoute: z.boolean().nullable(),
  nextStep: localAccountPreparationStepSchema, reason: z.string().trim().min(1).max(300),
}).refine(p => p.nextStep === (p.researched === null || p.unsentDraft === null || p.businessRoute === null ? 'unknown'
  : p.unsentDraft ? 'reopen_draft' : !p.researched ? 'research' : !p.businessRoute ? 'add_route' : 'draft'), 'local_preparation_step_mismatch');
export type LocalAccountPreparationStep = z.infer<typeof localAccountPreparationStepSchema>;
export type LocalAccountPreparation = z.infer<typeof localAccountPreparationSchema>;
// Additive and optional: snapshots without a preparation summary keep parsing unchanged.
export const localAccountSnapshotSchema = dailyAccountSchema.extend({ preparation: localAccountPreparationSchema.optional() });
export type LocalAccountSnapshot = z.infer<typeof localAccountSnapshotSchema>;
const accountsSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('available'), snapshots: z.array(localAccountSnapshotSchema) }),
  z.strictObject({ state: z.literal('unavailable'), snapshots: z.tuple([]) }),
]).refine(result => result.state === 'unavailable' || new Set(result.snapshots.map(s => s.account.id)).size === result.snapshots.length
  && result.snapshots.every(s => s.routes.every(r => r.accountId === s.account.id)), 'local_account_identity_mismatch');
export const localWorkspaceSnapshotSchema = z.strictObject({ scope: z.literal('local_database'), generatedAt: accountInstantSchema,
  workflowMode: z.enum(['legacy', 'meeting_first']), transitionReceipt: localWorkflowReceiptSchema.nullable(), accounts: accountsSchema,
}).refine(s => s.transitionReceipt === null || s.workflowMode === 'meeting_first', 'local_receipt_mode_mismatch');
/** Additive and optional: an unsent local company draft, read from local evidence only. Never a person item and never worker
 *  ownership. Reopening or saving it is never sending. */
export const localDraftContinuationSchema = z.strictObject({
  accountId: accountIdSchema, draftId: accountIdSchema, companyLabel: z.string().min(1).max(300), subject: z.string().max(240),
  revision: counter.positive(), updatedAt: accountInstantSchema, email: companyDraftEmailSchema,
});
export type LocalDraftContinuation = z.infer<typeof localDraftContinuationSchema>;
export const localCommitmentsSnapshotSchema = z.strictObject({ scope: z.literal('local_database'), generatedAt: accountInstantSchema,
  revision: counter, reviewErrorCount: counter, items: z.array(z.strictObject({
    kind: z.enum(['callback', 'post_stage', 'onboarding', 'inbound_response', 'warm_relationship', 'founder_resurface']),
    item: todayItemSchema.refine(item => item.id === item.salesCycleId, 'local_today_identity_mismatch'),
  })),
  // Snapshots without local drafts keep parsing unchanged.
  localDrafts: z.array(localDraftContinuationSchema).optional(),
}).refine(s => new Set(s.items.map(r => r.item.salesCycleId)).size === s.items.length
  && new Set(s.items.map(r => r.item.action.id)).size === s.items.length
  && new Set((s.localDrafts ?? []).map(d => d.draftId)).size === (s.localDrafts ?? []).length, 'local_today_duplicate_identity');
export type LocalWorkflowTransition = z.infer<typeof localWorkflowTransitionSchema>;
export type LocalWorkflowReceipt = z.infer<typeof localWorkflowReceiptSchema>;
export type LocalWorkspaceSnapshot = z.infer<typeof localWorkspaceSnapshotSchema>;
export type LocalCommitmentsSnapshot = z.infer<typeof localCommitmentsSnapshotSchema>;
export interface LocalWorkspaceApi {
  /** Territory clearance (design D4): one confirmed compliance clearance per state. Optional: a build without it shows the Settings section as unavailable. Confirming never dials. */
  readTerritoryClearance?: () => Promise<TerritoryClearanceSnapshot>;
  confirmTerritoryClearance?: (input: ConfirmTerritoryClearance) => Promise<TerritoryClearanceSnapshot>;
  revokeTerritoryClearance?: (input: RevokeTerritoryClearance) => Promise<TerritoryClearanceSnapshot>;
  prepareCompanyDraft(input: PrepareCompanyDraft): Promise<PreparedCompanyDraft>;
  admitCompanyDraftEmail(input: AdmitCompanyDraftEmail): Promise<CompanyDraftAdmissionReceipt>;
  /** Phone twin of the reviewed inbox admission. Optional: a build without it shows phone route review as unavailable. Saving is never a call. */
  admitCompanyPhoneRoute?: (input: AdmitCompanyPhoneRoute) => Promise<CompanyPhoneRouteReceipt>;
  openCompanyDraft(input: OpenCompanyDraft): Promise<CompanyDraftMutationResult>;
  getCompanyDraft(input: GetCompanyDraft): Promise<CompanyDraftRead | null>;
  saveCompanyDraft(input: SaveCompanyDraft): Promise<CompanyDraftMutationResult>;
  getCompanyResearchSettings(): Promise<CompanyResearchSettings>;
  updateCompanyResearchSettings(input: UpdateCompanyResearchSettingsRequest): Promise<CompanyResearchSettings>;
  getCallSettings(): Promise<MeetingFirstAccountCallSettings>;
  updateCallSettings(input: UpdateCallSettingsRequest): Promise<MeetingFirstAccountCallSettings>;
  linkCompanyPerson(input: LinkCompanyPersonRequest): Promise<AccountEvidenceReceipt>;
  researchCompany(input: SelectedResearch): Promise<LocalCompanyResearchStatus>;
  getCompanyResearchStatus(input: SelectedResearch): Promise<LocalCompanyResearchStatus>;
  getCompany(input: SelectedCompany): Promise<LocalCompanyDetail>;
  reviewCompany(input: LocalCompanyInput): Promise<LocalCompanyReview>;
  createCompany(input: LocalCompanyCreateRequest): Promise<LocalCompanyCreateResult>;
  getCompanyCreateStatus(input: LocalCompanyCreateRequest): Promise<LocalCompanyCreateStatus>;
  get(): Promise<LocalWorkspaceSnapshot>;
  getCommitments(): Promise<LocalCommitmentsSnapshot>;
  transition(command: LocalWorkflowTransition): Promise<LocalWorkflowReceipt>;
}
