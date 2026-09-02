import { describe, expect, it } from 'vitest';

import {
  fitBandSchema,
  leadPriorityContextSchema,
  lifecycleStageSchema,
  mutationReceiptSchema,
  personIdSchema,
  primaryActionSchema,
  prioritySchema,
  reachabilitySchema,
  salesCycleIdSchema,
  timingBandSchema,
} from '../../src/shared/contracts/commonContract';

describe('workflow common contracts', () => {
  it('accepts separate Fit and Timing fields', () => {
    expect(leadPriorityContextSchema.parse({
      priority: 'P0', fitPoints: 24, fitBand: 'high', timingValue: 31,
      timingBand: 'hot', reachability: 'direct', dataConfidence: 8,
    })).toMatchObject({ priority: 'P0', fitPoints: 24, timingValue: 31 });
  });

  it.each(['score', 'leadScore', 'weightedScore'])('rejects forbidden %s', (key) => {
    expect(() => leadPriorityContextSchema.parse({
      priority: 'P1', fitPoints: 18, fitBand: 'medium', timingValue: 24,
      timingBand: 'hot', reachability: 'direct', dataConfidence: 7, [key]: 88,
    })).toThrow();
  });

  it('bounds fitPoints to 0-30 and timingValue to 0-40', () => {
    const base = {
      priority: 'P2', fitBand: 'low', timingBand: 'cold',
      reachability: 'none', dataConfidence: 0,
    };

    expect(() => leadPriorityContextSchema.parse({
      ...base, fitPoints: 31, timingValue: 12,
    })).toThrow();
    expect(() => leadPriorityContextSchema.parse({
      ...base, fitPoints: 12, timingValue: 41,
    })).toThrow();
    expect(() => leadPriorityContextSchema.parse({
      ...base, fitPoints: -1, timingValue: 12,
    })).toThrow();
  });

  it('requires nonnegative mutation revisions', () => {
    expect(() => mutationReceiptSchema.parse({
      revision: -1, affectedPersonIds: [], affectedSalesCycleIds: [],
    })).toThrow();
  });

  it('accepts a mutation receipt with affected identifiers', () => {
    expect(mutationReceiptSchema.parse({
      revision: 4,
      affectedPersonIds: ['person-1'],
      affectedSalesCycleIds: ['cycle-1', 'cycle-2'],
    })).toEqual({
      revision: 4,
      affectedPersonIds: ['person-1'],
      affectedSalesCycleIds: ['cycle-1', 'cycle-2'],
    });
  });

  it('rejects unknown mutation receipt fields', () => {
    expect(() => mutationReceiptSchema.parse({
      revision: 1, affectedPersonIds: [], affectedSalesCycleIds: [], score: 50,
    })).toThrow();
  });

  it('rejects empty identifiers', () => {
    expect(() => personIdSchema.parse('')).toThrow();
    expect(() => salesCycleIdSchema.parse('')).toThrow();
  });

  it('keeps the lifecycle fixed', () => {
    expect(lifecycleStageSchema.options).toEqual([
      'unreviewed', 'ready', 'contacted', 'interviewed', 'offered', 'won', 'lost_nurture',
    ]);
    expect(() => lifecycleStageSchema.parse('custom_stage')).toThrow();
  });

  it('restricts priority, band, and reachability vocabularies', () => {
    expect(prioritySchema.options).toEqual(['P0', 'P1', 'P2', 'P3']);
    expect(fitBandSchema.options).toEqual(['low', 'medium', 'high']);
    expect(timingBandSchema.options).toEqual(['cold', 'warm', 'hot']);
    expect(reachabilitySchema.options).toEqual(['direct', 'indirect', 'none']);
  });

  it('accepts a strict primary action without due semantics', () => {
    expect(primaryActionSchema.parse({
      id: 'action-1',
      type: 'first_call',
      channel: 'call',
      label: 'Call Dana',
    })).toMatchObject({ id: 'action-1', channel: 'call' });
  });

  it('rejects a primary action with an unknown channel or extra keys', () => {
    expect(() => primaryActionSchema.parse({
      id: 'action-1', type: 'first_call', channel: 'fax',
      label: 'Call Dana',
    })).toThrow();
    expect(() => primaryActionSchema.parse({
      id: 'action-1', type: 'first_call', channel: 'call',
      dueAt: '2026-08-30T12:00:00.000Z', label: 'Call Dana', overdue: false,
      leadScore: 90,
    })).toThrow();
  });
});
