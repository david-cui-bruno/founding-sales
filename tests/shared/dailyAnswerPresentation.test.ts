import { expect, it } from 'vitest';
import { dailyAnswerSchema } from '../../src/shared/contracts/dailyContract';
import { requestedFollowupFixture } from '../fixtures/requestedFollowup';

it('accepts optional bound presentation without changing saved draft or approval', () => {
  const { draft } = requestedFollowupFixture();
  const { revision: _r, subject: _s, body: _b, evidenceIds: _e, generation: _g, updatedAt: _u, ...identity } = draft;
  void [_r, _s, _b, _e, _g, _u];
  const presentation = { kind: 'requested_followup', asOf: draft.updatedAt, binding: { ...identity, workspaceId: 'ws' }, contact: null as null, callContext: null as null, issues: [] as [] };
  const answer = { kind: 'requested_followup', accountId: draft.accountId, draft, approval: null as null, capability: 'held', reason: 'requires_owner_preflight', presentation };
  const parsed = dailyAnswerSchema.safeParse(answer);
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(parsed.data).toEqual(answer);
});

import { dailyAnswerPresentationMatches, requestedAnswerPresentationSchema } from '../../src/shared/contracts/dailyAnswerPresentationContract';
function presented() {
  const { draft } = requestedFollowupFixture();
  const { revision, subject, body, evidenceIds, generation, updatedAt, ...binding } = draft;
  void [revision, subject, body, evidenceIds, generation];
  return { draft, presentation: { kind: 'requested_followup' as const, asOf: updatedAt, binding: { ...binding, workspaceId: 'ws' }, contact: null as null, callContext: null as null, issues: [] as [] } };
}
it('matches retained immutable identity across ordinary edits but not incoming different recipient or context', () => {
  const { draft, presentation } = presented();
  expect(dailyAnswerPresentationMatches(presentation, { ...draft, revision: 99, subject: 'New', body: 'typed', evidenceIds: [], generation: 'model' }, 'ws')).toBe(true);
  for (const changed of [{ ...draft, recipient: 'other@fixture.invalid', recipientBinding: { ...draft.recipientBinding, email: 'other@fixture.invalid' } }, { ...draft, contextRevision: 'b'.repeat(64) }, { ...draft, sender: 'other@fixture.invalid' }]) {
    expect(dailyAnswerPresentationMatches(presentation, changed, 'ws')).toBe(false);
  }
  expect(dailyAnswerPresentationMatches(presentation, draft, 'foreign')).toBe(false);
  expect(dailyAnswerPresentationMatches({ ...presentation, canApprove: true }, draft, 'ws')).toBe(false);
  expect(requestedAnswerPresentationSchema.safeParse({ ...presentation, asOf: 'not a date' }).success).toBe(false);
});
it('drops malformed or unrelated annotation without losing otherwise valid saved work', () => {
  const { draft, presentation } = presented();
  const base = { kind: 'requested_followup', accountId: draft.accountId, draft, approval: null as null, capability: 'held', reason: 'requires_owner_preflight' };
  for (const invalid of [{ ...presentation, quote: 'fabrication' }, { ...presentation, binding: { ...presentation.binding, id: 'other' } }]) {
    expect(dailyAnswerSchema.parse({ ...base, presentation: invalid })).toEqual(base);
  }
});
