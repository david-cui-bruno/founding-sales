import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from '../../src/renderer/app/AppShell';
import { PresentationRoot } from '../../src/renderer/app/PresentationRoot';
import { useTheme } from '../../src/renderer/app/useTheme';
import { useDensity } from '../../src/renderer/app/useDensity';
import type { AppRoute } from '../../src/renderer/app/routes';
import { NativeDeskRoute } from '../../src/renderer/features/today/NativeDeskRoute';
import { compositionFixture } from './nativeDeskCompositionData';
import '../../src/renderer/app.css';

const rawScenario = new URL(location.href).searchParams.get('scenario');
const fixture = compositionFixture(rawScenario === 'unpaired' || rawScenario === 'missing' ? rawScenario : 'populated');
function Harness() {
  const { setPreference } = useTheme();
  const { setDensity } = useDensity();
  const [route, setRoute] = useState<'today' | 'accounts' | 'campaigns'>('today');
  const navigate = (next: AppRoute) => {
    if (next !== 'today' && next !== 'accounts' && next !== 'campaigns') throw new Error(`Isolated composition fixture does not render ${next}. Use applicationPresentationBrowser.`);
    setRoute(next);
  };
  const [tick, setTick] = useState(0);
  const surface = route === 'accounts' || route === 'campaigns' ? route : 'today';
  window.nativeDeskCompositionBrowser = {
    fixture, navigate,
    refresh: () => window.dispatchEvent(new Event('focus')),
    rerender: () => setTick(v => v + 1),
    preferences: (theme, density) => { setPreference(theme); setDensity(density); },
  };
  return <PresentationRoot><AppShell route={route} onNavigate={navigate}>
    <div data-rerender={tick}><NativeDeskRoute firstUse={fixture.firstUse} key={route} api={fixture.api} surface={surface} /></div>
  </AppShell></PresentationRoot>;
}
export type NativeDeskCompositionBrowser = {
  fixture: typeof fixture; navigate(route: AppRoute): void;
  refresh(): void; rerender(): void;
  preferences(theme: 'system' | 'light' | 'dark', density: 'comfortable' | 'compact'): void;
};
declare global { interface Window { nativeDeskCompositionBrowser: NativeDeskCompositionBrowser } }
document.documentElement.lang = 'en';
document.documentElement.dataset.theme = 'light';
document.documentElement.dataset.density = 'compact';
document.body.dataset.platform = 'darwin';
createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>);
