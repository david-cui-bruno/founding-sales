// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { DailySnapshot } from '../../../shared/contracts/dailyContract';
import { CampaignReview } from './CampaignReview';
import { dailyFixture, nativeDeskReviewFixture, linkedInFixture } from '../today/nativeDesk.fixture';
afterEach(cleanup);
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
