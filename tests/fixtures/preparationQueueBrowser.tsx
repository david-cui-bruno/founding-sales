import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from '../../src/renderer/app/AppShell';
import { PresentationRoot } from '../../src/renderer/app/PresentationRoot';
import { useTheme } from '../../src/renderer/app/useTheme';
import { useDensity } from '../../src/renderer/app/useDensity';
import type { AppRoute } from '../../src/renderer/app/routes';
import { NativeDeskRoute } from '../../src/renderer/features/today/NativeDeskRoute';
import { localSnapshot, nativeDeskFixture, nativeDeskReviewFixture } from '../../src/renderer/features/today/nativeDesk.fixture';
import type { LocalAccountPreparation, LocalAccountPreparationStep, LocalAccountSnapshot } from '../../src/shared/contracts/localWorkspaceContract';
import '../../src/renderer/app.css';

// Explicit no-IO fixture. Preparation summaries are saved presentation data, exactly as the
// local provider would return them; nothing here researches, drafts, imports or sends.
const flags: Record<LocalAccountPreparationStep, Pick<LocalAccountPreparation, 'researched' | 'unsentDraft' | 'businessRoute'>> = {
  reopen_draft: { researched: true, unsentDraft: true, businessRoute: true }, draft: { researched: true, unsentDraft: false, businessRoute: true },
  add_route: { researched: true, unsentDraft: false, businessRoute: false }, research: { researched: false, unsentDraft: false, businessRoute: false },
  unknown: { researched: null, unsentDraft: null, businessRoute: null },
};
export const preparationReasons = {
  a: 'No research or saved sources yet. Research is an explicit, potentially paid step.',
  b: 'Saved evidence has no published business inbox. Review a saved source or import a route before drafting.',
  c: 'Saved evidence and a published business inbox are ready. Preparing a draft is explicit and saves locally only.',
  d: 'An unsent local draft is saved. Reopen to review it. Saving is not sending.',
  f: 'Local preparation evidence unavailable for this company. Open it to check again.',
} as const;
const company = (id: string, name: string, step?: LocalAccountPreparationStep, reason?: string): LocalAccountSnapshot => ({
  account: { id, name, domain: null, version: 1 }, claims: [], routes: [], portfolio: [], unknowns: [], conflicts: [], fingerprint: 'a'.repeat(64),
  ...(step && reason ? { preparation: { ...flags[step], nextStep: step, reason } } : {}),
});
// Scrambled on purpose: the renderer, not the fixture order, ranks the rows.
export const preparationAccounts = [
  company('a', 'Alpha New PM', 'research', preparationReasons.a), company('e', 'Echo Unassessed PM'),
  company('d', 'Delta Draft PM', 'reopen_draft', preparationReasons.d), company('f', 'Foxtrot Unknown PM', 'unknown', preparationReasons.f),
  company('c', 'Charlie Ready PM', 'draft', preparationReasons.c), company('b', 'Bravo Routeless PM', 'add_route', preparationReasons.b),
];
const fixture = nativeDeskFixture(nativeDeskReviewFixture());
fixture.setLocalSnapshot(localSnapshot({ accounts: { state: 'available', snapshots: preparationAccounts } }));
function Harness() {
  const { setPreference } = useTheme();
  const { setDensity } = useDensity();
  const [route, setRoute] = useState<'today' | 'accounts'>('accounts');
  const navigate = (next: AppRoute) => {
    if (next !== 'today' && next !== 'accounts') throw new Error(`Preparation queue fixture does not render ${next}.`);
    setRoute(next);
  };
  const [tick, setTick] = useState(0);
  window.preparationQueueBrowser = {
    fixture, navigate,
    refresh: () => window.dispatchEvent(new Event('focus')),
    rerender: () => setTick(value => value + 1),
    preferences: (theme, density) => { setPreference(theme); setDensity(density); },
  };
  return <PresentationRoot><AppShell route={route} onNavigate={navigate}>
    <div data-rerender={tick}><NativeDeskRoute firstUse={fixture.firstUse} key={route} api={fixture.api} surface={route} /></div>
  </AppShell></PresentationRoot>;
}
export type PreparationQueueBrowser = {
  fixture: typeof fixture; navigate(route: AppRoute): void;
  refresh(): void; rerender(): void;
  preferences(theme: 'system' | 'light' | 'dark', density: 'comfortable' | 'compact'): void;
};
declare global { interface Window { preparationQueueBrowser: PreparationQueueBrowser } }
document.documentElement.lang = 'en';
document.documentElement.dataset.theme = 'light';
document.documentElement.dataset.density = 'comfortable';
document.body.dataset.platform = 'darwin';
createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>);
