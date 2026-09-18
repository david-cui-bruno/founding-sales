// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WeeklySummary, describeWeeklySpend } from './WeeklySummary';
import { WEEKLY_SUMMARY_COPY, replyFirstLine, sequenceStateLine } from './todayCopy';
import type { ResearchSetupStatus } from '../../../shared/contracts/researchSetupContract';
import { usageSummarySchema, type UsageSummary, type UsageWindow } from '../../../shared/contracts/usageContract';

afterEach(cleanup);

const window = (extra: Partial<UsageWindow> = {}): UsageWindow => ({
  from: '2026-09-14', to: '2026-09-20', mornings: 0, firms: 0, callsPlaced: 0,
  outcomes: { connected: 0, interested: 0, not_interested: 0, gatekeeper: 0, voicemail: 0, no_answer: 0, busy: 0, wrong_number: 0 },
  notes: 0, callbacksPromised: 0, callbacksKept: 0, drafts: 0, replies: 0, holds: [], ...extra,
});
const usage = (extra: Partial<UsageSummary> = {}): UsageSummary => usageSummarySchema.parse({
  timezone: 'America/New_York',
  thisWeek: window({ mornings: 4, firms: 22, callsPlaced: 31, notes: 6, callbacksPromised: 3, callbacksKept: 2, drafts: 5, replies: 4,
    outcomes: { connected: 3, interested: 2, not_interested: 4, gatekeeper: 5, voicemail: 7, no_answer: 9, busy: 1, wrong_number: 2 },
    holds: [{ reason: 'manual_only', count: 1 }, { reason: 'reply_capability_unverified', count: 4 }] }),
  lastWeek: window({ from: '2026-09-07', to: '2026-09-13', mornings: 5, callsPlaced: 40, replies: 2, callbacksKept: 1,
    outcomes: { connected: 4, interested: 1, not_interested: 2, gatekeeper: 3, voicemail: 6, no_answer: 8, busy: 0, wrong_number: 1 } }),
  ...extra,
});
const status = (extra: Record<string, unknown> = {}): ResearchSetupStatus => ({
  pending: null, blockers: [],
  remote: { workspaceId: 'ws', pairingId: '11111111-1111-4111-8111-111111111111', selector: null,
    discoveryLedger: { limitMicros: 5_000_000, reservedOrSpentMicros: 350_000, remainingMicros: 4_650_000 },
    researchLedger: { limitMicros: 2_000_000, reservedOrSpentMicros: 1_250_000, remainingMicros: 750_000 },
    descriptor: null, descriptorFingerprint: null, credentialParameterDeclared: true, blockers: [],
    checkedAt: '2026-09-18T13:00:00.000Z', receipt: null, ...extra } as ResearchSetupStatus['remote'],
});

describe('spend in the weekly block', () => {
  it('reads the footer’s last status and never reports a zero for a status it could not read', () => {
    expect(describeWeeklySpend(status())).toBe('Discovery USD 0.35 of 5.00 · research USD 1.25 of 2.00 (to date)');
    expect(describeWeeklySpend(null)).toBe(WEEKLY_SUMMARY_COPY.spendUnknown);
    expect(describeWeeklySpend(status({ discoveryLedger: null }))).toBe('Discovery unknown · research USD 1.25 of 2.00 (to date)');
    expect(describeWeeklySpend(status({ researchLedger: null }))).toBe('Discovery USD 0.35 of 5.00 · research unknown (to date)');
  });
});

describe('the weekly block', () => {
  it('shows plain numbers for the week, a Last week line and the spend from the last status', () => {
    render(<WeeklySummary usage={usage()} status={status()} />);
    expect(screen.getByText('This week (2026-09-14 to 2026-09-20)')).toBeTruthy();
    const block = screen.getByLabelText(WEEKLY_SUMMARY_COPY.heading);
    const pairs = [...block.querySelectorAll('dt')].map((dt, index) => [dt.textContent, block.querySelectorAll('dd')[index]?.textContent]);
    expect(pairs).toEqual([
      ['Mornings worked', '4'], ['Firms worked', '22'], ['Calls placed', '31'],
      ['Connected', '3'], ['Connected, interested', '2'], ['Connected, not interested', '4'], ['Gatekeeper', '5'],
      ['Voicemail', '7'], ['No answer', '9'], ['Busy', '1'], ['Wrong number', '2'],
      ['Notes written', '6'], ['Callbacks promised', '3'], ['Callbacks kept', '2'],
      ['Drafts written', '5'], ['Replies received', '4'],
      ['Holds', 'LinkedIn note is manual only 1 · reply capability unverified 4'],
      ['Spend', 'Discovery USD 0.35 of 5.00 · research USD 1.25 of 2.00 (to date)'],
    ]);
    expect(screen.getByText('Last week (2026-09-07 to 2026-09-13): mornings worked 5 · calls placed 40 · connected 10 · replies received 2 · callbacks kept 1')).toBeTruthy();
    // No chart, no ranking, no target: one definition list and two sentences.
    expect(block.querySelectorAll('svg,canvas,table,progress,meter')).toHaveLength(0);
  });
  it('says no holds rather than showing an empty list', () => {
    render(<WeeklySummary usage={usage({ thisWeek: window() })} status={null} />);
    const block = screen.getByLabelText(WEEKLY_SUMMARY_COPY.heading);
    const holds = [...block.querySelectorAll('dt')].findIndex(dt => dt.textContent === 'Holds');
    expect(block.querySelectorAll('dd')[holds]?.textContent).toBe(WEEKLY_SUMMARY_COPY.noHolds);
    expect(block.querySelectorAll('dd')[holds + 1]?.textContent).toBe(WEEKLY_SUMMARY_COPY.spendUnknown);
  });
  it('is honest when the summary could not be derived, instead of showing zeroes', () => {
    render(<WeeklySummary status={status()} />);
    expect(screen.getByText(WEEKLY_SUMMARY_COPY.unavailable)).toBeTruthy();
    expect(screen.queryAllByRole('status')).toHaveLength(0);
    expect(screen.queryByText('Mornings worked')).toBeNull();
  });
});

describe('the reply-first line', () => {
  it('names the firm and shows only the sequence state the stored enrollment reports', () => {
    expect(replyFirstLine('Lenox Property Management')).toBe('Reply received from Lenox Property Management');
    expect(sequenceStateLine('paused')).toBe('Sequence paused');
    expect(sequenceStateLine('active')).toBe('Sequence active');
    expect(sequenceStateLine('opted_out')).toBe('Sequence opted out');
    expect(sequenceStateLine(null)).toBe('No sequence for this firm');
  });
});
