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
  return { origin, clientVersion, cookieKey: Buffer.from(key, 'hex') };
}
