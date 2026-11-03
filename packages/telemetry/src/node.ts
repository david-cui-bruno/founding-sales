import * as Sentry from '@sentry/node';
import { errorOptions, isBoundary, isDsn, isRelease } from './privacy.ts';
import type { TechnicalErrorBoundary } from './privacy.ts';
import { readFileSync } from 'node:fs';
import { parseSourceManifest } from './sourceManifest.ts';
import { fileURLToPath } from 'node:url';
import { nodeErrorTransport } from './nodeTransport.ts';

export type { TechnicalErrorBoundary } from './privacy.ts';
let initialized = false;
let client: Sentry.NodeClient | undefined;

export function initNodeErrors(options: { dsn: string | undefined; release: string; service: 'api' | 'worker' }): void {
  if (initialized || !options.dsn || !isDsn(options.dsn) || !isRelease(options.release)) return;
  try {
    const sourceFiles = parseSourceManifest(readFileSync(new URL('../source-files.json', import.meta.url), 'utf8'));
    if (!sourceFiles) return;
    const runtimeRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const configuration = { release: options.release, service: options.service, sourceFiles, runtimeRoot };
    client = Sentry.initWithoutDefaultIntegrations({
      ...errorOptions(configuration), dsn: options.dsn,
      // The maintained fatal hook closes its client with this bound, then exits 1.
      // Respect existing application uncaughtException handlers; never install a rejection handler.
      integrations: [Sentry.onUncaughtExceptionIntegration({ exitEvenIfOtherHandlersAreRegistered: false })],
      shutdownTimeout: 2000,
      traceLifecycle: 'static',
      enableOpenTelemetrySetup: false, enableRuntimeChannelInjection: false, includeServerName: false,
      transport: (transportOptions) => nodeErrorTransport(
        Sentry.makeNodeTransport(transportOptions), configuration, runtimeRoot, () => client,
      ),
    });
    if (!client) return;
    initialized = true;
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
    // Telemetry must never change a request, job, shutdown or process-failure outcome.
  }
}

export async function flushTechnicalErrors(timeoutMilliseconds = 2000): Promise<boolean> {
  try {
    return client ? await client.flush(timeoutMilliseconds) : true;
  } catch {
    return false;
  }
}
