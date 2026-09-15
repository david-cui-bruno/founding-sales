// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompanyResearchSettings, LocalWorkspaceApi } from '../../shared/contracts/localWorkspaceContract';
import { LocalCompanyResearchSection } from './LocalCompanyResearchSection';

afterEach(cleanup);
const profile = { id: 'reviewed-fixture', label: 'Reviewed fixture', reviewedAt: '2026-09-15', referenceUrl: 'https://example.test/model', researchLimits: { maxCompanies: 1, maxPages: 1, maxBytes: 250000, maxCostMicros: 20000, knownCompanyExtraction: { version: 1 as const, model: 'fixture-model', maxCostMicros: 20000, maxInputBytes: 20000, maxOutputTokens: 2048, inputMicrosPerMillionTokens: 400000, outputMicrosPerMillionTokens: 1600000 } } };
const initial = (): CompanyResearchSettings => ({ revision: 0, configuration: null, profiles: [profile], blockedReason: null, reservedOrSpentMicros: 12345 });
function fixture(value = initial()) {
  const api = { getCompanyResearchSettings: vi.fn(async () => value), updateCompanyResearchSettings: vi.fn<LocalWorkspaceApi['updateCompanyResearchSettings']>(async input => ({ ...value, revision: input.expectedRevision + 1, configuration: input.configuration })) };
  return api;
}
async function mount(api = fixture()) { render(<LocalCompanyResearchSection api={api} />); await screen.findByText('fixture-model'); return api; }
function fill() {
  fireEvent.change(screen.getByLabelText('Explicit HTTPS source URLs'), { target: { value: 'https://fictional.example/about' } });
  fireEvent.change(screen.getByLabelText('Cumulative local ceiling (USD)'), { target: { value: '5.00' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'I have reviewed this setup' }));
}
it('mounts read-only with empty sources/budget and unchecked consent, main profile advanced limits collapsed', async () => {
  const api = await mount();
  expect(api.updateCompanyResearchSettings).not.toHaveBeenCalled();
  expect((screen.getByLabelText('Explicit HTTPS source URLs') as HTMLTextAreaElement).value).toBe('');
  expect((screen.getByLabelText('Cumulative local ceiling (USD)') as HTMLInputElement).value).toBe('');
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText(/Advanced limits/).closest('details')?.open).toBe(false);
  expect(screen.getByText(/Reserved or known spend:.*0.012345/)).toBeTruthy();
});
it('saves only explicitly acknowledged exact profile and parses dollar ceiling without floating-point rounding', async () => {
  const api = await mount(); fill(); fireEvent.click(screen.getByRole('button', { name: 'Save local research' }));
  await screen.findByText('Saved locally. Research has not started.');
  expect(api.updateCompanyResearchSettings).toHaveBeenCalledTimes(1);
  expect(api.updateCompanyResearchSettings.mock.calls[0][0]).toEqual({ expectedRevision: 0, reviewed: true, configuration: { version: 1, mode: 'known_company', state: 'active', profileId: profile.id, researchLimits: profile.researchLimits, maxAccountBudgetMicros: 5000000, permittedSources: ['https://fictional.example/about'] } });
});
it('retains unknown edits, requires explicit refresh and revision review, never automatically retries', async () => {
  const api = await mount(); api.updateCompanyResearchSettings.mockRejectedValueOnce(Error('private error')); fill();
  fireEvent.click(screen.getByRole('button', { name: 'Save local research' }));
  await screen.findByText(/Save outcome unknown/);
  expect(api.getCompanyResearchSettings).toHaveBeenCalledTimes(1);
  expect((screen.getByLabelText('Cumulative local ceiling (USD)') as HTMLInputElement).value).toBe('5.00');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh current settings' }));
  await waitFor(() => expect(api.getCompanyResearchSettings).toHaveBeenCalledTimes(2));
  await screen.findByRole('button', { name: 'I reviewed current settings' });
  expect(api.updateCompanyResearchSettings).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'I reviewed current settings' }));
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  expect(screen.queryByText('private error')).toBeNull();
});
it('treats a mismatched save reply as unknown rather than saved', async () => {
  const api = await mount(); api.updateCompanyResearchSettings.mockResolvedValueOnce(initial()); fill();
  fireEvent.click(screen.getByRole('button', { name: 'Save local research' })); await screen.findByText(/Save outcome unknown/);
  expect(screen.queryByText('Saved locally. Research has not started.')).toBeNull();
});
it('safe pause preserves stored fields rather than unsaved edits even during conflict', async () => {
  const value = initial(); value.revision = 4; value.blockedReason = 'paired_research_present';
  value.configuration = { version: 1, mode: 'known_company', state: 'active', profileId: profile.id, researchLimits: profile.researchLimits, maxAccountBudgetMicros: 5000000, permittedSources: ['https://old.example/about'] };
  const api = await mount(fixture(value)); fill();
  fireEvent.click(screen.getByRole('button', { name: 'Pause local research' })); await screen.findByText('Local research paused. Reviewed settings and accounting are retained.');
  expect(api.updateCompanyResearchSettings.mock.calls[0][0]).toEqual({ expectedRevision: 4, reviewed: false, configuration: { ...value.configuration, state: 'paused' } });
  expect((screen.getByLabelText('Explicit HTTPS source URLs') as HTMLTextAreaElement).value).toBe('https://fictional.example/about');
});
it('refreshes stored-model mismatch hint after connection changes without provider work', async () => {
  const api = fixture(); const outreach = { status: vi.fn(async () => ({ model: 'ready' as const, modelName: 'other-model', gmail: 'unconfigured' as const, accountEmail: null, senderName: '', postalAddress: '' })) };
  const view = render(<LocalCompanyResearchSection api={api} outreachApi={outreach} connectionRevision={0} />);
  await screen.findByText(/Stored model does not match/);
  outreach.status.mockResolvedValue({ model: 'ready', modelName: 'fixture-model', gmail: 'unconfigured', accountEmail: null, senderName: '', postalAddress: '' });
  view.rerender(<LocalCompanyResearchSection api={api} outreachApi={outreach} connectionRevision={1} />);
  await screen.findByText(/Stored model matches/); expect(api.updateCompanyResearchSettings).not.toHaveBeenCalled();
  await act(async () => {});
});
it('retains edits and unknown outcomes across repeated Settings navigation without automatic writes', async () => {
  const api = fixture(); api.updateCompanyResearchSettings.mockRejectedValueOnce(Error('lost reply'));
  let view = render(<LocalCompanyResearchSection api={api} />); await screen.findByText('fixture-model'); fill();
  fireEvent.click(screen.getByRole('button', { name: 'Save local research' })); await screen.findByText(/Save outcome unknown/); view.unmount();
  view = render(<LocalCompanyResearchSection api={api} />); await screen.findByText(/Retained edits/);
  expect((screen.getByLabelText('Cumulative local ceiling (USD)') as HTMLInputElement).value).toBe('5.00');
  fireEvent.change(screen.getByLabelText('Cumulative local ceiling (USD)'), { target: { value: '7.00' } }); view.unmount();
  render(<LocalCompanyResearchSection api={api} />); await screen.findByText(/Retained edits/);
  expect((screen.getByLabelText('Cumulative local ceiling (USD)') as HTMLInputElement).value).toBe('7.00');
  expect((screen.getByRole('button', { name: 'Save local research' }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.updateCompanyResearchSettings).toHaveBeenCalledTimes(1);
});
it.each(['https://user:password@fictional.example/about', 'http://fictional.example/about', 'not a URL'])('rejects invalid source %s locally without issuing a write', async source => {
  const api = await mount(); fill(); fireEvent.change(screen.getByLabelText('Explicit HTTPS source URLs'), { target: { value: source } });
  fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Save local research' }));
  await screen.findByText(/Enter explicit HTTPS/); expect(api.updateCompanyResearchSettings).not.toHaveBeenCalled();
});
it('rechecks acknowledgment after any edit and keeps exact six-decimal budget', async () => {
  const api = await mount(); fill();
  fireEvent.change(screen.getByLabelText('Cumulative local ceiling (USD)'), { target: { value: '0.123456' } });
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Save local research' }));
  await screen.findByText('Saved locally. Research has not started.');
  expect(api.updateCompanyResearchSettings.mock.calls[0][0].configuration.maxAccountBudgetMicros).toBe(123456);
});
it('does not borrow a late settings response from a replaced API owner', async () => {
  let resolve!: (value: CompanyResearchSettings) => void;
  const api = fixture(); api.getCompanyResearchSettings.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const other = fixture({ ...initial(), profiles: [] });
  const view = render(<LocalCompanyResearchSection api={api} />); view.rerender(<LocalCompanyResearchSection api={other} />);
  await waitFor(() => expect(other.getCompanyResearchSettings).toHaveBeenCalled());
  await act(async () => { resolve(initial()); });
  expect(screen.queryByText('fixture-model')).toBeNull(); expect(api.updateCompanyResearchSettings).not.toHaveBeenCalled();
});
it('explicit refresh identifies exact lost-save match without issuing another command', async () => {
  const api = await mount(); let committed = initial();
  api.updateCompanyResearchSettings.mockImplementationOnce(async input => { committed = { ...initial(), revision: input.expectedRevision + 1, configuration: input.configuration }; throw Error('lost'); });
  fill(); fireEvent.click(screen.getByRole('button', { name: 'Save local research' })); await screen.findByText(/Save outcome unknown/);
  api.getCompanyResearchSettings.mockResolvedValue(committed);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh current settings' }));
  await screen.findByText(/Current stored record exactly matches the attempted save/);
  expect(api.updateCompanyResearchSettings).toHaveBeenCalledTimes(1);
});
it('retains edits through a failed initial read and explicit refresh', async () => {
  const api = fixture(); api.getCompanyResearchSettings.mockRejectedValueOnce(Error('locked'));
  render(<LocalCompanyResearchSection api={api} />); await screen.findByText(/Local research settings are unavailable/);
  fireEvent.change(screen.getByLabelText('Explicit HTTPS source URLs'), { target: { value: 'https://retained.example/about' } });
  fireEvent.change(screen.getByLabelText('Cumulative local ceiling (USD)'), { target: { value: '8.50' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh current settings' })); await screen.findByText('fixture-model');
  expect((screen.getByLabelText('Explicit HTTPS source URLs') as HTMLTextAreaElement).value).toBe('https://retained.example/about');
  expect((screen.getByLabelText('Cumulative local ceiling (USD)') as HTMLInputElement).value).toBe('8.50');
  expect(api.updateCompanyResearchSettings).not.toHaveBeenCalled();
});
it('retains an in-flight attempt after navigation and never accepts its late reply into the remounted view', async () => {
  const api = fixture(); let resolve!: (value: CompanyResearchSettings) => void;
  api.updateCompanyResearchSettings.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const view = render(<LocalCompanyResearchSection api={api} />); await screen.findByText('fixture-model'); fill();
  fireEvent.click(screen.getByRole('button', { name: 'Save local research' })); await screen.findByText('Saving locally…');
  const attempted = api.updateCompanyResearchSettings.mock.calls[0][0]; view.unmount();
  render(<LocalCompanyResearchSection api={api} />); await screen.findByText(/Retained edits/);
  await act(async () => { resolve({ ...initial(), revision: 1, configuration: attempted.configuration }); });
  expect(screen.queryByText('Saved locally. Research has not started.')).toBeNull();
  expect((screen.getByRole('button', { name: 'Save local research' }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.updateCompanyResearchSettings).toHaveBeenCalledTimes(1);
});
it.each(['older', 'same-revision-different-config'] as const)('rejects %s refresh without rewinding known settings or losing edits', async kind => {
  const known = { ...initial(), revision: 4 }; const api = await mount(fixture(known)); fill();
  api.updateCompanyResearchSettings.mockRejectedValueOnce(Error('unknown'));
  fireEvent.click(screen.getByRole('button', { name: 'Save local research' })); await screen.findByText(/Save outcome unknown/);
  const read = { ...initial(), revision: kind === 'older' ? 3 : 4, configuration: kind === 'older' ? null : api.updateCompanyResearchSettings.mock.calls[0][0].configuration };
  api.getCompanyResearchSettings.mockResolvedValue(read);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh current settings' }));
  await screen.findByText(/Current settings unavailable/);
  expect(screen.queryByRole('button', { name: 'I reviewed current settings' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Save local research' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText('Cumulative local ceiling (USD)') as HTMLInputElement).value).toBe('5.00');
  expect(api.updateCompanyResearchSettings).toHaveBeenCalledTimes(1);
});
it('accepts same-revision accounting updates without inventing a configuration change', async () => {
  const api = await mount(); fill(); api.getCompanyResearchSettings.mockResolvedValue({ ...initial(), reservedOrSpentMicros: 30000 });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh current settings' })); await screen.findByRole('button', { name: 'I reviewed current settings' });
  fireEvent.click(screen.getByRole('button', { name: 'I reviewed current settings' }));
  expect(screen.getByText(/Reserved or known spend:.*0.03/)).toBeTruthy();
  expect((screen.getByLabelText('Cumulative local ceiling (USD)') as HTMLInputElement).value).toBe('5.00');
  expect(api.updateCompanyResearchSettings).not.toHaveBeenCalled();
});
it('retains null-snapshot edits after a read error through navigation and remount', async () => {
  const api = fixture(); api.getCompanyResearchSettings.mockRejectedValueOnce(Error('locked'));
  const view = render(<LocalCompanyResearchSection api={api} />); await screen.findByText(/Local research settings are unavailable/);
  fireEvent.change(screen.getByLabelText('Explicit HTTPS source URLs'), { target: { value: 'https://retained.example/about' } });
  fireEvent.change(screen.getByLabelText('Cumulative local ceiling (USD)'), { target: { value: '8.50' } }); view.unmount();
  render(<LocalCompanyResearchSection api={api} />); await screen.findByText(/Retained edits/);
  expect((screen.getByLabelText('Explicit HTTPS source URLs') as HTMLTextAreaElement).value).toBe('https://retained.example/about');
  expect((screen.getByLabelText('Cumulative local ceiling (USD)') as HTMLInputElement).value).toBe('8.50');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh current settings' })); await screen.findByText('fixture-model');
  fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Save local research' }));
  await screen.findByText('Saved locally. Research has not started.');
  expect(api.updateCompanyResearchSettings.mock.calls[0][0].configuration.maxAccountBudgetMicros).toBe(8500000);
  expect(api.updateCompanyResearchSettings.mock.calls[0][0].configuration.permittedSources).toEqual(['https://retained.example/about']);
});
it.each([false, true])('does not forget a newer unacknowledged read before another refresh (navigate=%s)', async navigate => {
  const api = fixture(); let view = render(<LocalCompanyResearchSection api={api} />); await screen.findByText('fixture-model'); fill();
  api.getCompanyResearchSettings.mockResolvedValueOnce({ ...initial(), revision: 2 });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh current settings' })); await screen.findByText('Current stored settings · revision 2');
  if (navigate) { view.unmount(); view = render(<LocalCompanyResearchSection api={api} />); await screen.findByText(/Retained edits/); }
  api.getCompanyResearchSettings.mockResolvedValueOnce(initial());
  fireEvent.click(screen.getByRole('button', { name: 'Refresh current settings' })); await screen.findByText(/Current settings unavailable/);
  expect(screen.queryByRole('button', { name: 'I reviewed current settings' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Save local research' }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.updateCompanyResearchSettings).not.toHaveBeenCalled();
});
