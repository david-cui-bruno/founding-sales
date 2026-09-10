import { DiagnosticsScreen } from './foundation/DiagnosticsScreen';
import type { DiagnosticsState } from './foundation/DiagnosticsScreen';
import { PresentationRoot } from './app/PresentationRoot';
import { FounderApp } from './app/FounderApp';
import { useTheme } from './app/useTheme';
import { useDensity } from './app/useDensity';
import { useFoundationHealth } from './foundation/useFoundationHealth';

export type { DiagnosticsState };
export { DiagnosticsScreen };

/**
 * Root bootstrap: probes foundation health through the narrow preload API,
 * shows safe diagnostics until the encrypted foundation is ready, and then
 * renders the founder workflow application.
 */
export const App = () => {
  const theme = useTheme();
  const density = useDensity();
  const health = useFoundationHealth(window.callie.health);

  return (
    <PresentationRoot>
      {health.status !== 'ready' ? (
        <DiagnosticsScreen
          state={health.status === 'loading' ? { status: 'loading' } : { status: 'failed' }}
          onRetry={health.retry}
        />
      ) : (
        <FounderApp api={window.callie} health={health} theme={theme} density={density} />
      )}
    </PresentationRoot>
  );
};
