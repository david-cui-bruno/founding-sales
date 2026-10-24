import { describe, expect, it } from 'vitest';
import {
  retainedIdentityDecisionCommandSchema,
  retainedInterpretationCommandSchema,
} from '../src/sourcingRetainedRecovery.ts';

const id = '11111111-1111-4111-8111-111111111111';
const citation = { observationId: id, blockId: 'b1', contentHash: 'a'.repeat(64), relevantTextHash: 'b'.repeat(64) };
const base = { commandId: id, clientVersion: '1.0.47', candidateId: id, expectedRevision: 1, qualificationRunId: id };
const identity = { ...base, ...citation, nameStart: 0, nameEnd: 12,
  decision: 'confirm_literal_trade_name', acknowledged: 'identity_only_not_qualification' };
const interpretation = { ...base, decisionId: id,
  selections: [{ ...citation, kind: 'firm_identity' }],
  acknowledged: 'new_retained_interpretation_not_original_model_result' };

describe('retained recovery closed wire contracts', () => {
  it('accepts bounded identifiers and exact literal offsets without prose', () => {
    expect(retainedIdentityDecisionCommandSchema.safeParse(identity).success).toBe(true);
    expect(retainedInterpretationCommandSchema.safeParse(interpretation).success).toBe(true);
  });
  it('preserves span refinements through the command envelope', () => {
    for (const [nameStart, nameEnd] of [[12, 12], [13, 12], [-1, 12], [0, 2001]])
      expect(retainedIdentityDecisionCommandSchema.safeParse({ ...identity, nameStart, nameEnd }).success).toBe(false);
  });
  it('refuses prose, authority and rewritten fact values in custody inputs', () => {
    expect(retainedIdentityDecisionCommandSchema.safeParse({ ...identity, firmName: 'Example' }).success).toBe(false);
    expect(retainedIdentityDecisionCommandSchema.safeParse({ ...identity, workspaceId: id }).success).toBe(false);
    expect(retainedInterpretationCommandSchema.safeParse({ ...interpretation,
      selections: [{ ...citation, kind: 'firm_identity', value: 'Example' }] }).success).toBe(false);
  });
  it('refuses duplicate roles, unknown kinds, missing acknowledgment and unbounded selection', () => {
    const selection = interpretation.selections[0];
    for (const selections of [[], [selection, selection], [{ ...citation, kind: 'verified_legal_identity' }],
      Array.from({ length: 31 }, (_, n) => ({ ...selection, blockId: `b${n}` }))])
      expect(retainedInterpretationCommandSchema.safeParse({ ...interpretation, selections }).success).toBe(false);
    expect(retainedInterpretationCommandSchema.safeParse({ ...interpretation, acknowledged: undefined }).success).toBe(false);
  });
  it('refuses noncanonical hashes and unacknowledged identity decisions', () => {
    expect(retainedIdentityDecisionCommandSchema.safeParse({ ...identity, contentHash: 'A'.repeat(64) }).success).toBe(false);
    expect(retainedIdentityDecisionCommandSchema.safeParse({ ...identity, decision: 'verified' }).success).toBe(false);
  });
});
