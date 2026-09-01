import type { TodayItem } from '../../../shared/contracts/todayContract';
import { humanizeEnumLabel } from '../../../shared/displayText';
import { formatDueTimestamp } from './relativeTime';

/**
 * Lane-reason labels that read better than the mechanical Sentence-case
 * fallback. Anything unknown still goes through humanizeEnumLabel, so raw
 * machine enums such as `non_discretionary_overdue` can never render.
 */
const TODAY_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  won_onboarding: 'Onboard now',
  inbound_inside_sla: 'Fresh inbound',
  inbound_sla_breached: 'Inbound SLA breached',
  post_stage_due_today: 'Promised follow-up due today',
  ready_p0: 'Ready · P0',
  ready_p1: 'Ready · P1',
  ready_p2: 'Ready · P2',
  ready_p3: 'Ready · P3',
  future_promise: 'Promised later',
  capacity_overflow: 'Over dial budget',
  exploration_quota_overflow: 'Beyond exploration slots',
});

export const humanizeTodayReason = (reason: string): string =>
  TODAY_REASON_LABELS[reason] ?? humanizeEnumLabel(reason);

/**
 * The hero second line of a queue row: why the row is here, what to do, and
 * a relative due time. One line, humanized enums only.
 */
export const reasonLineFor = (item: TodayItem, now?: Date): string => {
  const parts = [
    humanizeTodayReason(item.reason),
    item.action.label,
    formatDueTimestamp(item.action.dueAt, now),
  ];
  if (item.consentRequirement !== null) {
    parts.push(item.consentRequirement);
  }
  return parts.join(' · ');
};
