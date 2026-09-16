import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from '../../src/renderer/app/AppShell';
import { PresentationRoot } from '../../src/renderer/app/PresentationRoot';
import { useTheme } from '../../src/renderer/app/useTheme';
import { useDensity } from '../../src/renderer/app/useDensity';
import type { AppRoute } from '../../src/renderer/app/routes';
import { NativeDeskRoute } from '../../src/renderer/features/today/NativeDeskRoute';
import { localSnapshot, nativeDeskFixture, nativeDeskReviewFixture } from '../../src/renderer/features/today/nativeDesk.fixture';
import type { LocalAccountSnapshot, LocalCompanyDetail, LocalWorkspaceApi } from '../../src/shared/contracts/localWorkspaceContract';
import '../../src/renderer/app.css';

// Explicit no-IO fixture: one local company whose only saved source is shaped like the Lenox contact page from the
// 2026-09-16 walkthrough, served from memory. Admission, opening, research, import and sending stay unavailable here.
const at = '2026-09-15T18:40:27.911Z';
export const lenoxSource = {
  id: 'source-lenox', url: 'https://lenoxmanagement.com/', fetchedAt: at, sha256: 'c'.repeat(64), permitted: true,
  excerpt: 'Lenox Management\n\nProperty management, leasing and REO services across Rhode Island and Southeastern Massachusetts since 2004.'
    + '\n\nContact Us\n\n380 Broadway Providence, Rhode Island 02909\n\ninfo@lenoxmanagement.com\n\n401-572-3322'
    + '\n\nOur in-house maintenance team coordinates repairs for the properties we manage.\n\nTenants\n\ntenants@lenoxmanagement.com',
};
const account: LocalCompanyDetail['snapshot'] = { account: { id: 'lenox', name: 'Lenox Management', domain: 'lenoxmanagement.com', version: 1 },
  claims: [], routes: [], portfolio: [], unknowns: [], conflicts: [], fingerprint: 'a'.repeat(64) };
const company: LocalAccountSnapshot = { ...account, preparation: { researched: true, unsentDraft: false, businessRoute: false, nextStep: 'add_route',
  reason: 'Saved evidence has no published business inbox. Review a saved source or import a route before drafting.' } };
const detail: LocalCompanyDetail = { scope: 'local_database', generatedAt: at, snapshot: account, sources: [lenoxSource], links: [] };
const fixture = nativeDeskFixture(nativeDeskReviewFixture());
fixture.setLocalSnapshot(localSnapshot({ accounts: { state: 'available', snapshots: [company] } }));
const getCompany: LocalWorkspaceApi['getCompany'] = async input => {
  fixture.calls.push({ method: 'localWorkspace.getCompany', input: structuredClone(input) });
  if (input.accountId !== account.account.id) throw Error('Selected company detail unavailable in this fixture');
  return structuredClone(detail);
};
const admitCompanyDraftEmail: LocalWorkspaceApi['admitCompanyDraftEmail'] = async input => {
  fixture.calls.push({ method: 'localWorkspace.admitCompanyDraftEmail', input: structuredClone(input) });
  throw Error('Inbox admission unavailable in this fixture');
};
const api = { ...fixture.api, localWorkspace: { ...fixture.api.localWorkspace, getCompany, admitCompanyDraftEmail } };
const opened: string[] = [];
function Harness() {
  const { setPreference } = useTheme();
  const { setDensity } = useDensity();
  const [route, setRoute] = useState<'today' | 'accounts'>('accounts');
  const navigate = (next: AppRoute) => {
    if (next !== 'today' && next !== 'accounts') throw new Error(`Inbox prefill fixture does not render ${next}.`);
    setRoute(next);
  };
  const [tick, setTick] = useState(0);
  window.inboxPrefillBrowser = {
    fixture, opened, navigate,
    rerender: () => setTick(value => value + 1),
    preferences: (theme, density) => { setPreference(theme); setDensity(density); },
  };
  return <PresentationRoot><AppShell route={route} onNavigate={navigate} reviewCount={{ status: 'failed' }}>
    <div data-rerender={tick}><NativeDeskRoute onOpenImport={() => opened.push('import')} firstUse={fixture.firstUse} key={route} api={api} onOpenLead={id => opened.push(id)} surface={route} legacy={<h1>Legacy Today fixture</h1>} /></div>
  </AppShell></PresentationRoot>;
}
export type InboxPrefillBrowser = {
  fixture: typeof fixture; opened: string[]; navigate(route: AppRoute): void; rerender(): void;
  preferences(theme: 'system' | 'light' | 'dark', density: 'comfortable' | 'compact'): void;
};
declare global { interface Window { inboxPrefillBrowser: InboxPrefillBrowser } }
document.documentElement.lang = 'en';
document.documentElement.dataset.theme = 'light';
document.documentElement.dataset.density = 'comfortable';
document.body.dataset.platform = 'darwin';
createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>);
