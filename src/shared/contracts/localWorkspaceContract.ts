import { z } from 'zod';
import type { LocalCompanyInput, LocalCompanyCreateRequest, LocalCompanyReview, LocalCompanyCreateResult, LocalCompanyCreateStatus } from './localCompanyIntakeContract';
import { accountIdSchema, accountInstantSchema, accountLinkSchema, accountSourceSchema } from './accountContract';
import { dailyAccountSchema } from './dailyContract';
import { todayItemSchema } from './todayContract';
const id = z.string().min(1);
const counter = z.number().int().nonnegative().safe();
export const selectedCompanySchema = z.strictObject({ accountId: accountIdSchema });
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
const accountsSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('available'), snapshots: z.array(dailyAccountSchema) }),
  z.strictObject({ state: z.literal('unavailable'), snapshots: z.tuple([]) }),
]).refine(result => result.state === 'unavailable' || new Set(result.snapshots.map(s => s.account.id)).size === result.snapshots.length
  && result.snapshots.every(s => s.routes.every(r => r.accountId === s.account.id)), 'local_account_identity_mismatch');
export const localWorkspaceSnapshotSchema = z.strictObject({ scope: z.literal('local_database'), generatedAt: accountInstantSchema,
  workflowMode: z.enum(['legacy', 'meeting_first']), transitionReceipt: localWorkflowReceiptSchema.nullable(), accounts: accountsSchema,
}).refine(s => s.transitionReceipt === null || s.workflowMode === 'meeting_first', 'local_receipt_mode_mismatch');
export const localCommitmentsSnapshotSchema = z.strictObject({ scope: z.literal('local_database'), generatedAt: accountInstantSchema,
  revision: counter, reviewErrorCount: counter, items: z.array(z.strictObject({
    kind: z.enum(['callback', 'post_stage', 'onboarding', 'inbound_response', 'warm_relationship', 'founder_resurface']),
    item: todayItemSchema.refine(item => item.id === item.salesCycleId, 'local_today_identity_mismatch'),
  })),
}).refine(s => new Set(s.items.map(r => r.item.salesCycleId)).size === s.items.length
  && new Set(s.items.map(r => r.item.action.id)).size === s.items.length, 'local_today_duplicate_identity');
export type LocalWorkflowTransition = z.infer<typeof localWorkflowTransitionSchema>;
export type LocalWorkflowReceipt = z.infer<typeof localWorkflowReceiptSchema>;
export type LocalWorkspaceSnapshot = z.infer<typeof localWorkspaceSnapshotSchema>;
export type LocalCommitmentsSnapshot = z.infer<typeof localCommitmentsSnapshotSchema>;
export interface LocalWorkspaceApi {
  getCompany(input: SelectedCompany): Promise<LocalCompanyDetail>;
  reviewCompany(input: LocalCompanyInput): Promise<LocalCompanyReview>;
  createCompany(input: LocalCompanyCreateRequest): Promise<LocalCompanyCreateResult>;
  getCompanyCreateStatus(input: LocalCompanyCreateRequest): Promise<LocalCompanyCreateStatus>;
  get(): Promise<LocalWorkspaceSnapshot>;
  getCommitments(): Promise<LocalCommitmentsSnapshot>;
  transition(command: LocalWorkflowTransition): Promise<LocalWorkflowReceipt>;
}
