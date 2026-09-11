import { useEffect, useRef, useState } from 'react';

import type { CalliePreloadApi } from '../../shared/preload';
import type { FoundationHealth } from '../foundation/useFoundationHealth';
import { ImportDialog } from '../features/import/ImportDialog';
import { LeadInspectorProvider } from '../features/leadInspector/LeadInspectorProvider';
import { useLeadInspector } from '../features/leadInspector/useLeadInspector';
import { AppShell } from './AppShell';
import { useReviewSummary } from './useReviewSummary';
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
 * The healthy application: one global lead inspector wrapping the routed
 * workspace, one global import dialog, and the fixed navigation shell.
 */
export function FounderApp({ api, health, theme, density, initialRoute }: FounderAppProps) {
  return (
    <LeadInspectorProvider api={api.leadDetail} outreachApi={api.outreach} discoveryApi={api.discovery} pastActivityApi={api.today} outcomeApi={api.today}>
      <FounderWorkspace api={api} health={health} theme={theme} density={density} initialRoute={initialRoute} />
    </LeadInspectorProvider>
  );
}

function FounderWorkspace({ api, health, theme, density, initialRoute }: FounderAppProps) {
  const routing = useHashRoute(initialRoute ?? 'today');
  const inspector = useLeadInspector();
  const [importOpen, setImportOpen] = useState(false);
  const reviewSummary = useReviewSummary(api.review);
  const previousRoute = useRef(routing.route);
  useEffect(() => {
    // The hook handles initial mount. Only subsequent route entries add a read.
    if (previousRoute.current !== routing.route) {
      previousRoute.current = routing.route;
      reviewSummary.refresh();
    }
  }, [routing.route, reviewSummary.refresh]);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const openFromNativeMenu = () => setImportOpen(true);
    window.addEventListener('callie:open-import', openFromNativeMenu);
    return () => window.removeEventListener('callie:open-import', openFromNativeMenu);
  }, []);

  return (
    <>
      <AppShell
        route={routing.route}
        onNavigate={routing.navigate}
        reviewCount={reviewSummary.state}
      >
        <div key={`${routing.route}-${refreshKey}`}>
          {renderRoute(routing.route, {
            api,
            health,
            theme,
            density,
            openLead: inspector.openLead,
            openImport: () => setImportOpen(true),
            onReviewRequestStart: reviewSummary.begin,
            onReviewRequestFailed: reviewSummary.fail,
            onReviewSnapshot: reviewSummary.accept,
            onReviewResolved: reviewSummary.refresh,
          })}
        </div>
      </AppShell>
      <CommandPalette
        navigate={routing.navigate}
        openImport={() => setImportOpen(true)}
      />
      {importOpen && (
        <ImportDialog
          api={api.imports}
          open
          onClose={() => setImportOpen(false)}
          onCommitted={() => {
            reviewSummary.refresh();
            setRefreshKey((key) => key + 1);
          }}
        />
      )}
    </>
  );
}
