import { describe, expect, it } from 'vitest';

import {
  PRIORITY_ORDERABLE_SQL_ALIAS,
  PROSPECT_PRIORITY_ORDER_BY_SQL,
  buildProspectPriorityTuple,
  compareProspectPriority,
  toOrderablePriorityRow,
} from '../../src/main/domain/prioritization/priorityOrdering';
import type {
  EffectivePrioritySnapshot,
  OrderablePriorityRow,
} from '../../src/main/domain/prioritization/prioritizationTypes';
import { PrioritizationInputCorruptionError } from '../../src/main/domain/support/domainErrors';

const BASE_ROW: OrderablePriorityRow = Object.freeze({
  prospectId: 'prospect-a',
  effectivePriority: 'p1',
  earliestTriggerExpiresAt: '2026-09-01T00:00:00.000Z',
  timingMilliPoints: 12_000,
  fitPoints: 15,
  reachability: 'direct',
  dataConfidence: 7,
  lastContactAt: '2026-08-01T00:00:00.000Z',
});

function row(overrides: Partial<OrderablePriorityRow>): OrderablePriorityRow {
  return Object.freeze({ ...BASE_ROW, ...overrides });
}

describe('buildProspectPriorityTuple', () => {
  it('builds the exact ten-element tuple, never a scalar', () => {
    const tuple = buildProspectPriorityTuple(BASE_ROW);
    expect(tuple).toEqual([
      1,
      0,
      Date.parse('2026-09-01T00:00:00.000Z'),
      -12_000,
      -15,
      0,
      -7,
      1,
      Date.parse('2026-08-01T00:00:00.000Z'),
      'prospect-a',
    ]);
    expect(tuple).toHaveLength(10);
  });

  it('orders null expiration after non-null and null last contact first', () => {
    const withNulls = buildProspectPriorityTuple(row({
      earliestTriggerExpiresAt: null, lastContactAt: null,
    }));
    expect(withNulls[1]).toBe(1);
    expect(withNulls[7]).toBe(0);
  });

  it('throws on invalid canonical timestamps', () => {
    expect(() => buildProspectPriorityTuple(row({
      earliestTriggerExpiresAt: '2026-09-01T00:00:00Z',
    }))).toThrow(PrioritizationInputCorruptionError);
  });
});

describe('compareProspectPriority', () => {
  it('orders by priority, expiration, timing, fit, reachability, confidence, last contact, id', () => {
    const ordered: OrderablePriorityRow[] = [
      row({ prospectId: 'r1', effectivePriority: 'p0' }),
      row({ prospectId: 'r2', earliestTriggerExpiresAt: '2026-08-15T00:00:00.000Z' }),
      row({ prospectId: 'r3' }),
      row({ prospectId: 'r4', earliestTriggerExpiresAt: null, timingMilliPoints: 20_000 }),
      row({ prospectId: 'r5', earliestTriggerExpiresAt: null }),
      row({ prospectId: 'r6', earliestTriggerExpiresAt: null, fitPoints: 10 }),
      row({ prospectId: 'r7', earliestTriggerExpiresAt: null, fitPoints: 10, reachability: 'indirect' }),
      row({ prospectId: 'r8', earliestTriggerExpiresAt: null, fitPoints: 10, reachability: 'indirect', dataConfidence: 3 }),
      row({ prospectId: 'r9', earliestTriggerExpiresAt: null, fitPoints: 10, reachability: 'indirect', dataConfidence: 3, lastContactAt: null }),
    ];
    // r9 has null last contact so it precedes r8 within otherwise-equal keys.
    const expected = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r9', 'r8'];
    const shuffled = [...ordered].reverse();
    const sorted = shuffled.sort(compareProspectPriority).map((entry) => entry.prospectId);
    expect(sorted).toEqual(expected);
  });

  it('breaks complete ties by binary prospect ID', () => {
    const left = row({ prospectId: 'a' });
    const right = row({ prospectId: 'b' });
    expect(compareProspectPriority(left, right)).toBeLessThan(0);
    expect(compareProspectPriority(right, left)).toBeGreaterThan(0);
    expect(compareProspectPriority(left, row({ prospectId: 'a' }))).toBe(0);
  });

  it('orders oldest last contact first among contacted rows', () => {
    const older = row({ prospectId: 'older', lastContactAt: '2026-07-01T00:00:00.000Z' });
    const newer = row({ prospectId: 'newer', lastContactAt: '2026-08-01T00:00:00.000Z' });
    expect(compareProspectPriority(older, newer)).toBeLessThan(0);
  });
});

describe('toOrderablePriorityRow', () => {
  const snapshot: EffectivePrioritySnapshot = Object.freeze({
    prospectId: 'prospect-a',
    ruleVersionId: 'rule-1',
    evaluationId: 'evaluation-1',
    projectionVersion: 3,
    evaluatedAt: '2026-08-30T00:00:00.000Z',
    asOf: '2026-08-31T00:00:00.000Z',
    computedPriority: 'p1',
    effectivePriority: 'p0',
    computedPlay: 'contact_today',
    fitPoints: 15,
    fitBand: 'medium',
    timingMilliPoints: 12_000,
    timingBand: 'warm',
    reachability: 'direct',
    dataConfidence: 7,
    earliestTriggerExpiresAt: '2026-09-01T00:00:00.000Z',
    verifyFirst: false,
    lastContactActivityId: 'activity-1',
    lastContactAt: '2026-08-01T00:00:00.000Z',
    controls: { priority: null, pin: null, snooze: null, dismiss: null },
    explanation: [],
  }) as EffectivePrioritySnapshot;

  it('projects the exact effective-priority ordering fields', () => {
    expect(toOrderablePriorityRow(snapshot)).toEqual({
      prospectId: 'prospect-a',
      effectivePriority: 'p0',
      earliestTriggerExpiresAt: '2026-09-01T00:00:00.000Z',
      timingMilliPoints: 12_000,
      fitPoints: 15,
      reachability: 'direct',
      dataConfidence: 7,
      lastContactAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('rejects a torn last-contact pair', () => {
    expect(() => toOrderablePriorityRow({
      ...snapshot,
      lastContactActivityId: null,
    } as EffectivePrioritySnapshot)).toThrow(PrioritizationInputCorruptionError);
  });
});

describe('fixed SQL ordering contract', () => {
  it('refers only to the fixed alias and exact columns', () => {
    expect(PRIORITY_ORDERABLE_SQL_ALIAS).toBe('priority_orderable');
    const aliasReferences = PROSPECT_PRIORITY_ORDER_BY_SQL.match(/\b[a-z_]+\.[a-z_]+/g) ?? [];
    const allowed = new Set([
      'priority_orderable.prospect_id',
      'priority_orderable.effective_priority',
      'priority_orderable.earliest_trigger_expires_at',
      'priority_orderable.timing_millipoints',
      'priority_orderable.fit_points',
      'priority_orderable.reachability',
      'priority_orderable.data_confidence',
      'priority_orderable.last_contact_at',
    ]);
    expect(aliasReferences.length).toBeGreaterThan(0);
    for (const reference of aliasReferences) {
      expect(allowed.has(reference), `unexpected column reference: ${reference}`).toBe(true);
    }
    expect(PROSPECT_PRIORITY_ORDER_BY_SQL).toContain('COLLATE BINARY');
    expect(PROSPECT_PRIORITY_ORDER_BY_SQL).not.toMatch(/now|current_time|score/i);
  });
});
