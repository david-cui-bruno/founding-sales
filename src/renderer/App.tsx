import { DiagnosticsScreen } from './foundation/DiagnosticsScreen';
import type { DiagnosticsState } from './foundation/DiagnosticsScreen';
import { FounderApp } from './app/FounderApp';
import { useFoundationHealth } from './foundation/useFoundationHealth';

export type { DiagnosticsState };
export { DiagnosticsScreen };

/**
 * Root bootstrap: probes foundation health through the narrow preload API,
 * shows safe diagnostics until the encrypted foundation is ready, and then
 * renders the founder workflow application.
 */
export const App = () => {
  const health = useFoundationHealth(window.callie.health);

  if (health.status !== 'ready') {
    return (
      <DiagnosticsScreen
        state={
          health.status === 'loading'
            ? { status: 'loading' }
            : { status: 'failed' }
        }
        onRetry={health.retry}
      />
    );
  }

  return <FounderApp api={window.callie} health={health} />;
};
