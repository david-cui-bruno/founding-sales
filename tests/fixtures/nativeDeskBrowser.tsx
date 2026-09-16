import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from '../../src/renderer/app/AppShell';
import { PresentationRoot } from '../../src/renderer/app/PresentationRoot';
import { useTheme } from '../../src/renderer/app/useTheme';
import { useDensity } from '../../src/renderer/app/useDensity';
import { routeFromHash, routeHash, type AppRoute } from '../../src/renderer/app/routes';
import { NativeDeskRoute } from '../../src/renderer/features/today/NativeDeskRoute';
import { nativeDeskFixture, nativeDeskReviewFixture } from '../../src/renderer/features/today/nativeDesk.fixture';
import { WorkflowSection } from '../../src/renderer/foundation/WorkflowSection';
import '../../src/renderer/app.css';

const fixture = nativeDeskFixture(nativeDeskReviewFixture());
const opened: string[] = [];
function Harness() {
  const {setPreference} = useTheme();
  const {setDensity} = useDensity();
  const [route, setRoute] = useState<'today' | 'accounts' | 'campaigns' | 'settings'>('today');
  const navigate = (next: AppRoute) => {
    if (next !== 'today' && next !== 'accounts' && next !== 'campaigns' && next !== 'settings') throw new Error(`Isolated Native Desk fixture does not render ${next}. Use applicationPresentationBrowser.`);
    // Keep the hash in step, as the app's hash routing does, so route-owned hash navigation reaches this harness too.
    if (window.location.hash !== routeHash(next)) window.location.hash = routeHash(next);
    setRoute(next);
  };
  useEffect(() => {
    const onHashChange = () => { const next = routeFromHash(window.location.hash); if (next !== null) navigate(next); };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const [tick, setTick] = useState(0);
  const surface = route === 'accounts' || route === 'campaigns' ? route : 'today';
  window.nativeDeskBrowser = {
    fixture,
    opened,
    navigate,
    refresh: () => window.dispatchEvent(new Event('focus')),
    rerender: () => setTick(value => value + 1),
    preferences: (theme, density) => {
      setPreference(theme);
      setDensity(density);
    },
  };
  return <PresentationRoot><AppShell route={route} onNavigate={navigate} reviewCount={{ status: 'failed' }}>
    <div data-rerender={tick}>{route === 'settings'
      ? <><h1>Settings</h1><WorkflowSection api={fixture.api.localWorkspace}/></>
      : <NativeDeskRoute onOpenImport={(): void => undefined} firstUse={fixture.firstUse} key={route} api={fixture.api} onOpenLead={id => opened.push(id)} surface={surface} legacy={<h1>Legacy Today fixture</h1>}/>}</div>
  </AppShell></PresentationRoot>;
}
export type NativeDeskBrowser = {
  fixture: typeof fixture;
  opened: string[];
  navigate(route: AppRoute): void;
  refresh(): void;
  rerender(): void;
  preferences(theme: 'system' | 'light' | 'dark', density: 'comfortable' | 'compact'): void;
};
declare global { interface Window { nativeDeskBrowser: NativeDeskBrowser } }
document.documentElement.lang = 'en';
document.documentElement.dataset.theme = 'light';
document.documentElement.dataset.density = 'comfortable';
document.body.dataset.platform = 'darwin';
createRoot(document.getElementById('root')!).render(<StrictMode><Harness/></StrictMode>);
