import { isIP } from 'node:net';
import { MAX_ANCHOR_HREFS } from './pageText.ts';

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

/**
 * The paths research reads on a firm's own host, **in this order**.
 *
 * The order is load-bearing, because `max_pages_per_firm` is a prefix of this list and
 * its default is four. `/careers` and `/jobs` come before `/team` and `/contact` for
 * that reason: a maintenance job posting is the only evidence `hiring_maintenance` has,
 * and that one key feeds two of the four judgments — problem evidence and timing. With
 * careers fifth the default settings would never fetch it, and two judgments would be
 * `unknown` on every firm for a reason nobody could see.
 */
export const RESEARCH_PAGE_PATHS: readonly string[] = Object.freeze([
  '/',
  '/about',
  '/services',
  '/careers',
  '/jobs',
  '/team',
  '/contact',
]);

/**
 * The paths a link found on the firm's own homepage may have.
 *
 * The fixed list above is a guess at what a site calls its pages, and real sites call
 * them `/about-us`, `/our-team`, `/contact-us`, `/services/` and `/join-our-team`. On
 * one of those, an exact-path allow-list reads the homepage and nothing else. So the
 * homepage's own links are read as well — the firm's own navigation is a better guide
 * to the firm's own site than a list written here — and this is the filter that keeps
 * the discovery to the pages research was going to ask for anyway.
 */
export const DISCOVERED_PATH_PATTERN = /about|service|team|staff|contact|career|job|hiring|resident|tenant|maintenance|emergency|faq/iu;

/** Maximum discovered URLs; default runs also stop after this many same-site candidates. */
export const MAX_DISCOVERED_CANDIDATES = 20;

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
 *
 * ## No query string, and no fragment
 *
 * A URL research fetches is stored: in `firm_links` where a person put it, and in
 * `evidence_items.source_reference` where it is the provenance of a quote. A query
 * string is where a session token, a password-reset code, a signed URL's signature and
 * an e-mail address live, and retention has no way to find one inside a URL. So a URL
 * with a query is not fetched and not stored — `addFirmLink` refuses it
 * `link_not_permitted`, a redirect target with one is skipped `url_has_query`, and this
 * function is where all three of those get their answer.
 *
 * A fragment is dropped rather than refused, because it is never sent to the server and
 * never identifies a different page — but a URL that still carries one has not been
 * normalised by whoever is asking, and storing `…/about#team` and `…/about` as two
 * evidence references for one page would be wrong. `withoutFragment` is the dropper and
 * every entry point calls it; this refuses what is left, so nothing can skip it.
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
  if (url.search !== '' || url.hash !== '') return false;
  if (!host.includes('.') || host.includes(':')) return false;
  if (host.endsWith('.local') || host.endsWith('.localhost')) return false;
  // A literal address in the URL is checked here; a *name* is checked after it is
  // resolved, by the adapter, against every answer.
  if (isIP(host) !== 0 && !isPublicResearchAddress(host)) return false;
  return !isBlockedHost(host);
}

/**
 * The same URL with its fragment removed.
 *
 * Total, and it leaves anything it cannot parse exactly as it found it: the caller's
 * next step is `isPublicResearchUrl`, which refuses what this could not normalise.
 */
export function withoutFragment(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

/** `example.test` and `www.example.test` are the same firm's site. */
function sameSite(firmHost: string, host: string): boolean {
  const bare = firmHost.replace(/^www\./u, '');
  return host === bare || host === `www.${bare}`;
}

/**
 * Whether two URLs are on the same site, by the rule above.
 *
 * Exported for the adapter, which needs it for one thing the policy cannot decide for
 * it: whether a `robots.txt` that answered with a redirect is still the same host's
 * robots file. Anything that is not is not this host's rules, and a host whose rules
 * cannot be read is a host whose pages are not fetched.
 */
export function isSameResearchSite(a: string, b: string): boolean {
  const left = normalizedHost(a);
  const right = normalizedHost(b);
  return left !== null && right !== null && sameSite(left, right);
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
  /** Prefer published contact paths within the bounded navigation scan. */
  readonly prioritizeContactPages?: boolean;
  /**
   * Same-site URLs found in the firm's own homepage (`discoverSameSiteUrls`).
   *
   * Permitted like a fixed path, and for the same reason: they are on the firm's own
   * host and the firm itself linked to them. They are *not* permitted by prefix — the
   * set is the exact URLs the homepage named, so a redirect cannot walk into one that
   * was never on the page.
   */
  readonly discovered?: readonly string[] | undefined;
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

  if ((input.discovered ?? []).includes(value)) return 'firm_site';

  const bounded = Math.max(1, Math.min(Math.trunc(input.maxPagesPerFirm), MAX_PAGES_CEILING));
  const paths = RESEARCH_PAGE_PATHS.slice(0, bounded);
  const path = new URL(value).pathname.replace(/\/+$/u, '');
  return paths.includes(path === '' ? '/' : path) ? 'firm_site' : 'blocked';
}

/**
 * What research may do with a URL a redirect pointed it at.
 *
 * A redirect on the **same site** inherits the permission of the URL that led to it,
 * whatever its path. Re-applying the exact-path allow-list here was wrong and it is
 * the ordinary case that suffers: a homepage that answers `301` to `/home`, `/en/` or
 * `/index.html` — which a great many do — would be skipped as `url_not_permitted` and
 * the firm would yield nothing at all.
 *
 * Nothing else is relaxed. The target still has to be an https URL on a public host
 * that is not a blocked one (`isPublicResearchUrl`), the adapter still resolves it,
 * checks every address and pins the socket, still asks that host's robots, and still
 * counts the hop against `MAX_REDIRECTS`. A **cross-site** redirect is blocked unless
 * the target is itself a link a person added: the firm's own server does not get to
 * choose a second site for research to read.
 */
export function permittedRedirectTarget(
  input: PermittedUrlInput,
  from: { readonly url: string; readonly permission: UrlPermission },
  to: string,
): UrlPermission {
  if (from.permission === 'blocked') return 'blocked';
  if (!isPublicResearchUrl(to)) return 'blocked';
  // An added link is itself, wherever it was reached from.
  if ((input.links ?? []).includes(to)) return 'added_link';

  const fromHost = normalizedHost(from.url);
  const toHost = normalizedHost(to);
  if (fromHost !== null && toHost !== null && sameSite(fromHost, toHost)) return from.permission;

  // Off the site it came from: the ordinary rule, which for a firm page means the
  // firm's own host and an allow-listed or discovered path, and nothing else.
  return permittedResearchUrl(input, to);
}

/**
 * The same-site links a firm's own homepage offers, normalised and filtered.
 *
 * Pure: `anchorHrefs` in `pageText.ts` does the scanning and this does the deciding,
 * so every rule below is provable without a page.
 *
 * Normalised means absolute against the page it was found on, https, no query and no
 * fragment (two links to the same page with different tracking parameters are one
 * page), and no trailing slash — so `/services/` and `/services` are one URL rather
 * than two fetches of the same bytes.
 *
 * By default the cap applies to same-site candidates before the keyword filter, so a
 * page with a thousand links costs a bounded amount of work whatever they say.
 * Contact-priority runs scan at most MAX_ANCHOR_HREFS raw links, then retain at
 * most MAX_DISCOVERED_CANDIDATES relevant URLs, with contacts first.
 */
export function discoverSameSiteUrls(
  input: PermittedUrlInput,
  found: { readonly from: string; readonly hrefs: readonly string[] },
): readonly string[] {
  const firmHost = input.firmWebsite === null ? null : normalizedHost(input.firmWebsite);
  if (firmHost === null || isBlockedHost(firmHost)) return [];

  const candidates: string[] = [];
  for (const href of found.hrefs.slice(0, MAX_ANCHOR_HREFS)) {
    if (!input.prioritizeContactPages && candidates.length >= MAX_DISCOVERED_CANDIDATES) break;
    let url: URL;
    try {
      url = new URL(href, found.from);
    } catch {
      continue;
    }
    // `mailto:`, `tel:`, `javascript:` and every other scheme fall out here.
    if (url.protocol !== 'https:') continue;
    const host = url.hostname.toLowerCase().replace(/\.$/u, '');
    if (!sameSite(firmHost, host)) continue;
    const path = url.pathname.replace(/\/+$/u, '');
    const normalized = `https://${host}${path === '' ? '/' : path}`;
    if (!candidates.includes(normalized)) candidates.push(normalized);
  }

  // Keep published navigation even when it matches a guessed URL; the fetcher
  // promotes and deduplicates those URLs against its remaining queue.
  const relevant = candidates.filter(url => {
    const path = new URL(url).pathname;
    if (path === '/') return false;
    return DISCOVERED_PATH_PATTERN.test(path);
  });
  if (input.prioritizeContactPages) relevant.sort((a,b)=>Number(/contact/iu.test(new URL(b).pathname))-Number(/contact/iu.test(new URL(a).pathname)));
  return Object.freeze(relevant.slice(0, MAX_DISCOVERED_CANDIDATES));
}

/**
 * Exactly the URLs one run may request for one firm, in order: the links a person
 * added, then the firm's own pages — **and never more than `maxPagesPerFirm` of them
 * in total**.
 *
 * The total is the point. `worstCaseRunCents` is what `claimResearchClearance` checks a
 * ceiling against before any call is made, and it prices `maxPagesPerFirm` pages. When
 * this function appended every added link *on top of* that number, a firm with six
 * links sent ten pages to a bound computed for four, and the cents ceiling that is the
 * only thing standing between this feature and a month's budget was authorizing a run
 * it had not priced. One number, enforced in one place, checked in the other.
 *
 * Added links first, because a link is a person's decision about this firm and a fixed
 * path is a guess about every firm. If the budget only covers one page and somebody has
 * said which page matters, that is the page.
 *
 * Each URL is re-checked by `permittedResearchUrl` in the adapter, so this function is
 * the caller's convenience and never the authority.
 */
export function researchUrlsForFirm(input: PermittedUrlInput): readonly string[] {
  const budget = Math.max(1, Math.min(Math.trunc(input.maxPagesPerFirm), MAX_PAGES_CEILING));
  const urls: string[] = [];
  const add = (candidate: string, expected: UrlPermission): void => {
    if (urls.length >= budget || urls.includes(candidate)) return;
    if (permittedResearchUrl(input, candidate) === expected) urls.push(candidate);
  };

  for (const link of input.links ?? []) add(withoutFragment(link.trim()), 'added_link');
  const firmHost = input.firmWebsite === null ? null : normalizedHost(input.firmWebsite);
  if (firmHost !== null && !isBlockedHost(firmHost)) {
    for (const path of RESEARCH_PAGE_PATHS.slice(0, budget)) add(`https://${firmHost}${path}`, 'firm_site');
  }
  return Object.freeze(urls);
}
