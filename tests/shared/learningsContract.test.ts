import { describe, expect, it } from 'vitest';

import {
  addEvidenceRequestSchema,
  captureLearningRequestSchema,
  learningCategorySchema,
  learningEvidenceSchema,
  learningRowSchema,
  learningStatusSchema,
  learningsListRequestSchema,
  learningsListResponseSchema,
  updateLearningStatusRequestSchema,
} from '../../src/shared/contracts/learningsContract';

const evidence = {
  id: 'evidence-1',
  personId: 'person-1',
  personName: 'Kevin Ortiz',
  activityId: null as string | null,
  quote: 'We keep losing weekends to showings.',
  notedAt: '2026-08-30T12:00:00.000Z',
};

const row = {
  learningId: 'learning-1',
  category: 'pain',
  statement: 'FRBO owners lose weekends to showings.',
  status: 'active',
  statusReason: null as string | null,
  confidence: 'medium',
  sampleSize: 1,
  firstObservedAt: '2026-08-30T12:00:00.000Z',
  latestObservedAt: '2026-08-30T12:00:00.000Z',
  evidence: [evidence],
  contradictionOf: null as string | null,
  createdAt: '2026-08-30T12:00:00.000Z',
  version: 1,
};

describe('learning category and status enums', () => {
  it('keeps the category vocabulary fixed', () => {
    expect(learningCategorySchema.options).toEqual([
      'pain', 'objection', 'alternative', 'winning_language',
      'pricing_reaction', 'product_request', 'coaching',
      'invalidated_assumption',
    ]);
  });

  it('keeps the status vocabulary fixed', () => {
    expect(learningStatusSchema.options).toEqual([
      'active', 'contradicted', 'retired',
    ]);
  });
});

describe('learningEvidenceSchema', () => {
  it('accepts a person-linked quote', () => {
    expect(learningEvidenceSchema.parse(evidence)).toEqual(evidence);
  });

  it('accepts null person and activity links', () => {
    expect(learningEvidenceSchema.parse({
      ...evidence, personId: null, personName: null, activityId: null,
    })).toMatchObject({ personId: null, personName: null });
  });

  it('rejects an empty quote and quotes above 2000 characters', () => {
    expect(() => learningEvidenceSchema.parse({ ...evidence, quote: '' })).toThrow();
    expect(() => learningEvidenceSchema.parse({
      ...evidence, quote: 'a'.repeat(2001),
    })).toThrow();
  });

  it('requires an offset datetime for notedAt', () => {
    expect(() => learningEvidenceSchema.parse({
      ...evidence, notedAt: 'yesterday',
    })).toThrow();
    expect(learningEvidenceSchema.parse({
      ...evidence, notedAt: '2026-08-30T08:00:00.000-04:00',
    }).notedAt).toBe('2026-08-30T08:00:00.000-04:00');
  });

  it('rejects unknown fields', () => {
    expect(() => learningEvidenceSchema.parse({ ...evidence, score: 3 })).toThrow();
  });
});

describe('learningRowSchema', () => {
  it('accepts a complete learning row', () => {
    expect(learningRowSchema.parse(row)).toEqual(row);
  });

  it('requires at least one evidence row', () => {
    expect(() => learningRowSchema.parse({ ...row, evidence: [] })).toThrow();
  });

  it('bounds the statement to 1..500 characters', () => {
    expect(() => learningRowSchema.parse({ ...row, statement: '' })).toThrow();
    expect(() => learningRowSchema.parse({
      ...row, statement: 'a'.repeat(501),
    })).toThrow();
  });

  it('requires sampleSize >= 1 and a positive version', () => {
    expect(() => learningRowSchema.parse({ ...row, sampleSize: 0 })).toThrow();
    expect(() => learningRowSchema.parse({ ...row, version: 0 })).toThrow();
  });

  it('accepts a contradiction link', () => {
    expect(learningRowSchema.parse({
      ...row, contradictionOf: 'learning-0',
    }).contradictionOf).toBe('learning-0');
  });

  it('rejects unknown fields such as a blended score', () => {
    expect(() => learningRowSchema.parse({ ...row, score: 88 })).toThrow();
  });
});

describe('learningsListRequestSchema', () => {
  it('accepts empty filter arrays meaning all', () => {
    expect(learningsListRequestSchema.parse({
      categories: [], statuses: [], query: '', limit: 200,
    })).toEqual({ categories: [], statuses: [], query: '', limit: 200 });
  });

  it('accepts specific category and status filters', () => {
    expect(learningsListRequestSchema.parse({
      categories: ['pain', 'objection'], statuses: ['active'],
      query: 'weekend', limit: 50,
    }).categories).toEqual(['pain', 'objection']);
  });

  it('bounds query to 200 characters and limit to 1..200', () => {
    expect(() => learningsListRequestSchema.parse({
      categories: [], statuses: [], query: 'a'.repeat(201), limit: 10,
    })).toThrow();
    expect(() => learningsListRequestSchema.parse({
      categories: [], statuses: [], query: '', limit: 0,
    })).toThrow();
    expect(() => learningsListRequestSchema.parse({
      categories: [], statuses: [], query: '', limit: 201,
    })).toThrow();
  });

  it('rejects unknown categories', () => {
    expect(() => learningsListRequestSchema.parse({
      categories: ['vibes'], statuses: [], query: '', limit: 10,
    })).toThrow();
  });
});

describe('learningsListResponseSchema', () => {
  it('accepts rows with nonnegative counts', () => {
    expect(learningsListResponseSchema.parse({
      rows: [row], totalActiveCount: 1, revision: 0,
    }).rows).toHaveLength(1);
  });

  it('rejects negative counts', () => {
    expect(() => learningsListResponseSchema.parse({
      rows: [], totalActiveCount: -1, revision: 0,
    })).toThrow();
    expect(() => learningsListResponseSchema.parse({
      rows: [], totalActiveCount: 0, revision: -1,
    })).toThrow();
  });
});

const captureEvidence = {
  personId: null as string | null,
  activityId: null as string | null,
  quote: 'Manager quoted 8% and they still had to chase him.',
  notedAt: '2026-08-30T12:00:00.000Z',
};

describe('captureLearningRequestSchema', () => {
  const capture = {
    category: 'pricing_reaction',
    statement: 'Owners compare us to 8% full management.',
    confidence: 'low',
    evidence: [captureEvidence],
    contradictionOf: null as string | null,
  };

  it('accepts a manual capture with one evidence row', () => {
    expect(captureLearningRequestSchema.parse(capture)).toEqual(capture);
  });

  it('requires at least one evidence row', () => {
    expect(() => captureLearningRequestSchema.parse({
      ...capture, evidence: [],
    })).toThrow();
  });

  it('accepts a contradiction capture', () => {
    expect(captureLearningRequestSchema.parse({
      ...capture, contradictionOf: 'learning-1',
    }).contradictionOf).toBe('learning-1');
  });

  it('rejects evidence rows carrying derived fields', () => {
    expect(() => captureLearningRequestSchema.parse({
      ...capture, evidence: [{ ...captureEvidence, personName: 'Kevin' }],
    })).toThrow();
  });
});

describe('addEvidenceRequestSchema', () => {
  it('accepts a single evidence append with an expected version', () => {
    expect(addEvidenceRequestSchema.parse({
      learningId: 'learning-1', expectedVersion: 2, evidence: captureEvidence,
    }).expectedVersion).toBe(2);
  });

  it('requires a positive expected version', () => {
    expect(() => addEvidenceRequestSchema.parse({
      learningId: 'learning-1', expectedVersion: 0, evidence: captureEvidence,
    })).toThrow();
  });
});

describe('updateLearningStatusRequestSchema', () => {
  it('requires a non-null reason to mark a learning contradicted', () => {
    expect(() => updateLearningStatusRequestSchema.parse({
      learningId: 'learning-1', expectedVersion: 1,
      status: 'contradicted', reason: null,
    })).toThrow();
    expect(updateLearningStatusRequestSchema.parse({
      learningId: 'learning-1', expectedVersion: 1,
      status: 'contradicted', reason: 'Three owners since said the opposite.',
    }).reason).toBe('Three owners since said the opposite.');
  });

  it('allows retiring and reactivating without a reason', () => {
    expect(updateLearningStatusRequestSchema.parse({
      learningId: 'learning-1', expectedVersion: 3, status: 'retired', reason: null,
    }).status).toBe('retired');
    expect(updateLearningStatusRequestSchema.parse({
      learningId: 'learning-1', expectedVersion: 3, status: 'active', reason: null,
    }).status).toBe('active');
  });

  it('bounds the reason to 500 characters', () => {
    expect(() => updateLearningStatusRequestSchema.parse({
      learningId: 'learning-1', expectedVersion: 1,
      status: 'contradicted', reason: 'a'.repeat(501),
    })).toThrow();
  });

  it('rejects unknown fields', () => {
    expect(() => updateLearningStatusRequestSchema.parse({
      learningId: 'learning-1', expectedVersion: 1,
      status: 'retired', reason: null, force: true,
    })).toThrow();
  });
});
