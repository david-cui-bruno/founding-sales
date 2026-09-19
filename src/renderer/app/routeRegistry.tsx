import type { FirstUseContinuation } from '../features/today/localCompanyContinuation';
import type { ReactNode } from 'react';

import type { CalliePreloadApi } from '../../shared/preload';
import { SettingsScreen } from '../foundation/SettingsScreen';
import type { FoundationHealth } from '../foundation/useFoundationHealth';
import { NativeDeskRoute } from '../features/today/NativeDeskRoute';
import type { AppRoute } from './routes';
import type { DensityState } from './useDensity';
import type { ThemeState } from './useTheme';

export type RouteContext = {
  firstUse: FirstUseContinuation;
  api: CalliePreloadApi;
  health: FoundationHealth;
  theme: ThemeState;
  density: DensityState;
};

/** Central route table. Every navigation entry renders a real workspace. */
export function renderRoute(route: AppRoute, context: RouteContext): ReactNode {
  switch (route) {
    case 'today':
    case 'accounts':
    case 'campaigns':
      return <NativeDeskRoute firstUse={context.firstUse} api={context.api} surface={route} />;
    case 'settings':
      return (
        <SettingsScreen
          state={
            context.health.status === 'ready'
              ? { status: 'ready', health: context.health.health }
              : { status: context.health.status }
          }
          onRetry={context.health.retry}
          observation={context.health.observation}
          theme={context.theme}
          density={context.density}
          shell={context.api.shell}
          recovery={context.api.recovery}
          localWorkspaceApi={context.api.localWorkspace}
          outreachApi={context.api.outreach}
          phoneSetupApi={context.api.phoneSetup}
          delegationApi={context.api.delegation}
          templatesApi={context.api.templates}
        />
      );
  }
}
