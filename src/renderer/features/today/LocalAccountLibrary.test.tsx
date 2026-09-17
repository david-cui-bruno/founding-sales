// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PresentationRoot } from '../../app/PresentationRoot';
import { NativeDeskRoute } from './NativeDeskRoute';
import { dailyFixture, fixtureNow, localSnapshot, nativeDeskFixture } from './nativeDesk.fixture';
import type { LocalAccountSnapshot, LocalCompanyDetail, LocalWorkspaceApi } from '../../../shared/contracts/localWorkspaceContract';

// Lane 6's real panel calls onEvidenceChanged once after a successful inbox admission (and after opening a draft).
// This stand-in exposes exactly that callback as one control, so the route's refresh wiring is tested without the
// admission form. It renders under the same landmark name the real panel uses.
vi.mock('./LocalCompanyDraft', () => ({
  LocalCompanyDraft: ({ onEvidenceChanged }: { onEvidenceChanged?: () => void }) =>
    <section aria-label="Company draft"><button type="button" onClick={() => onEvidenceChanged?.()}>Simulate admitted inbox</button></section>,
}));
afterEach(cleanup);

const beforeAdmission = 'Saved evidence has no published business inbox. Review a saved source or import a route before drafting.';
const afterAdmission = 'Saved evidence and a published business inbox are ready. Preparing a draft is explicit and saves locally only.';
function company(step: 'add_route' | 'draft'): LocalAccountSnapshot {
  const base = structuredClone(dailyFixture().accounts.find(item => item.account.id === 'a')!);
  return { ...base, preparation: step === 'add_route'
    ? { researched: true, unsentDraft: false, businessRoute: false, nextStep: 'add_route', reason: beforeAdmission }
    : { researched: true, unsentDraft: false, businessRoute: true, nextStep: 'draft', reason: afterAdmission } };
}
function detail(accountId: string): LocalCompanyDetail {
  const snapshot = structuredClone(dailyFixture().accounts.find(item => item.account.id === accountId)!);
  snapshot.portfolio = []; snapshot.claims = []; snapshot.routes = [];
  return { scope: 'local_database', generatedAt: fixtureNow, snapshot, sources: [], links: [] };
}

it('refreshes the local read when the draft panel reports changed evidence, so the ranked reason and step update without navigation', async () => {
  const f = nativeDeskFixture();
  f.setLocalSnapshot(localSnapshot({ accounts: { state: 'available', snapshots: [company('add_route')] } }));
  const getCompany = vi.fn<LocalWorkspaceApi['getCompany']>(async ({ accountId }) => detail(accountId));
  const api = { ...f.api, localWorkspace: { ...f.api.localWorkspace, getCompany } };
  render(<PresentationRoot><NativeDeskRoute firstUse={f.firstUse} api={api} surface="accounts" /></PresentationRoot>);
  const row = await screen.findByRole('button', { name: 'Local account · Account A' });
  expect(row.textContent).toContain(beforeAdmission);
  fireEvent.click(screen.getByRole('button', { name: 'Open route review · Account A' }));
  expect(row.getAttribute('aria-current')).toBe('true');
  const simulate = await screen.findByRole('button', { name: 'Simulate admitted inbox' });
  const readsBefore = f.calls.filter(call => call.method === 'localWorkspace.get').length;
  // The saved summary changes only in the local store; nothing here navigates or refreshes on its own.
  f.setLocalSnapshot(localSnapshot({ accounts: { state: 'available', snapshots: [company('draft')] } }));
  expect(screen.getByRole('button', { name: 'Local account · Account A' }).textContent).toContain(beforeAdmission);
  fireEvent.click(simulate);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Local account · Account A' }).textContent).toContain(afterAdmission));
  expect(screen.getByRole('button', { name: 'Open draft · Account A' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open route review · Account A' })).toBeNull();
  expect(f.calls.filter(call => call.method === 'localWorkspace.get')).toHaveLength(readsBefore + 1);
  // Still the same selected company on the same route; no second company read was forced by the refresh.
  expect(screen.getByRole('heading', { name: 'Account A' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Local account · Account A' }).getAttribute('aria-current')).toBe('true');
  expect(getCompany).toHaveBeenCalledTimes(1);
  expect(f.calls.some(call => call.method === 'forbidden')).toBe(false);
});
