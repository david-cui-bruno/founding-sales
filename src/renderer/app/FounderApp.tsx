import type { CalliePreloadApi } from '../../shared/preload';
import type { FoundationHealth } from '../foundation/useFoundationHealth';
import { useFirstUseContinuation } from '../features/today/LocalCompanyIntake';
import { LocalCompanyIntakeProvider } from '../features/today/LocalCompanyIntakeProvider';
import { AppShell } from './AppShell';
import { CommandPalette } from './commandPalette/CommandPalette';
import { renderRoute } from './routeRegistry';
import type { AppRoute } from './routes';
import type { DensityState } from './useDensity';
import { useHashRoute } from './useHashRoute';
import type { ThemeState } from './useTheme';

export type FounderAppProps = {
  api: CalliePreloadApi;
  health: FoundationHealth;
  theme: ThemeState;
  density: DensityState;
  initialRoute?: AppRoute;
};

/**
 * The healthy application: the routed company workspace (Today, Accounts,
 * Campaigns, Settings) inside the fixed navigation shell.
 */
export function FounderApp({ api, health, theme, density, initialRoute }: FounderAppProps) {
  return (
    <LocalCompanyIntakeProvider api={api.localWorkspace}>
      <FounderWorkspace api={api} health={health} theme={theme} density={density} initialRoute={initialRoute} />
    </LocalCompanyIntakeProvider>
  );
}

function FounderWorkspace({ api, health, theme, density, initialRoute }: FounderAppProps) {
  const firstUse = useFirstUseContinuation();
  const routing = useHashRoute(initialRoute ?? 'today');

  return (
    <>
      <AppShell route={routing.route} onNavigate={routing.navigate}>
        <div key={routing.route}>
          {renderRoute(routing.route, { api, firstUse, health, theme, density })}
        </div>
      </AppShell>
      <CommandPalette navigate={routing.navigate} />
    </>
  );
}
