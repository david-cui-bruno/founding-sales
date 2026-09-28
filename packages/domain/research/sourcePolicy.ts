import { isIP } from 'node:net';

/**
 * Which addresses research may connect to, and which URLs it may request.
 *
 * Ported from `59b3e1bb^:packages/domain/research/sourcePolicy.ts` — the logic, not
 * the file. The old module also carried discovery's website-root rule and its
 * shared-platform list; discovery is gone (no Places query in v1), so only the two
 * decisions that a page fetch asks come across, and the URL rule is narrower than the
 * old one: the firm's own host, an allow-listed path, or a link a person added.
 *
 * Both are deny-by-default and both are **pure**, which is the point: the adapter that
 * actually opens a socket asks these first, and a test can prove every refusal with no
 * network. Nothing in `packages/domain/research/**` imports `node:https`, `node:http`,
 * `node:dns`, `undici` or `fetch`; `test/research/rules.test.ts` reads every file in
 * the directory and fails on one that does. `node:net`'s `isIP` is the one exception,
 * and it opens nothing.
 *
 * ## Why an address allow-list at all
 *
 * A firm's own DNS answer is attacker-controlled input. Without this, "fetch the
 * firm's website" is a request-forgery primitive pointed at the worker's own subnet,
 * the instance metadata endpoint, or the database. The adapter resolves the name,
 * checks every answer here, and pins the connection to the address it checked;
 * `PageFetchProvider` carries that obligation in its contract.
 */

/**
 * A conservative public IPv4 allow-list. IPv6 is denied outright, exactly as the old
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

/**
 * Hosts research never reads, on any path and however it was reached.
 *
 * David's answer 5 is read-only lookups of the firm's own site. A directory, a social
 * network or a job aggregator is somebody else's database about the firm, and reading
 * one is both a terms question and an evidence question: a listing is not the firm's
 * own words, so a quote from one could not be shown as one.
 *
 * The firm's own careers page is the only job source there is. That is the whole
 * reason `indeed` and `ziprecruiter` are on this list and `/<host>/careers` is on the
 * path allow-list below.
 */
export const BLOCKED_RESEARCH_HOSTS: readonly string[] = Object.freeze([
  'angi.com',
  'apartments.com',
  'bbb.org',
  'bing.com',
  'crunchbase.com',
  'facebook.com',
  'fb.com',
  'glassdoor.com',
  'google.com',
  'indeed.com',
  'instagram.com',
  'lever.co',
  'linkedin.com',
  'linktr.ee',
  'manta.com',
  'monster.com',
  'narpm.org',
  'nextdoor.com',
  'pinterest.com',
  'realtor.com',
  'reddit.com',
  'simplyhired.com',
  'threads.net',
  'thumbtack.com',
  'tiktok.com',
  'trulia.com',
  'twitter.com',
  'x.com',
  'yellowpages.com',
  'yelp.com',
  'youtube.com',
  'zillow.com',
  'ziprecruiter.com',
  'zoominfo.com',
]);

/** The paths research reads on a firm's own host, in this order. */
export const RESEARCH_PAGE_PATHS: readonly string[] = Object.freeze([
  '/',
  '/about',
  '/services',
  '/team',
  '/contact',
  '/careers',
  '/jobs',
]);

/** The largest `max_pages_per_firm` the settings CHECK admits. */
export const MAX_PAGES_CEILING = 8;

function normalizedHost(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, '');
  return host === '' ? null : host;
}

function isBlockedHost(host: string): boolean {
  return BLOCKED_RESEARCH_HOSTS.some(blocked => host === blocked || host.endsWith(`.${blocked}`));
}

/**
 * A URL research may request at all: https, no credentials, the default port, a real
 * name on a public host, and not one of the blocked hosts.
 *
 * Deliberately separate from `permittedResearchUrl` below, because a `firm_links` URL
 * has to pass this and *not* the firm-host rule: a person may add a page on another
 * public host once, and it is still refused if it is a social network or a bare
 * private address.
 */
export function isPublicResearchUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  if (url.port !== '' && url.port !== '443') return false;
  if (!host.includes('.') || host.includes(':')) return false;
  if (host.endsWith('.local') || host.endsWith('.localhost')) return false;
  // A literal address in the URL is checked here; a *name* is checked after it is
  // resolved, by the adapter, against every answer.
  if (isIP(host) !== 0 && !isPublicResearchAddress(host)) return false;
  return !isBlockedHost(host);
}

/** `example.test` and `www.example.test` are the same firm's site. */
function sameSite(firmHost: string, host: string): boolean {
  const bare = firmHost.replace(/^www\./u, '');
  return host === bare || host === `www.${bare}`;
}

export type UrlPermission =
  /** On the firm's own host, on an allow-listed path. */
  | 'firm_site'
  /** Not the firm's host, but a link a person added by hand. */
  | 'added_link'
  | 'blocked';

export interface PermittedUrlInput {
  /** The firm's `website` column, or null. */
  readonly firmWebsite: string | null;
  /** The URLs in `firm_links` for this firm. Each is permitted once, on any public host. */
  readonly links?: readonly string[] | undefined;
  /** `research_settings.max_pages_per_firm`: how far down `RESEARCH_PAGE_PATHS` to read. */
  readonly maxPagesPerFirm: number;
}

/**
 * What research may do with one URL.
 *
 * The path rule is an explicit allow-list rather than "any path on the firm's domain",
 * because a redirect would otherwise walk the fetch somewhere nobody approved — and
 * the adapter re-asks this question after every redirect for exactly that reason.
 */
export function permittedResearchUrl(input: PermittedUrlInput, value: string): UrlPermission {
  if (!isPublicResearchUrl(value)) return 'blocked';
  const links = input.links ?? [];
  // An added link is permitted as itself, byte for byte. Not by prefix: a person
  // approved one page, not a directory.
  if (links.includes(value)) return 'added_link';

  const firmHost = input.firmWebsite === null ? null : normalizedHost(input.firmWebsite);
  if (firmHost === null) return 'blocked';
  const host = normalizedHost(value);
  if (host === null || !sameSite(firmHost, host)) return 'blocked';

  const bounded = Math.max(1, Math.min(Math.trunc(input.maxPagesPerFirm), MAX_PAGES_CEILING));
  const paths = RESEARCH_PAGE_PATHS.slice(0, bounded);
  const path = new URL(value).pathname.replace(/\/+$/u, '');
  return paths.includes(path === '' ? '/' : path) ? 'firm_site' : 'blocked';
}

/**
 * Exactly the URLs one run may request for one firm, in order: the firm's own pages
 * within `maxPagesPerFirm`, then the links a person added.
 *
 * Each is re-checked by `permittedResearchUrl` in the adapter, so this function is a
 * convenience for the caller and never the authority.
 */
export function researchUrlsForFirm(input: PermittedUrlInput): readonly string[] {
  const urls: string[] = [];
  const firmHost = input.firmWebsite === null ? null : normalizedHost(input.firmWebsite);
  if (firmHost !== null && !isBlockedHost(firmHost)) {
    const bounded = Math.max(1, Math.min(Math.trunc(input.maxPagesPerFirm), MAX_PAGES_CEILING));
    for (const path of RESEARCH_PAGE_PATHS.slice(0, bounded)) {
      const candidate = `https://${firmHost}${path}`;
      if (permittedResearchUrl(input, candidate) === 'firm_site') urls.push(candidate);
    }
  }
  for (const link of input.links ?? []) {
    if (!urls.includes(link) && permittedResearchUrl(input, link) === 'added_link') urls.push(link);
  }
  return Object.freeze(urls);
}
