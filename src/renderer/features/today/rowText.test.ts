// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import type { TodayItem } from '../../../shared/contracts/todayContract';
import { humanizeTodayReason, reasonLineFor } from './rowText';

describe('humanizeTodayReason', () => {
  it('never leaks machine enums', () => {
    for (const reason of [
      'won_onboarding', 'inbound_inside_sla', 'inbound_response_waiting',
      'cadence_step_next', 'promised_follow_up', 'internal_review_waiting',
      'callback_promised_today', 'snoozed_until_today',
      'ready_p0', 'ready_p1', 'ready_p2', 'ready_p3',
      'capacity_overflow', 'exploration_quota_overflow',
    ]) {
      expect(humanizeTodayReason(reason)).not.toMatch(/_/);
    }
    expect(humanizeTodayReason('callback_promised_today'))
      .toBe('Callback you promised for today');
    expect(humanizeTodayReason('snoozed_until_today')).toBe('Snoozed until today');
    expect(humanizeTodayReason('ready_p0')).toBe('Ready · P0');
  });
});

describe('reasonLineFor', () => {
  const item: TodayItem = {
    id: 'cycle-1',
    lane: 'due_cadence',
    personId: 'person-1',
    salesCycleId: 'cycle-1',
    personName: 'Avery Landlord',
    contextLabel: null,
    stage: 'ready',
    priorityContext: null,
    action: {
      id: 'action-1',
      type: 'call',
      channel: 'call',
      label: 'Call',
    },
    reason: 'cadence_step_next',
    activeTriggers: [],
    verifyFirst: false,
    pinned: false,
    consentRequirement: null,
  };

  it('joins the humanized reason and action with middots, no timestamps', () => {
    expect(reasonLineFor(item)).toBe('Cadence says this is next · Call');
  });

  it('appends the consent requirement when present', () => {
    expect(
      reasonLineFor({ ...item, consentRequirement: 'Verbal consent required' }),
    ).toBe('Cadence says this is next · Call · Verbal consent required');
  });
});
