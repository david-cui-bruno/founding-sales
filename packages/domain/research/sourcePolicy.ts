import { isIP } from 'node:net';

/**
 * Which URLs research may fetch, and which addresses it may connect to.
 *
 * Ported from `src/main/research/companySourcePolicy.ts` — the logic, not the file.
 * The old module also issued fetch receipts against an in-memory ledger; here the
 * receipt is an `evidence_items` row, so only the two decisions come across.
 *
 * Both are deny-by-default, and both are *pure*, which is the point: the port that
 * actually opens a socket asks these first, and a test can prove the refusals without
 * a network. There is no live call anywhere in this package.
 *
 * ## Why an address allowlist at all
 *
 * A firm's own DNS answer is attacker-controlled input. Without this, "fetch the
 * firm's website" is a request forgery primitive pointed at the worker's own subnet,
 * the instance metadata endpoint, or the database. The old module resolved the name
 * first, checked every answer, and then pinned the connection to the address it had
 * checked; `PageFetchProvider` carries the same obligation in its contract.
 */

/**
 * A conservative public IPv4 allowlist. IPv6 is denied outright, exactly as the old
 * module denied it: a partially pinned IPv6 policy is worse than none, because it
 * looks like protection.
 */
export function isPublicResearchAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const octets = address.split('.').map(Number);
  const [a, b] = octets;
  if (a === undefined || b === undefined) return false;
  return (
    a > 0 &&
    a < 224 && // no multicast, no reserved 240/4
    a !== 10 && // RFC 1918
    a !== 127 && // loopback
    !(a === 100 && b >= 64 && b <= 127) && // RFC 6598 carrier-grade NAT
    !(a === 169 && b === 254) && // link-local, which is where cloud metadata lives
    !(a === 172 && b >= 16 && b <= 31) && // RFC 1918
    !(a === 192 && (b === 0 || b === 168)) && // RFC 6890 / RFC 1918
    !(a === 198 && (b === 18 || b === 19 || b === 51)) && // benchmarking, documentation
    !(a === 203 && b === 0) // documentation
  );
}

export type SourceDisposition = 'candidate' | 'blocked';

/**
 * What research may do with a URL.
 *
 * * `candidate` — an https URL on a public host that a page fetch may request.
 * * `blocked` — everything else: any other scheme, credentials in the URL, a
 *   non-default port, a bare or private address, a name with no dot, a `.local` name,
 *   the trade-association directory the old policy blocked because scraping a
 *   membership list is not the same thing as reading a firm's own site, and LinkedIn,
 *   which research has never read. (Until LinkedIn was removed on 25 September 2026 a
 *   LinkedIn URL was `manual_only`, for a person's handoff; every caller treated that
 *   exactly as `blocked`.)
 */
export function researchSourcePolicy(value: string): SourceDisposition {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'blocked';
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.port !== '' && url.port !== '443') ||
    !host.includes('.') ||
    host.includes(':') ||
    host.endsWith('.local') ||
    host.endsWith('.localhost') ||
    (isIP(host) !== 0 && !isPublicResearchAddress(host))
  ) {
    return 'blocked';
  }
  if (host === 'narpm.org' || host.endsWith('.narpm.org')) return 'blocked';
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return 'blocked';
  return 'candidate';
}

const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/u;

/**
 * Business-profile listings often point at a shared platform rather than the firm's
 * own site. A shared host is never a firm's domain, so a candidate whose listed
 * website is one of these is skipped rather than recorded under somebody else's name.
 */
export const SHARED_PLATFORM_HOSTS: readonly string[] = Object.freeze([
  'apartments.com',
  'facebook.com',
  'google.com',
  'instagram.com',
  'linktr.ee',
  'nextdoor.com',
  'realtor.com',
  'tiktok.com',
  'trulia.com',
  'twitter.com',
  'x.com',
  'yelp.com',
  'youtube.com',
  'zillow.com',
]);

export interface WebsiteRoot {
  /** The bare registrable-looking host, `www.` removed. Lower case. */
  readonly domain: string;
  /** The https root a page fetch may start from. */
  readonly sourceUrl: string;
}

/**
 * The firm's own website root, or null when the listed website cannot name one.
 *
 * Ported from `websiteRoot` in `src/main/research/placesDiscoveryProvider.ts`.
 */
export function websiteRootOf(websiteUri: string): WebsiteRoot | null {
  let host: string;
  try {
    host = new URL(websiteUri).hostname.toLowerCase().replace(/\.$/u, '');
  } catch {
    return null;
  }
  if (host === '') return null;
  const sourceUrl = `https://${host}/`;
  const domain = host.replace(/^www\./u, '');
  if (researchSourcePolicy(sourceUrl) !== 'candidate') return null;
  if (domain.length > 253 || !DOMAIN_PATTERN.test(domain)) return null;
  if (SHARED_PLATFORM_HOSTS.some(shared => domain === shared || domain.endsWith(`.${shared}`))) return null;
  return { domain, sourceUrl };
}

/** The paths a page fetch reads for a discovered firm, in this order. */
export const RESEARCH_PAGE_PATHS: readonly string[] = Object.freeze(['/', '/services', '/team', '/contact']);

/**
 * Exactly the URLs a page fetch may request for one firm: the discovery paths within
 * `maxPages`, on the bare host and on `www.`. Ported from `placesPermittedSources`.
 *
 * The allowlist is explicit rather than a prefix rule, because "any URL on the firm's
 * domain" would let a redirect walk the fetch somewhere nobody approved.
 */
export function permittedFirmSources(domain: string, maxPages: number): readonly string[] {
  const bounded = Math.max(1, Math.min(Math.trunc(maxPages), RESEARCH_PAGE_PATHS.length));
  const paths = RESEARCH_PAGE_PATHS.slice(0, bounded);
  return Object.freeze(
    [domain, `www.${domain}`].flatMap(host => paths.map(path => `https://${host}${path}`)),
  );
}
