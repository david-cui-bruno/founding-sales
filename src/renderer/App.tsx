import { DiagnosticsScreen, HealthObservationStatus } from './foundation/DiagnosticsScreen';
import type { DiagnosticsState } from './foundation/DiagnosticsScreen';
import { PresentationRoot } from './app/PresentationRoot';
import { FounderApp } from './app/FounderApp';
import { useTheme } from './app/useTheme';
import { useDensity } from './app/useDensity';
import { useFoundationHealth } from './foundation/useFoundationHealth';
import { LocalCompanyIntakeProvider } from './features/today/LocalCompanyIntakeProvider';

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
  const admitted = health.status === 'ready' && health.health.domainReady && health.health.domainStatus === 'ready';

  return (
    <PresentationRoot>
      <div className={`foundation-frame${admitted ? ' foundation-frame--admitted' : ''}`}>
        <div className="foundation-workspace">
          <LocalCompanyIntakeProvider api={window.callie.localWorkspace}>
            {admitted ? (
              <FounderApp api={window.callie} health={health} theme={theme} density={density} />
            ) : (
              <DiagnosticsScreen
                state={health.status === 'ready' ? { status: 'ready', health: health.health } : { status: health.status }}
                observation={health.observation}
                onRetry={health.retry}
              />
            )}
          </LocalCompanyIntakeProvider>
        </div>
        <div className="foundation-observation">{admitted && <HealthObservationStatus observation={health.observation} onRetry={health.retry} />}</div>
      </div>
    </PresentationRoot>
  );
};
