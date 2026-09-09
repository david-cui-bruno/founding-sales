import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from '../../src/renderer/app/AppShell';
import { useTheme } from '../../src/renderer/app/useTheme';
import { useDensity } from '../../src/renderer/app/useDensity';
import type { AppRoute } from '../../src/renderer/app/routes';
import { NativeDeskRoute } from '../../src/renderer/features/today/NativeDeskRoute';
import { nativeDeskFixture, nativeDeskReviewFixture } from '../../src/renderer/features/today/nativeDesk.fixture';
import { WorkflowSection } from '../../src/renderer/foundation/WorkflowSection';
import '../../src/renderer/app.css';

const fixture = nativeDeskFixture(nativeDeskReviewFixture());
const opened: string[] = [];
function Harness() {
  const {setPreference} = useTheme();
  const {setDensity} = useDensity();
  const [route, setRoute] = useState<AppRoute>('today');
  const [tick, setTick] = useState(0);
  const surface = route === 'accounts' || route === 'campaigns' ? route : 'today';
  window.nativeDeskBrowser = {
    fixture,
    opened,
    navigate: setRoute,
    refresh: () => window.dispatchEvent(new Event('focus')),
    rerender: () => setTick(value => value + 1),
    preferences: (theme, density) => {
      setPreference(theme);
      setDensity(density);
    },
  };
  return <AppShell route={route} onNavigate={setRoute} reviewCount={0}>
    <div data-rerender={tick}>{route === 'settings'
      ? <><h1>Settings</h1><WorkflowSection api={fixture.api.localWorkspace}/></>
      : <NativeDeskRoute key={route} api={fixture.api} onOpenLead={id => opened.push(id)} surface={surface} legacy={<h1>Legacy Today fixture</h1>}/>}</div>
  </AppShell>;
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
