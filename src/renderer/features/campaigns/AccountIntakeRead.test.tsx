// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CallCampaignDraft } from './CallCampaignDraft';
import { configuredFixtureStatus, nativeDeskFixture, nativeDeskReviewFixture } from '../today/nativeDesk.fixture';
import { setDailySessionScope } from '../today/dailySessionScope';
import { AccountIntakeRead } from './AccountIntakeRead';
import type { AccountPreparation } from '../../../shared/contracts/accountPreparationContract';

afterEach(cleanup);
function fixture() {
  const snapshot = nativeDeskReviewFixture();
  const f = nativeDeskFixture(snapshot);
  const read = vi.spyOn(f.api.delegation, 'getAccountPreparation');
  setDailySessionScope(f.api.delegation, 'ws');
  return { ...f, read, props: { api: f.api, snapshot, config: configuredFixtureStatus(), readError: false, onRefresh: vi.fn() } };
}
function review() {
  fireEvent.click(screen.getByRole('button', { name: 'New call campaign' }));
  fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'a' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review worker preparation' }));
}
it('exposes an explicit intake read inside actual worker preparation without automatically reading', () => {
  const f = fixture();
  render(<CallCampaignDraft {...f.props} />);
  review();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Read intake configuration' }).disabled).toBe(false);
  expect(f.read).not.toHaveBeenCalled();
  // The only automatic read on opening the panel is the local worker-copy comparison; the intake read stays explicit and nothing reaches the worker.
  expect(f.calls).toEqual([{ method: 'getSelectedAccountFreshness', input: { accountId: 'a' } }]);
});

const ownedLine = 'Intake configuration exists only for a company the worker owns. Copy and delegate this company first.';
it.each([['copy', true], ['delegate', true], ['held', false]] as const)('waits at stage %s: the read control is disabled, the copy-and-delegate line is shown %s, and no request is sent', (stage, shown) => {
  const f = fixture();
  const owner = f.props.snapshot.ownerStatus.find(o => o.accountId === 'a')!;
  if (stage === 'held') owner.pendingCommands = [{ commandId: 'queued-preparation', status: 'pending', authorityGeneration: 1, aggregateVersion: 1, reason: null }];
  else {
    owner.status = 'unknown';
    owner.authority = stage === 'copy' ? null : { accountId: 'a', owner: 'local', state: 'local', generation: 0 };
    owner.executionVersion = stage === 'copy' ? null : 1;
  }
  f.setSnapshot(f.props.snapshot);
  const view = render(<CallCampaignDraft {...f.props} />);
  review();
  const read = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Read intake configuration' });
  expect(read().disabled).toBe(true);
  expect(!!screen.queryByText(ownedLine)).toBe(shown);
  fireEvent.click(read());
  view.unmount();
  // The component holds the same line on its own, whatever the parent's guard says.
  render(<AccountIntakeRead {...inlineProps(f)} stage={stage} />);
  expect(read().disabled).toBe(true);
  expect(!!screen.queryByText(ownedLine)).toBe(shown);
  fireEvent.click(read());
  expect(f.read).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
});

const absent: AccountPreparation = {
  workspaceId: 'ws', accountId: 'a', pairingId: 'pair', checkedAt: '2026-09-16T02:00:00.000Z',
  authority: { accountId: 'a', owner: 'worker', generation: 1, state: 'active' },
  executionVersion: 1, configuration: null, mailCursor: null,
};
function clickRead() { fireEvent.click(screen.getByRole('button', { name: 'Read intake configuration' })); }
function deferred() {
  let resolve!: (value: AccountPreparation) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<AccountPreparation>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function inlineProps(f: ReturnType<typeof fixture>) {
  return { api: f.api, workspaceId: 'ws', accountId: 'a', disabled: false, stage: 'active' as const, scopeKey: 'initial' };
}
it('reads absence through the parent without synchronizing or sending commands, and preserves the save gate', async () => {
  const f = fixture();
  f.read.mockResolvedValue(absent);
  render(<CallCampaignDraft {...f.props} />);
  review();
  fireEvent.change(screen.getByLabelText('Meeting offer'), { target: { value: 'Review operations' } });
  const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save call campaign draft' });
  expect(save.disabled).toBe(false);
  clickRead();
  await screen.findByText('No intake configuration exists.');
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.read).toHaveBeenCalledWith({ accountId: 'a' });
  expect(screen.getByText(/Last observed:/).textContent).toContain(absent.checkedAt);
  expect(screen.getByText(/This read does not synchronize queued work/)).toBeTruthy();
  expect(save.disabled).toBe(false);
  expect(f.calls).toEqual([{ method: 'getSelectedAccountFreshness', input: { accountId: 'a' } }]); // local worker-copy read only; no sync, no command
});
it.each([false, true])('renders configured indicators without claiming grants or no-mail eligibility (mail selected: %s)', async selected => {
  const f = fixture();
  const limits = { maxCompanies: 1, maxPages: 1, maxBytes: 100, maxCostMicros: 100 };
  f.read.mockResolvedValue({ ...absent, configuration: {
    version: 1, workspaceId: 'ws', accountId: 'a', pairingId: 'pair', revision: 4, state: 'paused',
    mailboxSubject: selected ? 'mailbox' : null, calendarId: selected ? 'calendar' : null,
    research: selected ? { workspaceId: 'ws', budgetId: 'budget', audience: { residential: true, regions: ['MA'], terms: ['HVAC'] },
      audienceRevision: 1, sourceRevision: 1, budgetRevision: 1, discoveryLimits: limits, researchLimits: limits,
      capability: { model: 'model', webSearch: true, searchCostMicros: 1, modelCostMicros: 1 },
      maxAccountBudgetMicros: 100, permittedSources: [], preparationCommandId: '00000000-0000-4000-8000-000000000000' } : null,
  }, mailCursor: selected ? { mailboxSubject: 'mailbox', envelopeRevision: null, scope: null } : null });
  render(<AccountIntakeRead {...inlineProps(f)} />);
  clickRead();
  await screen.findByText('Intake configuration exists.');
  expect(screen.getByText('Configuration revision: 4. State: paused.')).toBeTruthy();
  expect(screen.getByText(selected ? 'Mail: configured. Research: configured. Calendar: configured.' : 'Mail: unselected. Research: not configured. Calendar: not configured.')).toBeTruthy();
  expect(screen.getByText(/An unselected mailbox does not establish no-mail eligibility/)).toBeTruthy();
  expect(screen.getByText(/A configured mailbox does not confirm a current grant/)).toBeTruthy();
  expect(f.calls).toEqual([]);
});
it('coalesces duplicate clicks and offers explicit sanitized retry after a read failure', async () => {
  const f = fixture();
  const pending = deferred();
  f.read.mockReturnValueOnce(pending.promise).mockResolvedValue(absent);
  render(<AccountIntakeRead {...inlineProps(f)} />);
  const button = screen.getByRole('button', { name: 'Read intake configuration' });
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  expect(f.read).toHaveBeenCalledTimes(1);
  await act(async () => pending.reject(Error('PRIVATE token')));
  expect(screen.getByText(/Read again to retry explicitly/)).toBeTruthy();
  expect(screen.queryByText(/PRIVATE/)).toBeNull();
  expect(screen.queryByText('No intake configuration exists.')).toBeNull();
  clickRead();
  await screen.findByText('No intake configuration exists.');
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.calls).toEqual([]);
});
it.each(['account', 'workspace', 'daily', 'delegation', 'guard', 'busy', 'unmount', 'session'])(
  'discards inflight results on %s changes without reviving on return', async kind => {
    const f = fixture();
    const props = inlineProps(f);
    const pending = deferred();
    f.read.mockReturnValue(pending.promise);
    const view = render(<AccountIntakeRead {...props} />);
    clickRead();
    if (kind === 'unmount') view.unmount();
    else if (kind === 'session') {
      setDailySessionScope(f.api.delegation, null);
      setDailySessionScope(f.api.delegation, 'ws');
    } else {
      const change = kind === 'account' ? { accountId: 'b' } : kind === 'workspace' ? { workspaceId: 'other' }
        : kind === 'daily' ? { api: { ...f.api, daily: { ...f.api.daily } } }
          : kind === 'delegation' ? { api: { ...f.api, delegation: { ...f.api.delegation } } }
            : kind === 'guard' ? { scopeKey: 'changed' } : { disabled: true };
      view.rerender(<AccountIntakeRead {...props} {...change} />);
      expect(screen.queryByText(/Reading intake configuration/)).toBeNull();
      view.rerender(<AccountIntakeRead {...props} />);
    }
    await act(async () => pending.resolve(absent));
    if (kind === 'unmount') render(<AccountIntakeRead {...props} />);
    expect(screen.queryByText('No intake configuration exists.')).toBeNull();
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.calls).toEqual([]);
    if (kind === 'session') {
      f.read.mockResolvedValueOnce(absent);
      clickRead();
      expect(f.read).toHaveBeenCalledTimes(2);
      await screen.findByText('No intake configuration exists.');
      expect(f.calls).toEqual([]);
    }
  });
it('hides prior success and error immediately when the parent guard changes', async () => {
  const f = fixture();
  f.read.mockResolvedValueOnce(absent).mockRejectedValueOnce(Error('held'));
  const props = inlineProps(f);
  const view = render(<AccountIntakeRead {...props} />);
  clickRead();
  await screen.findByText('No intake configuration exists.');
  view.rerender(<AccountIntakeRead {...props} scopeKey="changed" />);
  expect(screen.queryByText('No intake configuration exists.')).toBeNull();
  clickRead();
  await screen.findByText(/Read again to retry explicitly/);
  view.rerender(<AccountIntakeRead {...props} />);
  expect(screen.queryByText(/Read again to retry explicitly/)).toBeNull();
  expect(screen.queryByText('No intake configuration exists.')).toBeNull();
});
it('discards stale errors and rejects mismatched reply scope instead of displaying absence', async () => {
  const f = fixture();
  const pending = deferred();
  f.read.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ...absent, workspaceId: 'foreign' });
  const props = inlineProps(f);
  const view = render(<AccountIntakeRead {...props} />);
  clickRead();
  view.rerender(<AccountIntakeRead {...props} scopeKey="changed" />);
  await act(async () => pending.reject(Error('stale')));
  expect(screen.queryByText(/Read again to retry explicitly/)).toBeNull();
  clickRead();
  await screen.findByText(/Read again to retry explicitly/);
  expect(screen.queryByText('No intake configuration exists.')).toBeNull();
});
it('nests the intake configuration controls after a successful read, bound to that read, without any automatic command or grant claim', async () => {
  const f = fixture();
  f.read.mockResolvedValue({ ...absent, configuration: { version: 1, workspaceId: 'ws', accountId: 'a', pairingId: 'pair', revision: 4, state: 'paused', mailboxSubject: null, calendarId: null, research: null } });
  const props = inlineProps(f);
  const view = render(<AccountIntakeRead {...props} />);
  expect(screen.queryByRole('region', { name: 'Intake configuration' })).toBeNull();
  clickRead();
  await screen.findByText('Intake configuration exists.');
  const panel = within(screen.getByRole('region', { name: 'Intake configuration' }));
  expect(panel.getByText('Revision 4 as read. Each change binds this revision; the worker refuses anything older.')).toBeTruthy();
  expect(panel.getByRole<HTMLButtonElement>('button', { name: 'Set intake active' }).disabled).toBe(false);
  // This fixture bridge has no grant knowledge: relevant mail is withheld with the reason, never offered.
  expect(panel.getByText('Grant status is unavailable in this bridge. Relevant mail is not offered.')).toBeTruthy();
  expect(panel.queryByRole('button', { name: 'Switch on relevant mail' })).toBeNull();
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.calls).toEqual([]);
  // The parent's guard closes the controls with the read.
  view.rerender(<AccountIntakeRead {...props} disabled />);
  expect(screen.queryByRole('region', { name: 'Intake configuration' })).toBeNull();
});
const unreachableLine = 'The worker could not be reached or refused the request. Read again to retry explicitly.';
it.each([
  ['preparation_unavailable', 'The worker has no record of this company yet.'],
  ['worker_scope_denied', "This Mac's pairing is not allowed to read this company."],
  ['preparation_changed', "The worker's record changed during the read. Read again."],
  ['worker_route_unavailable', 'The connected worker does not offer this request yet. It may need to be updated.'],
  ['worker_unavailable', unreachableLine],
  ['worker_invalid_request', unreachableLine],
  ['worker_unauthorized', unreachableLine],
  ['OUTREACH_REQUEST_FAILED', unreachableLine],
  ['PRIVATE token', unreachableLine],
])('names a %s read failure with exactly one honest line, never the code, and no automatic retry', async (code, line) => {
  const f = fixture();
  f.read.mockRejectedValueOnce(Error(code));
  render(<AccountIntakeRead {...inlineProps(f)} />);
  clickRead();
  await screen.findByText(line);
  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(screen.queryByText(new RegExp(code))).toBeNull();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('region', { name: 'Intake configuration' })).toBeNull();
  expect(f.calls).toEqual([]);
});
it('never promotes a rejection that is not an Error into a worker reason', async () => {
  const f = fixture();
  f.read.mockImplementationOnce(() => Promise.reject('preparation_unavailable'));
  render(<AccountIntakeRead {...inlineProps(f)} />);
  clickRead();
  await screen.findByText(unreachableLine);
  expect(screen.queryByText('The worker has no record of this company yet.')).toBeNull();
  expect(f.calls).toEqual([]);
});
