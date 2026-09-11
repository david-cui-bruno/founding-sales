// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { DailySnapshot } from '../../../shared/contracts/dailyContract';
import { CampaignReview } from './CampaignReview';
import { dailyFixture } from '../today/nativeDesk.fixture';
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
  expect(
    (
      screen.getByRole('button', {
        name: 'Approve campaign',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByText(/call: 2/)).toBeTruthy();
  expect(screen.getByText(/No exact campaign-bound samples/)).toBeTruthy();
});
