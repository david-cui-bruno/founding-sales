// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { PresentationRoot } from '../../app/PresentationRoot';
import { NativeDeskRoute } from './NativeDeskRoute';
import { dailyFixture, nativeDeskFixture } from './nativeDesk.fixture';
import { WEEKLY_SUMMARY_COPY } from './todayCopy';
import type { DailySnapshot } from '../../../shared/contracts/dailyContract';

afterEach(cleanup);
const hash = 'a'.repeat(64);
const NOW = '2026-09-18T12:00:00.000Z';

const replyAnswer = (accountId: string): DailySnapshot['answers'][number] => ({
  kind: 'reply', accountId, draft: null, stale: false, capability: 'held', reason: 'reply_capability_unverified',
  thread: { revision: 1, contextRevision: 'ctx-1', signals: [{ kind: 'substantive', evidence: [{ messageId: 'm1', quote: 'Send a quote.' }], requiresApproval: true }],
    thread: { accountId, mailboxSubject: 'mailbox', provider: 'gmail', providerThreadId: 't1', messages: [
      { id: 'm1', threadId: 't1', rfcMessageId: null, references: [], from: ['office@example.invalid'], to: ['callie@example.invalid'], cc: [],
        date: NOW, subject: 'Re: maintenance', bodyParts: [{ mimeType: 'text/plain', text: 'Send a quote.', truncated: false }] }] } },
});

const pausedCampaign = (accountId: string): DailySnapshot['campaigns'][number] => {
  const versionId = 'version-1';
  return {
    version: { id: versionId, campaignId: 'campaign-1', version: 1, audienceHash: hash, offer: 'Fictional maintenance offer', objective: 'meeting',
      cohortAccountIds: [accountId], approvedAt: NOW, steps: [{ id: 'step-1', channel: 'call', condition: 'initial', delayHours: 0 }],
      capScope: 'campaign_version_lifetime', channelCaps: { call: 2, email: 1, linkedin: 1 }, contentPolicyHash: hash },
    snapshotHash: hash,
    caps: [{ campaignVersionId: versionId, channel: 'call', revision: 1, reserved: 0, sent: 0 }],
    enrollments: [{ id: 'enrollment-1', accountId, selectedRouteId: 'route-1', selectedRouteVersion: 1, personId: null, campaignVersionId: versionId,
      currentStepId: 'step-1', version: 2, state: 'paused', executionContextId: 'context', contextRevision: 1, startedAt: NOW }],
  };
};

const callRow = (name: string) => screen.getByRole('button', { name: `Call · ${name}` });

it('leads the Calls lane with the firm that answered and names the sequence state it projects', async () => {
  const snapshot = dailyFixture({
    calls: { accountIds: ['a', 'b'], workloadConflict: false },
    answers: [replyAnswer('a')],
    campaigns: [pausedCampaign('a')],
  });
  const f = nativeDeskFixture(snapshot);
  render(<PresentationRoot><NativeDeskRoute firstUse={f.firstUse} api={f.api} /></PresentationRoot>);
  await screen.findByTestId('native-desk');
  expect(callRow('Account A').textContent).toContain('Reply received from Account A · Sequence paused');
  // A firm that did not answer keeps the ordinary row exactly as it was.
  expect(callRow('Account B').textContent).toContain('Review company and route');
  expect(callRow('Account B').textContent).not.toContain('Reply received');
});

it('says so plainly when the replied firm has no stored enrollment to report', async () => {
  const f = nativeDeskFixture(dailyFixture({ calls: { accountIds: ['a'], workloadConflict: false }, answers: [replyAnswer('a')], campaigns: [] }));
  render(<PresentationRoot><NativeDeskRoute firstUse={f.firstUse} api={f.api} /></PresentationRoot>);
  await screen.findByTestId('native-desk');
  expect(callRow('Account A').textContent).toContain('Reply received from Account A · No sequence for this firm');
});

it('mounts the weekly block under the footer without reading the worker for it', async () => {
  const f = nativeDeskFixture(dailyFixture());
  render(<PresentationRoot><NativeDeskRoute firstUse={f.firstUse} api={f.api} /></PresentationRoot>);
  await screen.findByTestId('native-desk');
  // No usage in the snapshot: the block is honest rather than showing zeroes, and nothing extra was read.
  expect(screen.getByText(WEEKLY_SUMMARY_COPY.unavailable)).toBeTruthy();
  expect(f.calls.filter(call => call.method === 'delegation.researchSetup.status')).toHaveLength(0);
});
