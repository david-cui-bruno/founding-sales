import { buildCommit } from '@fss/domain/release/identity.ts';
import { browserErrorConfigurationSchema } from '../shared/browserContract.ts';
import { semanticVersionSchema } from '@fss/contracts';
import type { BrowserHostSettings } from './hostContract.ts';

/** Explicit server composition only. Never discover or manufacture credentials. */
export function readBrowserHostSettings(values: Readonly<Record<string, string | undefined>>): BrowserHostSettings {
  const refuse = (): never => { throw new Error('Invalid browser host configuration'); };
  const origin = values['FSS_BROWSER_ORIGIN'];
  const clientVersion = values['FSS_BROWSER_CLIENT_VERSION'];
  const key = values['FSS_BROWSER_COOKIE_KEY_HEX'];
  if (typeof origin !== 'string' || typeof clientVersion !== 'string' || typeof key !== 'string') return refuse();
  let url: URL;
  try { url = new URL(origin); } catch { return refuse(); }
  // Equality rejects paths (including /), credentials, whitespace, default ports,
  // mixed-case/otherwise normalized host spellings and empty query/hash suffixes.
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) return refuse();
  if (clientVersion !== clientVersion.trim() || !semanticVersionSchema.safeParse(clientVersion).success || key.length !== 64 || !/^[a-fA-F0-9]{64}$/u.test(key)) return refuse();
  const dsn = values['FSS_SENTRY_BROWSER_DSN'] || undefined;
  const release = buildCommit(values) ?? '';
  const telemetry = browserErrorConfigurationSchema.safeParse({ ...(dsn === undefined ? {} : { dsn }), release });
  if (!telemetry.success || (dsn !== undefined && release === '')) return refuse();
  const bucket=values['FSS_SOCIAL_ASSETS_BUCKET'],region=values['AWS_REGION'];
  // Dotted buckets trigger path-style SDK URLs; this transport intentionally
  // supports one exact virtual-host origin, never a wildcard or path fallback.
  if(bucket!==undefined&&(!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(bucket)||!region||!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(region)))return refuse();
  const socialStorageOrigin=bucket===undefined?undefined:`https://${bucket}.s3.${region}.amazonaws.com`;
  return { origin, clientVersion, cookieKey: Buffer.from(key, 'hex'), ...(dsn === undefined && release === '' ? {} : { telemetry: telemetry.data }),...(socialStorageOrigin===undefined?{}:{socialStorageOrigin}) };
}
