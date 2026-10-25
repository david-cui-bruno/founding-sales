import { expect, it } from 'vitest';
import { candidateAuthorityReadSchema, candidateAuthorityViewSchema } from '@fss/contracts';
import { browserApiPathAllowed } from '../../src/shared/browserContract.ts';

const id = '11111111-1111-4111-8111-111111111111';
it('admits only the closed candidate authority metadata read', () => {
  const path = '/sourcing/candidates/authority/read';
  expect(browserApiPathAllowed('POST', path)).toBe(true);
  for (const method of ['GET', 'PUT', 'DELETE']) expect(browserApiPathAllowed(method, path)).toBe(false);
  for (const suffix of ['/extra', '/../request', '?candidateId=x']) expect(browserApiPathAllowed('POST', path + suffix)).toBe(false);
  expect(browserApiPathAllowed('POST', '/sourcing/qualification/request')).toBe(true);
  for (const path of ['/sourcing/candidates/authority/write', '/sourcing/automatic-research/enable']) {
    expect(browserApiPathAllowed('POST', path)).toBe(false);
  }
});
it('requires exact candidate revision and never accepts authority or private payload extensions', () => {
  const input = { candidateId: id, expectedRevision: 1 };
  expect(candidateAuthorityReadSchema.safeParse(input).success).toBe(true);
  for (const extra of [{ ownerUserId: id }, { authorized: true }, { expectedRevision: 0 }]) {
    expect(candidateAuthorityReadSchema.safeParse({ ...input, ...extra }).success).toBe(false);
  }
  const view = {
    candidateId: id, candidateRevision: 1, checkedAt: '2026-10-23T16:00:00.000Z',
    source: { status: 'unavailable' }, owner: 'unavailable', researchEnabled: true,
    holds: 'unknown', authority: 'not_granted',
  };
  expect(candidateAuthorityViewSchema.safeParse(view).success).toBe(true);
  for (const extra of [{ evidence: 'private' }, { reportSha256: 'a'.repeat(64) }, { authority: 'granted' }]) {
    expect(candidateAuthorityViewSchema.safeParse({ ...view, ...extra }).success).toBe(false);
  }
  expect(candidateAuthorityViewSchema.safeParse({ ...view, source: { status: 'matched', kind: 'search_hit', attemptId: id } }).success).toBe(true);
  expect(candidateAuthorityViewSchema.safeParse({ ...view, source: { status: 'matched', kind: 'manual', attemptId: id } }).success).toBe(false);
});
