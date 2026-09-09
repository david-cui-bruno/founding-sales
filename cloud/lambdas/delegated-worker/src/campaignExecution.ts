import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { enrollmentSchema, campaignCapSnapshotSchema, type CampaignCapSnapshot } from '../../../../src/shared/contracts/campaignContract';
import { planNext } from '../../../../src/main/domain/campaign/sequencePlanner';
import { fingerprint } from './dynamoStore';
import { WorkerCampaignRepository, campaignExecutionInputSchema, campaignActionApprovalSchema, campaignActionApprovalKey, campaignEnrollmentKey,
  campaignVersionKey, campaignApprovalKey, campaignCapKey, campaignCapSchema, campaignReservationKey, type CampaignExecutionInput } from './workerCampaignRepository';

export type CampaignExecutionPlan = { cap: CampaignCapSnapshot; checks: TransactWriteItem[]; consume: TransactWriteItem[]; finalize(): TransactWriteItem[] };
/** Concrete persisted policy binding shared by C4 reservation and C6 manual tokens. Never dispatches. */
export class CampaignExecution {
  constructor(readonly repository: WorkerCampaignRepository) {}
  async prepareManualChecks(input: CampaignExecutionInput): Promise<CampaignExecutionPlan> {
    if (input.channel === 'email') throw new Error('manual_channel_invalid');
    return this.prepareDispatchChecks(input);
  }
  async prepareDispatchChecks(raw: CampaignExecutionInput): Promise<CampaignExecutionPlan> {
    const input = campaignExecutionInputSchema.parse(raw); const repo = this.repository; const store = repo.store; store.workspace(input.workspaceId);
    const enrollmentRow = await repo.required(campaignEnrollmentKey(input.enrollmentId)); const enrollment = enrollmentSchema.parse(enrollmentRow.data);
    if (enrollment.accountId !== input.accountId || enrollment.version !== input.enrollmentRevision || enrollment.state !== 'active'
      || enrollment.selectedRouteId !== input.selectedRouteId || enrollment.executionContextId !== input.contextRevision) throw new Error('campaign_binding_mismatch');
    const { version, row: versionRow, approvalRow } = await repo.approvedVersion(enrollment.campaignVersionId);
    if (version.campaignId !== input.campaignId || version.version !== input.campaignRevision || !version.cohortAccountIds.includes(input.accountId)) throw new Error('campaign_binding_mismatch');
    const actionKey = campaignActionApprovalKey(input.accountId, input.actionId); const actionRow = await store.get<unknown>(actionKey);
    if (!actionRow) throw new Error('campaign_content_unapproved');
    const action = campaignActionApprovalSchema.parse(actionRow.data);
    const { approvedAt, expiresAt, ...identity } = action;
    if (fingerprint(identity) !== fingerprint(input)) throw new Error('campaign_content_unapproved');
    const evidence = await repo.evidence(enrollment.id);
    const decision = planNext(version, enrollment, evidence, store.now());
    const step = version.steps.find(s => s.id === input.stepId);
    if (decision.kind !== 'prepare' || decision.stepId !== input.stepId || step?.channel !== input.channel) throw new Error('campaign_step_ineligible');
    const route = await repo.accountRoute(input.accountId, input.selectedRouteId);
    if (route.route.version !== enrollment.selectedRouteVersion || route.route.channel !== (input.channel === 'call' ? 'phone' : input.channel)) throw new Error('campaign_route_mismatch');
    const capKey = campaignCapKey(version.id, input.channel); const capRow = await repo.required(capKey); const cap = campaignCapSchema.parse(capRow.data);
    if (cap.reserved + cap.sent >= version.channelCaps[input.channel]) throw new Error('campaign_cap_reached');
    // Enrollment CAS also fences concurrently appended outcomes and context changes.
    const checks = [store.check(campaignEnrollmentKey(enrollment.id), enrollmentRow.rev), store.check(campaignVersionKey(version.id), versionRow.rev),
      store.check(campaignApprovalKey(version.id), approvalRow.rev), store.check(actionKey, actionRow.rev), store.check(route.key, route.row.rev)];
    const consume = [store.put(`CAMPAIGN_STEP_RESERVATION#${encodeURIComponent(enrollment.id)}#${encodeURIComponent(input.stepId)}`, { actionId: input.actionId }, null),
      store.put(capKey, { ...cap, reserved: cap.reserved + 1 }, capRow.rev), store.put(campaignReservationKey(input.accountId, input.actionId),
      { input, campaignVersionId: version.id, routeVersion: enrollment.selectedRouteVersion, numericContextRevision: enrollment.contextRevision, state: 'reserved' }, null)];
    return { cap: campaignCapSnapshotSchema.parse({ campaignVersionId: version.id, channel: input.channel, revision: capRow.rev + 1, reserved: cap.reserved + 1, sent: cap.sent }), checks, consume, finalize() {
      const now = store.now();
      if (now < approvedAt || now >= expiresAt) throw new Error('campaign_evidence_expired');
      if (planNext(version, enrollment, evidence, now).kind !== 'prepare') throw new Error('campaign_step_ineligible');
      return [...checks, ...consume];
    } };
  }
}
