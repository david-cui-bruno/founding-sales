// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TodayFooter, describeAgo, describeDiscoverySpend, describeSync, describeWorkerTick } from './TodayFooter';
import { dailyFixture } from './nativeDesk.fixture';
import type { ResearchSetupStatus } from '../../../shared/contracts/researchSetupContract';
import type { DailySnapshot } from '../../../shared/contracts/dailyContract';

afterEach(cleanup);
const NOW = Date.parse('2026-09-18T13:10:00.000Z');
const remote = (extra: Record<string, unknown> = {}): ResearchSetupStatus => ({
  pending: null, blockers: [],
  remote: { workspaceId: 'ws', pairingId: '11111111-1111-4111-8111-111111111111', selector: null, discoveryLedger: { limitMicros: 5_000_000, reservedOrSpentMicros: 350_000, remainingMicros: 4_650_000 },
    researchLedger: null, descriptor: null, descriptorFingerprint: null, credentialParameterDeclared: true, blockers: [], checkedAt: '2026-09-18T13:00:00.000Z', receipt: null, ...extra } as ResearchSetupStatus['remote'],
});

describe('footer words', () => {
  it('describes time honestly and never in the future', () => {
    expect(describeAgo('2026-09-18T13:09:40.000Z', NOW)).toBe('just now');
    expect(describeAgo('2026-09-18T13:08:00.000Z', NOW)).toBe('2 min ago');
    expect(describeAgo('2026-09-18T10:10:00.000Z', NOW)).toBe('3 h ago');
    expect(describeAgo('2026-09-16T13:10:00.000Z', NOW)).toBe('2 d ago');
    expect(describeAgo('2026-09-18T14:10:00.000Z', NOW)).toBe('just now');
    expect(describeAgo('not a time', NOW)).toBe('at an unknown time');
  });
  it('reads the stored transport record: none, complete, pending and failed', () => {
    const base = dailyFixture();
    expect(describeSync(base, NOW)).toBe('Local snapshot · remote freshness unknown');
    expect(describeSync({ ...base, workspaceId: null }, NOW)).toBe('Local snapshot · remote freshness unknown');
    const transport = (state: 'complete' | 'pending' | 'failed', revision: number) => ({ pairingId: 'p', revision, state, startedAt: '2026-09-18T13:07:00.000Z', completedAt: state === 'complete' ? '2026-09-18T13:08:00.000Z' : null });
    expect(describeSync({ ...base, transport: [transport('complete', 1)] }, NOW)).toBe('Synced 2 min ago');
    expect(describeSync({ ...base, transport: [transport('complete', 1), transport('failed', 2)] }, NOW)).toBe('Sync failed (attempted 3 min ago) · showing local records');
    expect(describeSync({ ...base, transport: [transport('pending', 3), transport('complete', 1)] }, NOW)).toBe('Sync in progress (started 3 min ago)');
  });
  it('says unknown for the worker tick until the field exists, and reads the discovery ledger for the spend', () => {
    expect(describeWorkerTick(null, NOW)).toBe('worker last ran unknown');
    expect(describeWorkerTick(remote(), NOW)).toBe('worker last ran unknown');
    expect(describeWorkerTick(remote({ lastTickAt: '2026-09-18T13:07:00.000Z' }), NOW)).toBe('worker last ran 3 min ago');
    expect(describeWorkerTick(remote({ lastTickAt: 42 }), NOW)).toBe('worker last ran unknown');
    expect(describeDiscoverySpend(null)).toBe('discovery spend unknown');
    expect(describeDiscoverySpend(remote())).toBe('discovery USD 0.35 of 5.00');
    expect(describeDiscoverySpend(remote({ discoveryLedger: null }))).toBe('discovery spend unknown');
  });
});

describe('TodayFooter', () => {
  it('shows one line from the stored sync record and the research status, re-reading the status only when the sync record changes', async () => {
    const snapshot = { ...dailyFixture(), transport: [{ pairingId: 'p', revision: 1, state: 'complete' as const, startedAt: '2026-09-18T13:07:00.000Z', completedAt: '2026-09-18T13:08:00.000Z' }] };
    const researchSetup = { status: vi.fn(async () => remote()) };
    const view = render(<TodayFooter snapshot={snapshot} readError={false} researchSetup={researchSetup} now={() => NOW} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Synced 2 min ago · worker last ran unknown · discovery USD 0.35 of 5.00'));
    expect(researchSetup.status).toHaveBeenCalledTimes(1);
    view.rerender(<TodayFooter snapshot={{ ...snapshot, revision: 'b'.repeat(64) }} readError={false} researchSetup={researchSetup} now={() => NOW} />);
    expect(researchSetup.status).toHaveBeenCalledTimes(1);
    view.rerender(<TodayFooter snapshot={{ ...snapshot, transport: [{ ...snapshot.transport[0]!, revision: 2, state: 'failed', completedAt: null }] }} readError={false} researchSetup={researchSetup} now={() => NOW} />);
    await waitFor(() => expect(researchSetup.status).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('status').textContent).toBe('Sync failed (attempted 3 min ago) · showing local records · worker last ran unknown · discovery USD 0.35 of 5.00');
  });
  it('keeps the unpaired and failed-refresh lines, reads nothing remote for them, and names the default allocation in the details', async () => {
    const researchSetup = { status: vi.fn(async () => remote()) };
    const unpaired: DailySnapshot = { ...dailyFixture(), workspaceId: null, accounts: [], answers: [], calls: { accountIds: [], workloadConflict: false }, callSettings: { newCallSlots: null, totalCallCapacity: null }, allocation: { newCallSlots: 30, source: 'default' } };
    const view = render(<TodayFooter snapshot={unpaired} readError={false} researchSetup={researchSetup} now={() => NOW} />);
    expect(screen.getByRole('status').textContent).toBe('Local snapshot · remote freshness unknown');
    fireEvent.click(screen.getByText('Queue capacity and operational details'));
    expect(screen.getByText(/New-call slots:/).textContent).toContain('New-call slots: 30 (default: 30 new firms a day) · total call capacity: unconfigured.');
    view.rerender(<TodayFooter snapshot={dailyFixture()} readError researchSetup={researchSetup} now={() => NOW} />);
    expect(screen.getByRole('status').textContent).toBe('Refresh unavailable. Your current view and edits are retained.');
    await Promise.resolve();
    expect(researchSetup.status).not.toHaveBeenCalled();
    view.rerender(<TodayFooter snapshot={dailyFixture()} readError={false} now={() => NOW} />);
    expect(screen.getByRole('status').textContent).toBe('Local snapshot · remote freshness unknown · worker last ran unknown · discovery spend unknown');
    expect(screen.getByText(/New-call slots:/).textContent).toContain('New-call slots: 3 · total call capacity: 5.');
  });
  it('treats a failed or malformed research status as unknown, never as zero spend', async () => {
    const researchSetup = { status: vi.fn(async () => { throw Error('/Users/founder/private status failure'); }) };
    render(<TodayFooter snapshot={dailyFixture()} readError={false} researchSetup={researchSetup} now={() => NOW} />);
    await waitFor(() => expect(researchSetup.status).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('status').textContent).toBe('Local snapshot · remote freshness unknown · worker last ran unknown · discovery spend unknown');
    expect(document.body.textContent).not.toContain('private');
  });
});
