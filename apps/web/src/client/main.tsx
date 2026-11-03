import './schemaRuntime.ts';
import { createRoot } from 'react-dom/client';
import { BrowserApp } from './BrowserApp.tsx';
import { initBrowserErrors } from '@fss/telemetry/browser';
import { BROWSER_PATHS, browserErrorConfigurationSchema } from '../shared/browserContract.ts';
import { BrowserErrorBoundary } from './BrowserErrorBoundary.tsx';
import './browser.css';

async function startBrowser(): Promise<void> {
  // Public technical configuration only; never fetch session/product data for telemetry.
  // Failure disables export without preventing the existing browser from starting.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(BROWSER_PATHS.runtime, { credentials: 'omit', cache: 'no-store', signal: controller.signal });
    if (response.ok) {
      const configuration = browserErrorConfigurationSchema.safeParse(await response.json());
      if (configuration.success) initBrowserErrors({ dsn: configuration.data.dsn, release: configuration.data.release });
    }
  } catch {
    // A refused/unreachable bootstrap is not an application exception.
  } finally {
    clearTimeout(timeout);
  }
  const element = document.getElementById('root');
  if (element === null) throw new Error('Browser root is missing');
  createRoot(element).render(<BrowserErrorBoundary><BrowserApp /></BrowserErrorBoundary>);
}

void startBrowser();
