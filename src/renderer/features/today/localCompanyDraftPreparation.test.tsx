// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalCompanyDraft } from './LocalCompanyDraft';
import { nativeDeskFixture, dailyFixture } from './nativeDesk.fixture';
import type { LocalCompanyDetail } from '../../../shared/contracts/localWorkspaceContract';
import type { CompanyDraftRead, PreparedCompanyDraft } from '../../../shared/contracts/localCompanyDraftContract';
afterEach(cleanup);
const at = '2026-09-15T12:00:00.000Z';
function fixture() {
  const snapshot = structuredClone(dailyFixture().accounts.find(item => item.account.id === 'a')!);
  const source = { id: 'source-a', url: 'https://a.example/contact', fetchedAt: at, sha256: 'c'.repeat(64),
    excerpt: 'Residential homes. Business email: info@a.example', permitted: true };
  const recipientBinding = { routeId: 'route-a', routeVersion: 1, email: 'info@a.example', personId: null as null };
  snapshot.routes = [{ id: 'route-a', version: 1, accountId: 'a', personId: null, channel: 'email', value: recipientBinding.email,
    purpose: 'business', verification: 'published', evidenceIds: [source.id] }];
  snapshot.claims = []; snapshot.portfolio = [];
  const detail: LocalCompanyDetail = { scope: 'local_database', generatedAt: at, snapshot, sources: [source], links: [] };
  let current: CompanyDraftRead = { stale: false, reason: null, editable: true, draft: {
    kind: 'local_company_email', status: 'unsent', id: 'draft-a', accountId: 'a', revision: 1, recipientBinding,
    accountVersionAtOpen: snapshot.account.version, companyLabel: snapshot.account.name, sourceIds: [source.id],
    publication: { sourceId: source.id, url: source.url, sha256: source.sha256, fetchedAt: at, quote: 'Business email: info@a.example' },
    subject: '', body: '', createdAt: at, updatedAt: at } };
  const fact = { id: `company-draft:${'a'.repeat(64)}`, text: 'Company-only context. '+JSON.stringify({ company: { id: 'a', name: snapshot.account.name },
    claim: { key: 'residential_scope', value: 'Residential homes' }, sources: [{ id: source.id, url: source.url, sha256: source.sha256, fetchedAt: at }] }) };
  const proposal: PreparedCompanyDraft = { accountId: 'a', draftId: 'draft-a', baseRevision: 1, accountVersion: snapshot.account.version,
    recipientBinding, subject: 'Your residential maintenance workflow', body: 'Hello,\n\nI saw that your company manages residential homes. How does your team coordinate maintenance today?',
    grounding: { facts: [fact], usedFactIds: [fact.id], playbookVersion: '2026-09-16' } };
  const prepare = vi.fn(async () => structuredClone(proposal));
  const save = vi.fn(async (input: { commandId: string; expectedRevision: number; subject: string; body: string }) => {
    expect(input.expectedRevision).toBe(current.draft.revision);
    current = { ...current, draft: { ...current.draft, subject: input.subject, body: input.body, revision: input.expectedRevision + 1 } };
    return { current: structuredClone(current), receipt: { commandId: input.commandId, accountId: 'a', draftId: 'draft-a', operation: 'save' as const,
      appliedRevision: current.draft.revision, recipientBinding, publication: current.draft.publication } };
  });
  const api = { ...nativeDeskFixture().api.localWorkspace, prepareCompanyDraft: prepare,
    getCompanyDraft: vi.fn(async () => structuredClone(current)), saveCompanyDraft: save };
  return { api, prepare, proposal, detail, save, saved: () => current };
}
async function open() { if (!screen.queryByRole('textbox', { name: 'Subject' })) fireEvent.click(await screen.findByRole('button', { name: 'Reopen company draft' })); await screen.findByRole('textbox', { name: 'Subject' }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
it('prepares an unsaved suggestion only on explicit click, shows its company facts, and saves exact reviewed text through the existing editor', async () => {
  const f = fixture(); const view = render(<LocalCompanyDraft api={f.api} detail={f.detail} />); await open();
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare company draft' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveProperty('value', f.proposal.subject));
  expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.prepare).toHaveBeenCalledWith({ accountId: 'a', draftId: 'draft-a', expectedRevision: 1 });
  expect(f.saved().draft.body).toBe(''); expect(f.save).not.toHaveBeenCalled();
  expect(screen.getByText('residential scope: Residential homes', { exact: true })).toBeTruthy();
  const exact = 'Reviewed wording · café\nExact trailing spaces  ';
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: exact } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' })); await waitFor(() => expect(f.saved().draft.body).toBe(exact));
  view.unmount(); render(<LocalCompanyDraft api={f.api} detail={f.detail} />); await open();
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', exact); expect(f.prepare).toHaveBeenCalledTimes(1);
});
it.each(['typing', 'unmount', 'account-change'])('does not install a delayed proposal after %s', async change => {
  const f = fixture(), pending = deferred<typeof f.proposal>(); f.prepare.mockImplementationOnce(() => pending.promise);
  const view = render(<LocalCompanyDraft api={f.api} detail={f.detail} />); await open();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare company draft' }));
  if (change === 'typing') fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'My newer words' } });
  else if (change === 'unmount') view.unmount();
  else view.rerender(<LocalCompanyDraft api={f.api} detail={{ ...f.detail, snapshot: { ...f.detail.snapshot, account: { ...f.detail.snapshot.account, version: f.detail.snapshot.account.version + 1 } } }} />);
  await act(async () => { pending.resolve(f.proposal); await pending.promise; });
  if (change === 'unmount') { render(<LocalCompanyDraft api={f.api} detail={f.detail} />); await open(); }
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', change === 'typing' ? 'My newer words' : '');
  expect(f.save).not.toHaveBeenCalled(); expect(f.prepare).toHaveBeenCalledTimes(1);
});
it('rejects a crossed recipient proposal and leaves the blank saved draft unchanged', async () => {
  const f = fixture(); f.prepare.mockResolvedValueOnce({ ...f.proposal, recipientBinding: { ...f.proposal.recipientBinding, email: 'foreign@example.com' } } as typeof f.proposal);
  render(<LocalCompanyDraft api={f.api} detail={f.detail} />); await open(); fireEvent.click(screen.getByRole('button', { name: 'Prepare company draft' }));
  await screen.findByRole('alert'); expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', ''); expect(f.save).not.toHaveBeenCalled();
});
it('does not automatically retry an uncertain model request on remount', async () => {
  const f = fixture(); f.prepare.mockRejectedValueOnce(Error('private provider text'));
  const view = render(<LocalCompanyDraft api={f.api} detail={f.detail} />); await open(); fireEvent.click(screen.getByRole('button', { name: 'Prepare company draft' }));
  const alert = await screen.findByRole('alert'); expect(alert.textContent).not.toContain('private provider text');
  view.unmount(); render(<LocalCompanyDraft api={f.api} detail={f.detail} />); await open();
  expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.save).not.toHaveBeenCalled();
});
