// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import type { TodayItem } from '../../../shared/contracts/todayContract';
import { formatDueTimestamp } from './relativeTime';
import { humanizeTodayReason, reasonLineFor } from './rowText';

// Noon local time; jsdom runs in the process timezone, so derive expectations
// with the same locale formatting the implementation uses.
const NOW = new Date('2026-08-31T16:00:00.000Z');

describe('formatDueTimestamp', () => {
  it('renders a clock time for later today', () => {
    const due = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
    const expected = `due ${due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    expect(formatDueTimestamp(due.toISOString(), NOW)).toBe(expected);
  });

  it('renders relative ago-times once overdue', () => {
    expect(
      formatDueTimestamp(new Date(NOW.getTime() - 10 * 60_000).toISOString(), NOW),
    ).toBe('due 10m ago');
    expect(
      formatDueTimestamp(new Date(NOW.getTime() - 2 * 3_600_000).toISOString(), NOW),
    ).toBe('due 2h ago');
    expect(
      formatDueTimestamp(new Date(NOW.getTime() - 3 * 86_400_000).toISOString(), NOW),
    ).toBe('due 3d ago');
  });

  it('renders due now at the boundary and a weekday within the week', () => {
    expect(formatDueTimestamp(NOW.toISOString(), NOW)).toBe('due now');
    const inTwoDays = new Date(NOW.getTime() + 2 * 86_400_000);
    const expected = `due ${inTwoDays.toLocaleDateString([], { weekday: 'short' })}`;
    expect(formatDueTimestamp(inTwoDays.toISOString(), NOW)).toBe(expected);
  });
});

describe('humanizeTodayReason', () => {
  it('never leaks machine enums', () => {
    for (const reason of [
      'won_onboarding', 'inbound_inside_sla', 'non_discretionary_overdue',
      'inbound_sla_breached', 'post_stage_due_today',
      'other_non_discretionary_due_today', 'ready_p0', 'ready_p1', 'ready_p2',
      'ready_p3', 'future_promise', 'capacity_overflow',
      'exploration_quota_overflow',
    ]) {
      expect(humanizeTodayReason(reason)).not.toMatch(/_/);
    }
    expect(humanizeTodayReason('non_discretionary_overdue')).toBe('Overdue');
    expect(humanizeTodayReason('ready_p0')).toBe('Ready · P0');
  });
});

describe('reasonLineFor', () => {
  const item: TodayItem = {
    id: 'cycle-1',
    lane: 'overdue',
    personId: 'person-1',
    salesCycleId: 'cycle-1',
    personName: 'Avery Landlord',
    contextLabel: null,
    stage: 'ready',
    priorityContext: null,
    action: {
      id: 'action-1',
      type: 'review_lead',
      channel: 'review',
      dueAt: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
      label: 'Review lead',
      overdue: true,
    },
    reason: 'non_discretionary_overdue',
    activeTriggers: [],
    verifyFirst: false,
    pinned: false,
    consentRequirement: null,
  };

  it('joins the humanized reason, action, and relative time with middots', () => {
    expect(reasonLineFor(item, NOW)).toBe('Overdue · Review lead · due 2h ago');
  });

  it('appends the consent requirement when present', () => {
    expect(
      reasonLineFor({ ...item, consentRequirement: 'Verbal consent required' }, NOW),
    ).toBe('Overdue · Review lead · due 2h ago · Verbal consent required');
  });
});
