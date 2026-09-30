import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { poolConnections } from '../../src/bootstrap/connections.ts';
import { recordingLogger } from '../../src/bootstrap/log.ts';

type RecordingLogger = ReturnType<typeof recordingLogger>;
import { createApiServer } from '../../src/server.ts';
import { calcom, calcomSignature, twilioSignature, twilioVoice } from '../../src/integrations/providers.ts';
import type { AuthFixture } from './authFixture.ts';
import { testRequestPool } from './poolFixture.ts';

/**
 * The real API server on a socket, with the two provider integrations configured from
 * secrets generated at start (call-to-booking slice W). Every request in these tests is
 * a real HTTP request through `createApiServer` — the envelope, the body reader, the
 * readiness gate, the registry — never a handler call.
 */

/** The public origin Twilio signs against, pinned; the socket is somewhere else entirely. */
export const PUBLIC_ORIGIN = 'https://api.callie.example';

/**
 * The next weekday at 14:00 UTC (10:00 in America/New_York) after the wall clock: inside
 * the calling window, and after the posture a test allows now becomes effective.
 */
export const INSIDE_CALLING_WINDOW = ((): string => {
  const candidate = new Date();
  candidate.setUTCHours(14, 0, 0, 0);
  while (candidate.getTime() <= Date.now() || candidate.getUTCDay() === 0 || candidate.getUTCDay() === 6) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate.toISOString();
})();

const hex = (bytes: number): string => randomBytes(bytes).toString('hex');

export interface IntegrationServer {
  readonly origin: string;
  readonly port: number;
  readonly log: RecordingLogger;
  readonly accountSid: string;
  readonly callerIdE164: string;
  /** Sign as Twilio would, at the pinned external URL. */
  twilioSign(url: string, params: Readonly<Record<string, string>>): string;
  /** Sign as Cal.com would, over the raw bytes. */
  calcomSign(raw: Buffer): string;
  close(): Promise<void>;
}

export async function startIntegrationServer(
  fixture: AuthFixture,
  options: { readonly callerIdE164?: string; readonly configured?: boolean } = {},
): Promise<IntegrationServer> {
  const authToken = hex(20);
  const webhookSecret = hex(24);
  const accountSid = `AC${hex(16)}`;
  const callerIdE164 = options.callerIdE164 ?? '+14015550100';
  const configured = options.configured ?? true;
  const pool: pg.Pool = testRequestPool(fixture.database);
  const log = recordingLogger();
  const { db: _db, ...auth } = fixture.deps;
  const server = createApiServer({
    connections: poolConnections(pool, log),
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    auth,
    log,
    integrations: {
      publicOrigin: PUBLIC_ORIGIN,
      twilio: configured
        ? twilioVoice({
            accountSid,
            apiKeySid: `SK${hex(16)}`,
            apiKeySecret: hex(20),
            twimlAppSid: `AP${hex(16)}`,
            authToken,
            callerIdE164,
          })
        : null,
      calcom: configured ? calcom({ webhookSecret }) : null,
      decisionAt: () => INSIDE_CALLING_WINDOW,
    },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    port,
    log,
    accountSid,
    callerIdE164,
    twilioSign: (url, params) => twilioSignature(authToken, url, params),
    calcomSign: raw => calcomSignature(webhookSecret, raw),
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await pool.end();
    },
  };
}
