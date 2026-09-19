import { expect, it } from 'vitest';
import { describeCampaignRow, isNonterminalEnrollment } from './campaignListLabel';
import { createCallCampaignDraft } from '../../../shared/contracts/callCampaignDraft';
import type { DailySnapshot } from '../../../shared/contracts/dailyContract';
import type { Enrollment } from '../../../shared/contracts/campaignContract';
import { dailyFixture, nativeDeskReviewFixture } from '../today/nativeDesk.fixture';
import { DEFAULT_TERRITORY_CALL_POLICY_DEFINITION, deriveTerritoryCampaignVersion, territoryCallPolicyId } from '../../../shared/contracts/territoryCallPolicyContract';

type Campaign = DailySnapshot['campaigns'][number];
const offer = 'Discuss a simpler maintenance follow-up workflow.';
const accounts = dailyFixture().accounts;
const call = createCallCampaignDraft({ campaignId: '4b1f0d6e-0000-4000-8000-000000000001', versionId: 'call-version', stepId: 'call-step', accountId: 'a', offer });
const enrollment: Enrollment = { id: 'enrollment', accountId: 'a', selectedRouteId: 'phone', selectedRouteVersion: 1, personId: null, campaignVersionId: 'call-version',
  currentStepId: 'call-step', version: 1, state: 'active', executionContextId: 'context', contextRevision: 1, startedAt: '2026-09-09T12:00:00.000Z' };
const entry = (version: Campaign['version'], enrollments: Enrollment[] = []): Campaign => ({ version, snapshotHash: 'a'.repeat(64), caps: [], enrollments });

it('names a recognised one-company template by company and channel with a plain draft or approved state', () => {
  expect(describeCampaignRow(entry(call), accounts)).toEqual({ title: 'Account A · Call campaign', detail: 'Version 1 · Draft' });
  expect(describeCampaignRow(entry({ ...call, approvedAt: '2026-09-09T12:00:00.000Z' }), accounts)).toEqual({ title: 'Account A · Call campaign', detail: 'Version 1 · Approved' });
});

it('says Enrolled only while a nonterminal enrollment exists, and never for completed or stopped history', () => {
  const approved = { ...call, approvedAt: '2026-09-09T12:00:00.000Z' };
  for (const state of ['active', 'held', 'paused', 'conversation'] as const) {
    expect(isNonterminalEnrollment({ state })).toBe(true);
    expect(describeCampaignRow(entry(approved, [{ ...enrollment, state }]), accounts).detail).toBe('Version 1 · Enrolled');
  }
  for (const state of ['completed', 'stopped'] as const) {
    expect(isNonterminalEnrollment({ state })).toBe(false);
    expect(describeCampaignRow(entry(approved, [{ ...enrollment, state }]), accounts).detail).toBe('Version 1 · Approved');
  }
  expect(describeCampaignRow(entry(approved, [{ ...enrollment, state: 'stopped' }, { ...enrollment, id: 'again', state: 'held' }]), accounts).detail).toBe('Version 1 · Enrolled');
});

it('falls back to the saved account id when the company is not in the snapshot', () => {
  expect(describeCampaignRow(entry(call), [])).toEqual({ title: 'a · Call campaign', detail: 'Version 1 · Draft' });
});

it('keeps the saved campaign id and recorded approval wording for anything other than the exact call template', () => {
  const opaque = nativeDeskReviewFixture().campaigns[0];
  expect(describeCampaignRow(opaque, accounts)).toEqual({ title: 'Fixture campaign', detail: 'Version 1 · not approved' });
  expect(describeCampaignRow({ ...opaque, version: { ...opaque.version, version: 3, approvedAt: '2026-09-09T12:00:00.000Z' } }, accounts))
    .toEqual({ title: 'Fixture campaign', detail: 'Version 3 · approval recorded' });
  // A call structure signed with a different policy is opaque, even with an enrollment.
  expect(describeCampaignRow(entry({ ...call, contentPolicyHash: 'b'.repeat(64) }, [enrollment]), accounts))
    .toEqual({ title: call.campaignId, detail: 'Version 1 · not approved' });
  // A saved LinkedIn-typed version is opaque since 18 September 2026 and keeps its saved campaign id.
  expect(describeCampaignRow(entry({ ...call, steps: [{ ...call.steps[0]!, channel: 'linkedin' }], channelCaps: { call: 0, email: 0, linkedin: 1 } }), accounts))
    .toEqual({ title: call.campaignId, detail: 'Version 1 · not approved' });
});

it('names a version the worker derived from the territory call policy as company · Territory policy v<revision>', () => {
  const territory = deriveTerritoryCampaignVersion({ ...DEFAULT_TERRITORY_CALL_POLICY_DEFINITION, policyId: territoryCallPolicyId('ws'), revision: 2 }, 'a');
  const approved = { ...territory, approvedAt: '2026-09-18T12:00:00.000Z' };
  expect(describeCampaignRow(entry(territory), accounts)).toEqual({ title: 'Account A · Territory policy v2', detail: 'Version 1 · Draft' });
  expect(describeCampaignRow(entry(approved), accounts)).toEqual({ title: 'Account A · Territory policy v2', detail: 'Version 1 · Approved' });
  expect(describeCampaignRow(entry(approved, [{ ...enrollment, campaignVersionId: territory.id, currentStepId: territory.steps[0]!.id }]), accounts)).toEqual({ title: 'Account A · Territory policy v2', detail: 'Version 1 · Enrolled' });
});
