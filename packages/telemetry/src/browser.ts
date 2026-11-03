import * as Sentry from '@sentry/browser';
import type { Client } from '@sentry/core';
import { errorOnlyTransport, errorOptions, isBoundary, isDsn, isRelease } from './privacy.ts';
import type { TechnicalErrorBoundary } from './privacy.ts';

export type { TechnicalErrorBoundary } from './privacy.ts';
let client: Client | undefined;

export function initBrowserErrors(options: { dsn: string | undefined; release: string }): void {
  if (client || !options.dsn || !isDsn(options.dsn) || !isRelease(options.release)) return;
  try {
    const configuration = { release: options.release, service: 'browser' as const };
    client = Sentry.init({
      ...errorOptions(configuration), dsn: options.dsn,
      integrations: [Sentry.globalHandlersIntegration({ onerror: true, onunhandledrejection: true })],
      replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 0,
      transport: (transportOptions) => errorOnlyTransport(Sentry.makeFetchTransport(transportOptions), configuration),
    });
  } catch {
    client = undefined;
  }
}

export function captureTechnicalError(error: unknown, boundary: TechnicalErrorBoundary): void {
  if (!client || !isBoundary(boundary)) return;
  try {
    const scope = new Sentry.Scope();
    scope.setTag('technical_boundary', boundary);
    client.captureException(error, undefined, scope);
  } catch {
    // Error reporting is isolated from application behavior.
  }
}

export async function flushTechnicalErrors(timeoutMilliseconds = 2000): Promise<boolean> {
  try {
    return client ? await client.flush(timeoutMilliseconds) : true;
  } catch {
    return false;
  }
}
