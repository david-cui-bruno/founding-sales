import { accountInstantSchema } from '../../../shared/contracts/accountContract';
import { campaignVersionSchema, enrollmentSchema, stepEvidenceSchema, type CampaignVersion, type Enrollment, type StepEvidence, type CampaignDecision } from '../../../shared/contracts/campaignContract';

export function evaluateNoReply(input: { channel: 'call' | 'email' | 'linkedin'; observation?: 'unknown' | 'no_reply' | 'replied' }): 'eligible' | 'wait' | 'stop' {
  return input.observation === 'replied' ? 'stop' : input.observation === 'no_reply' ? 'eligible' : 'wait';
}
const actual = (e: StepEvidence) => e.state === 'human_reported_sent' || e.state === 'provider_accepted';
/** Pure candidate planning. Reservations, execution windows and owner authorization are separate final gates. */
export function planNext(versionInput: CampaignVersion, enrollmentInput: Enrollment, evidenceInput: StepEvidence[], nowInput: string): CampaignDecision {
  const version = campaignVersionSchema.parse(versionInput); const enrollment = enrollmentSchema.parse(enrollmentInput);
  const evidence = evidenceInput.map(e => stepEvidenceSchema.parse(e)); const now = accountInstantSchema.parse(nowInput);
  const wait = (reason: string, stepId: string | null = enrollment.currentStepId): CampaignDecision => ({ kind: 'wait', stepId, reason });
  if (!version.approvedAt || version.approvedAt > now) return wait('campaign_unapproved', null);
  if (enrollment.state !== 'active') return wait('enrollment_inactive', null);
  if (version.id !== enrollment.campaignVersionId || !version.cohortAccountIds.includes(enrollment.accountId)) return wait('campaign_binding_mismatch', null);
  const observed = evidence.filter(e => e.observedAt <= now && e.observedAt >= enrollment.startedAt);
  if (observed.some(e => e.observation === 'replied' || ['reply', 'booked', 'opt_out'].includes(e.outcome))) {
    return { kind: 'stop', stepId: null, reason: 'conversation_started' };
  }
  const exact = observed.filter(e => e.routeId === enrollment.selectedRouteId && e.routeVersion === enrollment.selectedRouteVersion && e.contextRevision === enrollment.contextRevision && e.executionContextId === enrollment.executionContextId);
  let index = version.steps.findIndex(s => s.id === enrollment.currentStepId);
  if (index < 0) return wait('step_missing');
  const current = version.steps[index];
  if (!current) return wait('step_missing');
  const currentEvidence = exact.filter(e => e.stepId === current.id).sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  const last = currentEvidence[0];
  if (evidence.some(e => e.stepId === current.id) && !last) return wait('evidence_not_current');
  if (last && !actual(last)) return wait('outcome_unresolved');
  if (last) index += 1;
  const step = version.steps[index];
  if (!step) return { kind: 'stop', stepId: null, reason: 'sequence_completed' };
  const prerequisite = last ?? exact.filter(e => e.stepId === version.steps[index - 1]?.id && actual(e)).sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
  if (step.condition !== 'initial') {
    if (!prerequisite) return wait('evidence_missing', step.id);
    if (step.condition === 'no_reply' && evaluateNoReply({ channel: prerequisite.channel, observation: prerequisite.observation }) !== 'eligible') return wait('no_reply_unconfirmed', step.id);
    if (step.condition === 'requested_info' && prerequisite.outcome !== 'requested_info') return wait('requested_info_unconfirmed', step.id);
  }
  const base = prerequisite?.observedAt ?? enrollment.startedAt;
  if (Date.parse(now) < Date.parse(base) + step.delayHours * 3600000) return wait('delay_not_elapsed', step.id);
  const attempts = new Set(observed.filter(e => actual(e) && e.channel === step.channel).map(e => e.actionId));
  if (attempts.size >= version.channelCaps[step.channel]) return wait('channel_cap_reached', step.id);
  return { kind: 'prepare', stepId: step.id, reason: 'step_eligible' };
}
