// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { DailySnapshot } from '../../../shared/contracts/dailyContract';
import { CampaignReview } from './CampaignReview';
import { createCallCampaignDraft, createLinkedInCampaignDraft } from '../../../shared/contracts/callCampaignDraft';
import { dailyFixture, nativeDeskReviewFixture, linkedInFixture } from '../today/nativeDesk.fixture';
afterEach(cleanup);
it('shows the verifiable single-company template, but holds altered or opaque audience hashes', () => {
  const snapshot = dailyFixture();
  const version = createCallCampaignDraft({ campaignId: 'draft-campaign', versionId: 'draft-version', stepId: 'initial-call', accountId: 'a', offer: 'Discuss maintenance follow-up.' });
  const campaign: DailySnapshot['campaigns'][number] = { version, snapshotHash: 'c'.repeat(64), caps: [], enrollments: [] };
  const view = render(<CampaignReview campaign={campaign} accounts={snapshot.accounts} answers={[]} />);
  expect(screen.getByRole('heading', { name: 'Call campaign draft' })).toBeTruthy();
  expect(screen.getByText('Explicitly selected company: Account A (a).')).toBeTruthy();
  expect(screen.getByText('Discuss maintenance follow-up.')).toBeTruthy();
  expect(screen.getByText(/does not grant contact permission/)).toBeTruthy();
  expect(screen.queryByText(/Audience definition unavailable/)).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  view.rerender(<CampaignReview campaign={{ ...campaign, version: { ...version, cohortAccountIds: ['b'] } }} accounts={snapshot.accounts} answers={[]} />);
  expect(screen.getByText(/Audience definition unavailable/)).toBeTruthy();
  expect(screen.queryByText(/Explicitly selected company/)).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});
it('shows frozen offer, cohort IDs and lifetime caps, never invents audience or approval authority', () => {
  const snapshot = dailyFixture();
  const hash = 'b'.repeat(64);
  const campaign: DailySnapshot['campaigns'][number] = {
    version: {
      id: 'v1',
      campaignId: 'c1',
      version: 2,
      audienceHash: hash,
      offer: 'Recorded offer',
      objective: 'meeting' as const,
      cohortAccountIds: ['a'],
      approvedAt: null,
      steps: [
        {
          id: 's1',
          channel: 'call' as const,
          condition: 'initial' as const,
          delayHours: 0,
        },
      ],
      capScope: 'campaign_version_lifetime' as const,
      channelCaps: { call: 2, email: 1, linkedin: 1 },
      contentPolicyHash: hash,
    },
    snapshotHash: hash,
    caps: [],
    enrollments: [],
  };
  render(
    <CampaignReview
      campaign={campaign}
      accounts={snapshot.accounts}
      answers={snapshot.answers}
    />,
  );
  expect(screen.getByText('Recorded offer')).toBeTruthy();
  expect(screen.getByText(/Audience definition unavailable/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve campaign' })).toBeNull();
  expect(screen.getByText(/Read-only preview/)).toBeTruthy();
  expect(screen.getByText(/call: 2/)).toBeTruthy();
  expect(screen.getByText(/No exact campaign-bound samples/)).toBeTruthy();
});

it('retains exact version facts, enrollment and only version-bound LinkedIn samples in a read-only preview', () => {
  const snapshot = nativeDeskReviewFixture(), campaign = snapshot.campaigns[0];
  const exact = linkedInFixture();
  exact.draft.body = 'Exact bound LinkedIn sample'; exact.draft.revision = 7;
  const wrongVersion = { ...exact, draft: { ...exact.draft, id: 'other', campaignVersionId: 'other-version', body: 'Wrong version sample' } };
  campaign.version.approvedAt = '2026-09-09T12:00:00.000Z';
  campaign.caps = [{ campaignVersionId: campaign.version.id, channel: 'linkedin', revision: 2, reserved: 1, sent: 3 }];
  campaign.enrollments = [{ id: 'enrollment', accountId: 'a', selectedRouteId: 'saved-route', selectedRouteVersion: 4, personId: null, campaignVersionId: campaign.version.id, currentStepId: 'li-step', version: 5, state: 'active', executionContextId: 'context', contextRevision: 6, startedAt: '2026-09-09T12:00:00.000Z' }];
  render(<CampaignReview campaign={campaign} accounts={snapshot.accounts} answers={[...snapshot.answers.filter(a => a.kind === 'requested_followup'), wrongVersion, exact]} />);
  expect(screen.getByText('Exact bound LinkedIn sample')).toBeTruthy();
  expect(screen.getByText('Manual LinkedIn · a · revision 7')).toBeTruthy();
  expect(screen.queryByText('Wrong version sample')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByText(/Read-only preview/)).toBeTruthy();
  expect(screen.getByText(/Frozen approval recorded: 2026-09-09T12:00:00.000Z. This does not activate new work/)).toBeTruthy();
  expect(screen.getByText('linkedin: 1 reserved, 3 recorded sent')).toBeTruthy();
  expect(screen.getByText('a · active · route saved-route v4 · context 6')).toBeTruthy();
  expect(screen.getByText(`Snapshot hash: ${campaign.snapshotHash}`)).toBeTruthy();
  expect(screen.getByText(`Audience hash: ${campaign.version.audienceHash}`)).toBeTruthy();
  expect(screen.getByText(`Content policy: ${campaign.version.contentPolicyHash}`)).toBeTruthy();
  expect(screen.getByText(`Version ID: ${campaign.version.id}`)).toBeTruthy();
  expect(screen.getByText(/Account A/)).toBeTruthy();
  expect(screen.getByText(/A hash is not an audience definition/)).toBeTruthy();
  for (const a of snapshot.answers) if (a.kind === 'requested_followup') expect(screen.queryByText(a.draft.body)).toBeNull();
});

it('labels the exact single-company LinkedIn template as a LinkedIn draft, then as reviewed once approved, never as a call', () => {
  const snapshot = dailyFixture();
  const version = createLinkedInCampaignDraft({ campaignId: 'li-campaign', versionId: 'li-version', stepId: 'initial-note', accountId: 'a', offer: 'Discuss maintenance follow-up.' });
  const campaign: DailySnapshot['campaigns'][number] = { version, snapshotHash: 'c'.repeat(64), caps: [], enrollments: [] };
  const view = render(<CampaignReview campaign={campaign} accounts={snapshot.accounts} answers={[]} />);
  expect(screen.getByRole('heading', { name: 'LinkedIn campaign draft' })).toBeTruthy();
  expect(screen.getByText(/manual-LinkedIn template/)).toBeTruthy();
  expect(screen.getByText('Explicitly selected company: Account A (a).')).toBeTruthy();
  expect(screen.getByText('manual initial linkedin draft template v1')).toBeTruthy();
  expect(screen.getByText(/Review this frozen company, offer, LinkedIn step and lifetime limits before a separate enrollment/)).toBeTruthy();
  expect(screen.queryByText(/call step/)).toBeNull();
  expect(screen.queryByText(/Audience definition unavailable/)).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  view.rerender(<CampaignReview campaign={{ ...campaign, version: { ...version, approvedAt: '2026-09-09T12:00:00.000Z' } }} accounts={snapshot.accounts} answers={[]} />);
  expect(screen.getByRole('heading', { name: 'Reviewed LinkedIn campaign' })).toBeTruthy();
  expect(screen.getByText(/Approval alone does not enroll a company or send a message/)).toBeTruthy();
  view.rerender(<CampaignReview campaign={{ ...campaign, version: { ...version, channelCaps: { call: 1, email: 0, linkedin: 1 } } }} accounts={snapshot.accounts} answers={[]} />);
  expect(screen.getByText(/Read-only preview/)).toBeTruthy();
  expect(screen.getByText(/Audience definition unavailable/)).toBeTruthy();
});
