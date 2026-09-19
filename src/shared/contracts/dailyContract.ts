import { requestedAnswerPresentationSchema, manualAnswerPresentationSchema, dailyAnswerPresentationMatches } from './dailyAnswerPresentationContract';
import { z } from 'zod';
import { accountSchema, accountClaimSchema, accountRouteSchema, accountPortfolioSchema } from './accountContract';
import { dailyAccountCallPlanSchema } from './todayContract';
import { campaignVersionSchema, campaignCapSnapshotSchema, enrollmentSchema } from './campaignContract';
import { authorityStateSchema, commandReceiptSchema } from './delegationContract';
import { requestedFollowupDraftSchema, requestedApprovalStatusSchema } from './requestedFollowupContract';
import { accountReplyDraftSchema, threadProjectionSchema } from './mailThreadContract';
import { linkedInDraftSchema, linkedInRecoverySchema } from './linkedInContract';
import { usageSummarySchema } from './usageContract';
const id = z.string().min(1).max(255);
const revision = z.number().int().nonnegative().safe();
const instant = z.string().datetime({ offset: true });
export const dailyAccountSchema = z.strictObject({ account: accountSchema, claims: z.array(accountClaimSchema), routes: z.array(accountRouteSchema),
  portfolio: z.array(accountPortfolioSchema.extend({ evidenceIds: z.array(id) })), unknowns: z.array(z.string()), conflicts: z.array(z.string()), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
/** These are saved identities, not authorization. All explicit actions still use their existing owners. */
export const dailyAnswerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('requested_followup'), accountId: id, draft: requestedFollowupDraftSchema, presentation: requestedAnswerPresentationSchema.optional().catch(undefined), approval: requestedApprovalStatusSchema.nullable(), capability: z.literal('held'), reason: z.literal('requires_owner_preflight') }),
  z.strictObject({ kind: z.literal('reply'), accountId: id, thread: threadProjectionSchema, draft: accountReplyDraftSchema.nullable(), stale: z.boolean(), capability: z.literal('held'), reason: z.literal('reply_capability_unverified') }),
  z.strictObject({ kind: z.literal('manual_linkedin'), accountId: id, draft: linkedInDraftSchema, presentation: manualAnswerPresentationSchema.optional().catch(undefined), recovery: linkedInRecoverySchema, capability: z.literal('manual_only') }),
]).refine(a => {
  if (a.kind === 'requested_followup') return a.draft.accountId === a.accountId;
  if (a.kind === 'manual_linkedin') return a.draft.accountId === a.accountId && a.recovery.draftId === a.draft.id && a.recovery.revision === a.draft.revision;
  return a.thread.thread.accountId === a.accountId && (!a.draft || a.draft.accountId === a.accountId && a.draft.threadId === a.thread.thread.providerThreadId && a.draft.mailboxSubject === a.thread.thread.mailboxSubject);
}, 'answer_identity_mismatch').transform(a => {
  if (a.kind === 'reply' || !('presentation' in a)) return a;
  if (a.presentation && dailyAnswerPresentationMatches(a.presentation, a.draft, a.presentation.binding.workspaceId)) return a;
  const { presentation, ...saved } = a;
  void presentation;
  return saved as typeof a;
});
export const dailyOwnerStatusSchema = z.strictObject({ accountId: id, authority: authorityStateSchema.nullable(), executionVersion: revision.nullable(), pendingCommands: z.array(commandReceiptSchema),
  status: z.enum(['unknown', 'pending', 'owner_applied']) }).refine(o => o.authority === null || o.authority.accountId === o.accountId, 'owner_identity_mismatch');
export const dailyCampaignSchema = z.strictObject({ version: campaignVersionSchema, snapshotHash: z.string().regex(/^[a-f0-9]{64}$/), caps: z.array(campaignCapSnapshotSchema), enrollments: z.array(enrollmentSchema) }).refine(c => c.caps.every(cap => cap.campaignVersionId === c.version.id) && c.enrollments.every(e => e.campaignVersionId === c.version.id && c.version.cohortAccountIds.includes(e.accountId)), 'campaign_identity_mismatch');
export const dailyIssueSchema = z.strictObject({ code: z.enum(['scope_unknown', 'scope_mismatch', 'invalid_local_record', 'research_failed', 'call_allocation_unconfigured', 'call_due_unknown', 'transport_incomplete', 'workload_conflict']), count: revision.positive() });
export const dailyTransportSchema = z.strictObject({ pairingId: id, revision: revision.positive(), state: z.enum(['pending', 'complete', 'failed']), startedAt: instant, completedAt: instant.nullable() })
  .refine(t => (t.state === 'complete') === (t.completedAt !== null));
/** A callback David promised on a call (schema 29). `dueOn` is a plain local date in the firm's zone,
 *  never an instant, because the promise is "I will call you back on that day", not at a moment. */
export const accountCallbackSchema = z.strictObject({ id, accountId: id, dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().min(1).max(10000).nullable(), state: z.enum(['open', 'done', 'cancelled']), revision: revision.positive(),
  sourceCommandId: id, createdAt: instant, updatedAt: instant });
export type AccountCallback = z.infer<typeof accountCallbackSchema>;
export const dailyCallSettingsSchema = z.strictObject({ newCallSlots: revision.nullable(), totalCallCapacity: revision.nullable() });
/** What Today planned with: the typed number, or the workspace default (30 new firms a day) when Settings is unconfigured.
 *  Derived from `callSettings` and kept outside the revision hash, so stored snapshots and their revisions are unchanged. */
export const dailyCallAllocationSchema = z.strictObject({ newCallSlots: revision, source: z.enum(['default', 'configured']) });
export const dailySnapshotSchema = z.strictObject({ workspaceId: id.nullable(), workflowMode: z.enum(['legacy', 'meeting_first', 'unknown']), revision: z.string().regex(/^[a-f0-9]{64}$/),
  freshness: z.strictObject({ kind: z.enum(['local_snapshot', 'incomplete']), generatedAt: instant, remote: z.literal('unknown') }),
  accounts: z.array(dailyAccountSchema), calls: dailyAccountCallPlanSchema, callSettings: dailyCallSettingsSchema, allocation: dailyCallAllocationSchema.optional(),
  /** The derived weekly summary. Like `allocation` it stays outside the revision hash, so measuring
   *  use never changes a stored snapshot revision. Absent when it could not be derived, never zeroed. */
  usage: usageSummarySchema.optional(),
  answers: z.array(dailyAnswerSchema), campaigns: z.array(dailyCampaignSchema), ownerStatus: z.array(dailyOwnerStatusSchema), transport: z.array(dailyTransportSchema), issues: z.array(dailyIssueSchema).max(8),
  /** Open promised callbacks for the listed firms. Absent when there are none, so a workspace with no callback keeps its exact stored revision. */
  callbacks: z.array(accountCallbackSchema).optional() }).refine(s => {
  const ids = new Set(s.accounts.map(a => a.account.id));
  return ids.size === s.accounts.length
    && (s.workspaceId !== null || !s.accounts.length && !s.answers.length && !s.campaigns.length && !s.ownerStatus.length && !s.transport.length)
    && s.accounts.every(a => a.routes.every(r => r.accountId === a.account.id))
    && s.calls.accountIds.every(id => ids.has(id))
    && [...s.answers, ...s.ownerStatus].every(item => ids.has(item.accountId))
    && (s.callbacks ?? []).every(callback => ids.has(callback.accountId))
    && s.answers.every(a => a.kind !== 'manual_linkedin' || a.draft.workspaceId === s.workspaceId)
    && s.campaigns.every(c => c.version.cohortAccountIds.every(id => ids.has(id)));
}, 'daily_scope_mismatch').transform(s => ({ ...s, answers: s.answers.map(a => {
  if (a.kind === 'reply' || !a.presentation || a.presentation.binding.workspaceId === s.workspaceId && a.presentation.asOf === s.freshness.generatedAt) return a;
  const { presentation, ...saved } = a;
  void presentation;
  return saved as typeof a;
}) }));
export type DailySnapshot = z.infer<typeof dailySnapshotSchema>;
export type DailyAnswer = z.infer<typeof dailyAnswerSchema>;
export type DailyIssue = z.infer<typeof dailyIssueSchema>;
export interface DailyApi { get(): Promise<DailySnapshot>; }
