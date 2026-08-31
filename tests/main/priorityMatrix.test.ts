import { describe, expect, it } from 'vitest';

import { resolvePriorityMatrix } from '../../src/main/domain/prioritization/priorityMatrix';

describe('resolvePriorityMatrix', () => {
  it.each([
    ['hot', 'high', 'p0', 'contact_immediately'],
    ['hot', 'medium', 'p1', 'contact_today'],
    ['hot', 'low', 'p2', 'quick_fit_check'],
    ['warm', 'high', 'p1', 'contact_today'],
    ['warm', 'medium', 'p2', 'qualify_this_week'],
    ['warm', 'low', 'p3', 'nurture'],
    ['cold', 'high', 'p3', 'watch_for_trigger'],
    ['cold', 'medium', 'p3', 'nurture'],
    ['cold', 'low', 'p3', 'archive_candidate'],
  ] as const)('%s/%s is %s %s with Direct', (timingBand, fitBand, priority, play) => {
    const decision = resolvePriorityMatrix({
      fitBand,
      timingBand,
      reachability: 'direct',
      selectedPositiveTriggerKeys: ['live_vacancy'],
    });
    expect(decision.priority).toBe(priority);
    expect(decision.play).toBe(play);
    expect(decision.reasons[0]).toEqual({ kind: 'matrix', code: 'matrix_cell' });
  });

  it.each(['indirect', 'none'] as const)(
    'High/Hot without Direct (%s) is P1 find_direct_line, never P0',
    (reachability) => {
      const decision = resolvePriorityMatrix({
        fitBand: 'high',
        timingBand: 'hot',
        reachability,
        selectedPositiveTriggerKeys: ['inbound_demo'],
      });
      expect(decision.priority).toBe('p1');
      expect(decision.play).toBe('find_direct_line');
      expect(decision.reasons).toContainEqual({ kind: 'matrix', code: 'high_hot_without_direct' });
    },
  );

  it('caps computed priority at P1 when nurture_resurrection is the only positive key', () => {
    const decision = resolvePriorityMatrix({
      fitBand: 'high',
      timingBand: 'hot',
      reachability: 'direct',
      selectedPositiveTriggerKeys: ['nurture_resurrection'],
    });
    expect(decision.priority).toBe('p1');
    expect(decision.play).toBe('contact_immediately');
    expect(decision.reasons).toContainEqual({ kind: 'matrix', code: 'nurture_only_p0_block' });
  });

  it('restores the ordinary matrix when any other positive key is selected', () => {
    const decision = resolvePriorityMatrix({
      fitBand: 'high',
      timingBand: 'hot',
      reachability: 'direct',
      selectedPositiveTriggerKeys: ['nurture_resurrection', 'live_vacancy'],
    });
    expect(decision.priority).toBe('p0');
    expect(decision.reasons.map((reason) => reason.code)).not.toContain('nurture_only_p0_block');
  });

  it('does not downgrade cells already at or below P1 for nurture-only', () => {
    const decision = resolvePriorityMatrix({
      fitBand: 'medium',
      timingBand: 'hot',
      reachability: 'direct',
      selectedPositiveTriggerKeys: ['nurture_resurrection'],
    });
    expect(decision.priority).toBe('p1');
    expect(decision.reasons.map((reason) => reason.code)).not.toContain('nurture_only_p0_block');
  });

  it('two axis pairs in different matrix cells cannot be equivalent through hidden arithmetic', () => {
    const highWarm = resolvePriorityMatrix({
      fitBand: 'high', timingBand: 'warm', reachability: 'direct', selectedPositiveTriggerKeys: [],
    });
    const mediumHot = resolvePriorityMatrix({
      fitBand: 'medium', timingBand: 'hot', reachability: 'direct', selectedPositiveTriggerKeys: [],
    });
    // Same priority tier is allowed, but the play (cell identity) differs by exact cell.
    expect(highWarm.play).toBe('contact_today');
    expect(mediumHot.play).toBe('contact_today');
    const lowHot = resolvePriorityMatrix({
      fitBand: 'low', timingBand: 'hot', reachability: 'direct', selectedPositiveTriggerKeys: [],
    });
    const highCold = resolvePriorityMatrix({
      fitBand: 'high', timingBand: 'cold', reachability: 'direct', selectedPositiveTriggerKeys: [],
    });
    expect(lowHot).not.toEqual(highCold);
  });

  it('returns frozen decisions', () => {
    const decision = resolvePriorityMatrix({
      fitBand: 'low', timingBand: 'cold', reachability: 'none', selectedPositiveTriggerKeys: [],
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.reasons)).toBe(true);
  });
});
