import { describe, expect, it } from 'vitest';

import { discoveryClaimSchema, discoveryEvidenceRefSchema } from '../../src/shared/contracts/discoveryContract';
import { evidence } from '../fixtures/discoveryEvidence';

const AS_OF = '2026-09-06T12:00:00.000Z';

describe('discovery evidence contracts', () => {
  it('requires fact references and strict kind-specific citations without promoting inference', () => {
    const source = evidence().claims[0]!;
    expect(discoveryClaimSchema.safeParse(source).success).toBe(true);
    expect(discoveryClaimSchema.safeParse({ ...source, refs: [] }).success).toBe(false);
    expect(discoveryClaimSchema.parse({ ...source, certainty: 'inference', refs: [] }).certainty).toBe('inference');
    expect(discoveryEvidenceRefSchema.safeParse({ kind: 'activity', activityId: 'activity-1', field: 'note', observedAt: AS_OF }).success).toBe(true);
    const utterance = { kind: 'utterance', activityId: 'activity-1', transcriptId: 'transcript-1', utteranceId: 'utterance-1', quote: 'We handle maintenance ourselves.', observedAt: AS_OF };
    expect(discoveryEvidenceRefSchema.safeParse(utterance).success).toBe(true);
    expect(discoveryEvidenceRefSchema.safeParse({ ...utterance, quote: '' }).success).toBe(false);
    expect(discoveryEvidenceRefSchema.safeParse({ ...utterance, sourceEventId: 'source-1' }).success).toBe(false);
    expect(discoveryClaimSchema.safeParse({ ...source, refs: Array(21).fill(source.refs[0]) }).success).toBe(false);
  });
});
