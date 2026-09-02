import type { TodayItem } from '../../../shared/contracts/todayContract';
import { humanizeEnumLabel } from '../../../shared/displayText';

/**
 * Lane-reason labels that read better than the mechanical Sentence-case
 * fallback. Anything unknown still goes through humanizeEnumLabel, so raw
 * machine enums can never render.
 */
const TODAY_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  won_onboarding: 'Onboard now',
  inbound_inside_sla: 'Fresh inbound',
  inbound_response_waiting: 'Inbound reply waiting',
  cadence_step_next: 'Cadence says this is next',
  promised_follow_up: 'Promised follow-up',
  internal_review_waiting: 'Needs your decision',
  callback_promised_today: 'Callback you promised for today',
  snoozed_until_today: 'Snoozed until today',
  ready_p0: 'Ready · P0',
  ready_p1: 'Ready · P1',
  ready_p2: 'Ready · P2',
  ready_p3: 'Ready · P3',
  capacity_overflow: 'Beyond today’s capacity',
  exploration_quota_overflow: 'Beyond exploration slots',
});

export const humanizeTodayReason = (reason: string): string =>
  TODAY_REASON_LABELS[reason] ?? humanizeEnumLabel(reason);

/**
 * The hero second line of a queue row: why the row is here and what to do.
 * One line, humanized enums only; no timestamps (no-due-dates model).
 */
export const reasonLineFor = (item: TodayItem): string => {
  const parts = [
    humanizeTodayReason(item.reason),
    item.action.label,
  ];
  if (item.consentRequirement !== null) {
    parts.push(item.consentRequirement);
  }
  return parts.join(' · ');
};
