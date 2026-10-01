import { createHash } from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { anchorHrefs } from '@fss/domain/research/pageText.ts';
import {
  discoverSameSiteUrls,
  isPublicResearchAddress,
  isPublicResearchUrl,
  isSameResearchSite,
  MAX_PAGES_CEILING,
  permittedRedirectTarget,
  permittedResearchUrl,
  withoutFragment,
  type UrlPermission,
} from '@fss/domain/research/sourcePolicy.ts';
import type {
  FetchedPage,
  PageFetchProvider,
  PageFetchRequest,
  PageFetchResult,
  ProviderOutcome,
} from '@fss/domain/research/providers.ts';
import { COMPANY_PAGE_PROVIDER } from '@fss/domain/research/types.ts';

/**
 * The live page fetch: the only code in this repository that opens a socket to a
 * firm's website.
 *
 * It is in `apps/worker` and not in `packages/domain/research` for the reason
 * `providers.ts` gives: the domain package is proved to import no network module at
 * all, so the rules can be tested without one. This file is the other half, and every
 * rule it enforces is one the domain package decided.
 *
 * ## Why the name is resolved here and pinned
 *
 * A firm's DNS answer is input somebody else controls. `https.request('https://host/')`
 * resolves the name inside the socket, so a check of the address *before* the request
 * would be checking a different lookup from the one that connects — the classic
 * DNS-rebinding window. So: resolve the name, require **every** answer to pass
 * `isPublicResearchAddress`, and then connect to one of the checked addresses with
 * `servername` set for TLS and a `Host` header set for HTTP. The socket never resolves
 * the name at all, so there is no second lookup to disagree with the first.
 *
 * Every answer, not the one that is used: a name that resolves to a public address and
 * `169.254.169.254` is a name that will eventually give the second one to somebody.
 *
 * ## Redirects
 *
 * Three at most, and each one is a new URL that gets a fresh resolution and a fresh
 * pin. A redirect that is not permitted is a skip with a reason rather than a followed
 * hop, because otherwise the firm's own server decides where this worker connects.
 *
 * What a redirect target is permitted to be is `permittedRedirectTarget`'s decision,
 * not this file's: on the same site it inherits the permission of the URL that led to
 * it, whatever its path, because a homepage that answers `301` to `/home`, `/en/` or
 * `/index.html` is ordinary and the old exact-path re-check made such a firm yield
 * nothing. Off the site it is blocked unless a person added it as a link.
 *
 * ## Discovery
 *
 * A fixed list of paths is a guess at what a site calls its pages. After the firm's
 * homepage is read, its own anchors are scanned (`anchorHrefs`, a lexical scan, no HTML
 * dependency), the same-site ones that look like an about/services/team/contact/careers
 * page are kept (`discoverSameSiteUrls`), and they are queued behind the fixed list.
 * They are fetched only while the firm-page budget — `max_pages_per_firm` — has room,
 * so in practice they fill the budget that a `404` on a guessed path freed. Every one
 * still goes through the permission rule, a resolution, robots and the byte cap.
 *
 * ## robots.txt
 *
 * Fetched first, the same pinned way, and honoured for `*` and for `CallieResearch`.
 * A firm that has asked crawlers not to read a path has asked us, and the block that
 * would have become a quote must not exist. Four things that matters for:
 *
 *   * **A robots file that cannot be read completely means the host's pages are not
 *     fetched** (`robots_unreadable`). A file over the cap, a `500`, a timeout or a
 *     redirect off the site is not permission; a `404` or a `410` is — the absence of
 *     the file is the permissive answer in the standard, and only the absence.
 *   * **A redirected robots is followed**, up to `MAX_REDIRECTS`, on the same site
 *     only, with a fresh resolution and pin for each hop. `https://host/robots.txt`
 *     redirecting to `https://www.host/robots.txt` is how a great many sites serve it,
 *     and reading that as "no rules" would ignore a firm that had asked.
 *   * **`*` and `$` mean what the standard says**, and `Allow` is honoured with
 *     longest-match-wins, so a site that disallows `/` and allows `/about` is read the
 *     way it asked to be rather than not at all.
 *   * **Cached per host and per checked address** for the run, because the rules that
 *     were read are the rules of the server that answered.
 *
 * ## Testability
 *
 * `{ lookup, request, now }` are injected. Every test drives fakes and no test opens a
 * socket; `researchPageFetch()` with no arguments is the real one.
 */

/** Sent on every request. A person reading a log can find out who this is. */
export const RESEARCH_USER_AGENT = 'CallieResearch/1.0 (+https://usecallie.com)';

/** The token a firm's robots.txt may name to talk to this fetcher specifically. */
export const RESEARCH_ROBOTS_TOKEN = 'callieresearch';

export const PAGE_TIMEOUT_MILLISECONDS = 10_000;
/** A robots file larger than this is not a robots file. */
export const MAX_ROBOTS_BYTES = 64 * 1024;
export const FIRM_TIMEOUT_MILLISECONDS = 30_000;
export const MAX_REDIRECTS = 3;

export type LookupFn = (hostname: string) => Promise<readonly string[]>;

export interface RawResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The bytes read, already bounded. Null when the cap aborted the read. */
  readonly body: Uint8Array | null;
  readonly abortedOverCap: boolean;
}

export interface RequestOptions {
  readonly url: string;
  /** The address the policy checked. The socket connects to this, never to the name. */
  readonly address: string;
  readonly hostname: string;
  readonly maxBytes: number;
  readonly timeoutMilliseconds: number;
}

export type RequestFn = (options: RequestOptions) => Promise<RawResponse>;

export interface PageFetchDeps {
  readonly lookup?: LookupFn | undefined;
  readonly request?: RequestFn | undefined;
  readonly now?: (() => number) | undefined;
}

/** Every address a name resolves to, v4 and v6 alike, so a v6 answer is seen and refused. */
async function systemLookup(hostname: string): Promise<readonly string[]> {
  const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return answers.map(answer => answer.address);
}

/**
 * One request, to a checked address, with the name carried in `servername` and
 * `Host` so TLS verification and virtual hosting both still work.
 */
async function systemRequest(options: RequestOptions): Promise<RawResponse> {
  return await new Promise<RawResponse>((resolve, reject) => {
    const target = new URL(options.url);
    const chunks: Uint8Array[] = [];
    let read = 0;
    let abortedOverCap = false;

    const message = https.request(
      {
        // The address, not the name. Nothing here resolves anything.
        host: options.address,
        servername: options.hostname,
        port: 443,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        // TLS verification stays on. A firm with a broken certificate is a firm whose
        // pages this does not read.
        rejectUnauthorized: true,
        timeout: options.timeoutMilliseconds,
        headers: {
          host: options.hostname,
          'user-agent': RESEARCH_USER_AGENT,
          accept: 'text/html,text/plain;q=0.9',
          'accept-encoding': 'identity',
        },
      },
      (response: IncomingMessage) => {
        response.on('data', (chunk: Uint8Array) => {
          read += chunk.byteLength;
          if (read > options.maxBytes) {
            abortedOverCap = true;
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: abortedOverCap ? null : concat(chunks, read),
            abortedOverCap,
          });
        });
        response.on('close', () => {
          if (abortedOverCap) {
            resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: null, abortedOverCap });
          }
        });
      },
    );
    message.on('timeout', () => {
      message.destroy(new Error('page_timeout'));
    });
    message.on('error', reject);
    message.end();
  });
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function headerOf(response: RawResponse, name: string): string {
  const value = response.headers[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

/** The `Allow` and `Disallow` patterns of the one group that applies to this fetcher. */
export interface RobotsRules {
  readonly allow: readonly string[];
  readonly disallow: readonly string[];
}

export const EMPTY_ROBOTS_RULES: RobotsRules = Object.freeze({ allow: [], disallow: [] });

/**
 * The rules a host's robots.txt states for this fetcher.
 *
 * **One group, not a merge.** RFC 9309 §2.2.1: the most specific matching user-agent
 * group applies, and only it. So if the file names `CallieResearch` anywhere, those
 * lines are the whole of what applies and the `*` group is ignored entirely; if it does
 * not, the `*` group is. Merging the two was wrong in the direction that matters most:
 * a site that disallows everything for `*` and then writes a `CallieResearch` group
 * saying which paths we may read has asked for exactly that, and a union of the two
 * would have honoured the refusal and thrown away the permission.
 *
 * `Allow` is collected as well as `Disallow`, with longest-match-wins in
 * `robotsForbids`, for the same reason.
 */
export function robotsRules(robots: string): RobotsRules {
  const groups: Record<'named' | 'star', { allow: string[]; disallow: string[] }> = {
    named: { allow: [], disallow: [] },
    star: { allow: [], disallow: [] },
  };
  /** The groups the current run of `User-agent:` lines is writing into. */
  let active: ('named' | 'star')[] = [];
  let sawAgentInGroup = false;
  /** Whether the file names us at all, which is not the same as having rules for us. */
  let namedGroupExists = false;

  for (const rawLine of robots.split(/\r?\n/u)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      // A new group starts at the first agent line after a rule line. Several agent
      // lines in a row share one group, which is what the standard says and what real
      // files do.
      if (!sawAgentInGroup) active = [];
      sawAgentInGroup = true;
      const agent = value.toLowerCase();
      if (agent === RESEARCH_ROBOTS_TOKEN) {
        active.push('named');
        namedGroupExists = true;
      } else if (agent === '*') active.push('star');
      continue;
    }
    sawAgentInGroup = false;
    if (active.length === 0 || value === '') continue;
    // An empty `Disallow` is the standard's way of saying "nothing", and it is dropped
    // by the `value === ''` above rather than turned into a pattern matching every path.
    for (const group of active) {
      if (field === 'disallow') groups[group].disallow.push(value);
      if (field === 'allow') groups[group].allow.push(value);
    }
  }

  // The named group wins **by existing**, empty or not — which is why its existence is
  // tracked separately from whether it has rules. A file that says
  // `User-agent: CallieResearch` with `Disallow:` under it has granted everything, and
  // deciding on "has rules" fell back to a restrictive `*` group there and read a grant
  // as a refusal.
  const chosen = namedGroupExists ? groups.named : groups.star;
  return { allow: chosen.allow, disallow: chosen.disallow };
}

/**
 * A path in one canonical form, so a rule and a request can be compared.
 *
 * RFC 9309 §2.2.2 asks that paths be compared as percent-encoded octets. Both sides go
 * through this: unreserved characters are decoded, and **everything else is encoded** —
 * which is the half that was missing. A request for `/café` and a rule reading
 * `Disallow: /caf%C3%A9` are the same path, and comparing one encoded with one not made
 * them different, so the site's rule matched nothing.
 *
 * `keepWildcard` is the asymmetry the standard requires. In a **rule**, a bare `*` is
 * the wildcard and `%2A` is a literal star; in a **request path** there is no wildcard,
 * so a literal `*` is encoded to `%2A` before matching. Without that, a request for
 * `/file-*` matched `Disallow: /file-%2A` only by accident and a rule reading
 * `Disallow: /file-*` matched paths it never meant.
 */
export function normaliseRobotsPath(path: string, options: { readonly keepWildcard?: boolean } = {}): string {
  const keepWildcard = options.keepWildcard === true;
  let out = '';
  for (const character of path) {
    if (keepWildcard && (character === '*' || character === '$')) {
      out += character;
      continue;
    }
    if (character === '%') {
      out += '%';
      continue;
    }
    // The unreserved set of RFC 3986 §2.3 passes through; everything else — reserved
    // characters, spaces, and every non-ASCII code point — is encoded as its UTF-8
    // octets, upper-cased.
    out += /[A-Za-z0-9\-._~/]/u.test(character) ? character : encodeOctets(character);
  }
  // Now fold the escapes that were already there: `%7e` and `%7E` are `~`, and a
  // reserved escape keeps its escape with upper-case hex.
  return out.replace(/%([0-9a-fA-F]{2})/gu, (whole, hex: string) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    return /[A-Za-z0-9\-._~]/u.test(character) ? character : whole.toUpperCase();
  });
}

/** One character as upper-case percent-encoded UTF-8 octets. */
function encodeOctets(character: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(character)) {
    out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** How long a pattern is for the longest-match rule: octets, not UTF-16 code units. */
function octets(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** How long a robots pattern may be before it is ignored as not a path. */
const MAX_ROBOTS_PATTERN = 500;

/**
 * One robots pattern as a regular expression.
 *
 * `*` is any sequence and a trailing `$` anchors the end; everything else is literal,
 * which is why every other regular-expression character is escaped. Both are in the
 * standard and both change the answer: `/*.pdf$` and `/private` are different rules,
 * and treating the first as a literal prefix would read it as forbidding nothing.
 */
function robotsPattern(pattern: string): RegExp | null {
  if (pattern.length > MAX_ROBOTS_PATTERN) return null;
  const anchored = pattern.endsWith('$');
  // A rule keeps its wildcard; everything else in it is canonicalised the same way a
  // request path is.
  const literal = normaliseRobotsPath(anchored ? pattern.slice(0, -1) : pattern, { keepWildcard: true });
  const escaped = literal
    .replace(/[.*+?^${}()|[\]\\]/gu, character => (character === '*' ? '\u0000' : `\\${character}`))
    .replaceAll('\u0000', '.*');
  try {
    return new RegExp(`^${escaped}${anchored ? '$' : ''}`, 'u');
  } catch {
    return null;
  }
}

/** The octet length of the longest pattern in `patterns` that matches `path`, or -1. */
function longestMatch(patterns: readonly string[], path: string): number {
  let longest = -1;
  for (const pattern of patterns) {
    const expression = robotsPattern(pattern);
    if (expression === null || !expression.test(path)) continue;
    longest = Math.max(longest, octets(normaliseRobotsPath(pattern, { keepWildcard: true })));
  }
  return longest;
}

/**
 * Whether the rules forbid this path.
 *
 * Longest-match-wins between `Allow` and `Disallow`, and a tie goes to `Allow`. That is
 * the standard's rule and it is also the only one that makes `Disallow: /` plus
 * `Allow: /about` mean what the site meant, rather than either "read nothing" or "read
 * everything".
 */
export function robotsForbids(rules: RobotsRules, path: string): boolean {
  // A request path has no wildcard: a literal `*` in it is encoded, so it can only be
  // matched by a rule that wrote `%2A`.
  const normalized = normaliseRobotsPath(path);
  const forbidden = longestMatch(rules.disallow, normalized);
  if (forbidden < 0) return false;
  return forbidden > longestMatch(rules.allow, normalized);
}

/**
 * What one host's robots.txt said, or that it could not be read.
 *
 * `unreadable` is not "no rules". A file this fetcher could not read completely is a
 * file whose `Disallow` lines it cannot claim to be honouring, so the host's pages are
 * skipped rather than fetched on an assumption.
 */
type RobotsAnswer = { readonly kind: 'rules'; readonly rules: RobotsRules } | { readonly kind: 'unreadable' };

interface Skips {
  readonly bump: (reason: string) => void;
  readonly counts: Record<string, number>;
}

function skipCounter(): Skips {
  const counts: Record<string, number> = {};
  return {
    counts,
    bump: reason => {
      counts[reason] = (counts[reason] ?? 0) + 1;
    },
  };
}

/** Resolve, check every answer, and hand back one to connect to. */
async function checkedAddress(lookup: LookupFn, hostname: string): Promise<string | null> {
  let answers: readonly string[];
  try {
    answers = await lookup(hostname);
  } catch {
    return null;
  }
  if (answers.length === 0) return null;
  // Every one. A name that also answers with a private address is a name that will
  // one day answer with only that.
  if (!answers.every(address => isPublicResearchAddress(address))) return null;
  return answers[0] ?? null;
}

export function researchPageFetch(deps: PageFetchDeps = {}): PageFetchProvider {
  const lookup = deps.lookup ?? systemLookup;
  const request = deps.request ?? systemRequest;
  const clock = deps.now ?? ((): number => Date.now());

  return {
    providerKey: COMPANY_PAGE_PROVIDER,
    fetchPages: async (input: PageFetchRequest): Promise<ProviderOutcome<PageFetchResult>> => {
      const skips = skipCounter();
      const pages: FetchedPage[] = [];
      const deadline = clock() + FIRM_TIMEOUT_MILLISECONDS;
      /**
       * Keyed by host **and** by the address that answered: the rules that were read
       * are that server's rules, and a name that answers with a different address is
       * not a name whose earlier answer can be reused.
       */
      const robotsByHost = new Map<string, RobotsAnswer>();
      /**
       * Slice P1: once the caller's pause predicate says no, no further request is made
       * for this run. Asked before each robots read, each redirect hop and each page.
       */
      let paused = false;
      const mayRequest = async (): Promise<boolean> => {
        if (paused) return false;
        if (input.shouldContinue !== undefined && !(await input.shouldContinue())) paused = true;
        return !paused;
      };

      const robotsFor = async (hostname: string, address: string): Promise<RobotsAnswer> => {
        const cacheKey = `${hostname}|${address}`;
        const cached = robotsByHost.get(cacheKey);
        if (cached !== undefined) return cached;
        const answer = await readRobots(hostname, address);
        robotsByHost.set(cacheKey, answer);
        return answer;
      };

      const readRobots = async (hostname: string, firstAddress: string): Promise<RobotsAnswer> => {
        let url = `https://${hostname}/robots.txt`;
        let address = firstAddress;
        let followed = 0;
        for (;;) {
          // Paused: unread, so the host's pages are not fetched, and the run stops below.
          if (!(await mayRequest())) return { kind: 'unreadable' };
          let response: RawResponse;
          try {
            response = await request({
              url,
              address,
              hostname: new URL(url).hostname,
              maxBytes: MAX_ROBOTS_BYTES,
              timeoutMilliseconds: PAGE_TIMEOUT_MILLISECONDS,
            });
          } catch {
            // A timeout or a reset is not permission.
            return { kind: 'unreadable' };
          }

          if (response.statusCode >= 300 && response.statusCode < 400) {
            const location = headerOf(response, 'location');
            if (location === '' || followed >= MAX_REDIRECTS) return { kind: 'unreadable' };
            let target: string;
            try {
              target = withoutFragment(new URL(location, url).toString());
            } catch {
              return { kind: 'unreadable' };
            }
            // Same site only — another host's robots file is not this host's rules —
            // and past the same URL rule every other request goes through. Without it a
            // firm's server could redirect `/robots.txt` to `/robots.txt?token=…`, and
            // the one request that was exempt from the rule would have carried a query
            // string this fetcher refuses everywhere else.
            if (!isPublicResearchUrl(target) || !isSameResearchSite(url, target)) {
              return { kind: 'unreadable' };
            }
            const nextHost = new URL(target).hostname.toLowerCase();
            const nextAddress = await checkedAddress(lookup, nextHost);
            if (nextAddress === null) return { kind: 'unreadable' };
            followed += 1;
            url = target;
            address = nextAddress;
            continue;
          }

          // The file is absent, and only the absence is the permissive answer.
          if (response.statusCode === 404 || response.statusCode === 410) {
            return { kind: 'rules', rules: EMPTY_ROBOTS_RULES };
          }
          if (response.abortedOverCap || response.statusCode !== 200 || response.body === null) {
            return { kind: 'unreadable' };
          }
          return { kind: 'rules', rules: robotsRules(new TextDecoder('utf-8').decode(response.body)) };
        }
      };

      /**
       * How many pages this run may read in total.
       *
       * Every page, not just the firm's own: `worstCaseRunCents` prices this many pages
       * and `claimResearchClearance` authorized the run against that number, so an
       * added link, an allow-listed path and a discovered link all spend from the same
       * budget. `researchUrlsForFirm` builds a list already inside it; this is the
       * second half of the same rule, and the one discovery has to obey.
       */
      const pageBudget = Math.max(1, Math.min(Math.trunc(input.maxPagesPerFirm), MAX_PAGES_CEILING));

      /**
       * The queue. Seeded with the caller's list, and appended to once by discovery,
       * which is why it is walked by index rather than iterated.
       */
      const queue: string[] = [...input.urls];
      /** The URLs the homepage named. Passed to the policy, which permits exactly these. */
      const discovered: string[] = [];
      let discoveryDone = false;

      for (let index = 0; index < queue.length; index += 1) {
        const initial = queue[index] ?? '';
        if (paused) {
          skips.bump('paused');
          continue;
        }
        if (pages.length >= pageBudget) {
          // Nothing is wrong with the rest of the queue; there is no budget left.
          skips.bump('page_budget_reached');
          continue;
        }
        if (clock() >= deadline) {
          skips.bump('firm_timeout');
          continue;
        }
        let url = initial;
        let permission: UrlPermission = permittedResearchUrl({ ...input, discovered }, url);
        let followed = 0;
        for (;;) {
          if (paused) {
            skips.bump('paused');
            break;
          }
          if (permission === 'blocked') {
            skips.bump('url_not_permitted');
            break;
          }
          const hostname = new URL(url).hostname.toLowerCase();
          const address = await checkedAddress(lookup, hostname);
          if (address === null) {
            skips.bump('address_not_public');
            break;
          }
          const robots = await robotsFor(hostname, address);
          if (paused) {
            // A robots answer cut short by the pause is not a fact about the host: it is
            // not kept for another URL of this run, and nothing more is requested.
            robotsByHost.clear();
            skips.bump('paused');
            break;
          }
          if (robots.kind === 'unreadable') {
            skips.bump('robots_unreadable');
            break;
          }
          if (robotsForbids(robots.rules, new URL(url).pathname)) {
            skips.bump('robots_disallowed');
            break;
          }

          if (!(await mayRequest())) {
            skips.bump('paused');
            break;
          }
          let response: RawResponse;
          try {
            response = await request({
              url,
              address,
              hostname,
              maxBytes: input.maxBytes,
              timeoutMilliseconds: PAGE_TIMEOUT_MILLISECONDS,
            });
          } catch {
            skips.bump('request_failed');
            break;
          }

          if (response.statusCode >= 300 && response.statusCode < 400) {
            const location = headerOf(response, 'location');
            if (location === '' || followed >= MAX_REDIRECTS) {
              skips.bump('redirect_limit');
              break;
            }
            followed += 1;
            // Resolved against the URL we asked for, its fragment dropped, and then
            // decided again: a same-site hop keeps this URL's permission, anything else
            // gets the ordinary rule. Either way the loop starts over with a new
            // lookup, a new robots answer and a new pin.
            const target = withoutFragment(new URL(location, url).toString());
            if (new URL(target).search !== '') {
              // A URL that is fetched is stored, as this page's evidence reference. A
              // query string is where a token or an address would be, and retention
              // cannot find one inside a URL.
              skips.bump('url_has_query');
              break;
            }
            permission = permittedRedirectTarget({ ...input, discovered }, { url, permission }, target);
            url = target;
            continue;
          }
          if (response.abortedOverCap) {
            skips.bump('page_over_bound');
            break;
          }
          if (response.statusCode !== 200 || response.body === null) {
            skips.bump(`status_${String(response.statusCode)}`);
            break;
          }
          const contentType = headerOf(response, 'content-type');
          pages.push({
            url,
            // The exact bytes read, and nothing else: the hash and the blocks
            // `parsePageText` produces describe the same thing.
            contentHash: createHash('sha256').update(response.body).digest('hex'),
            contentType,
            body: response.body,
            retrievedAt: new Date(clock()).toISOString(),
            // Whose words these are: the final URL's relationship to the firm's own
            // site, and nothing else. Deriving it from the permission was wrong for the
            // ordinary case of somebody pasting a link to a page **on the firm's own
            // host** — `added_link` wins before the host check, so the firm's own words
            // were being marked as somebody else's and could not decide fit.
            firstParty:
              input.firmWebsite !== null && isSameResearchSite(input.firmWebsite, url),
          });

          if (!discoveryDone && permission === 'firm_site') {
            // Once, from the first page of the firm's own site that answered — which is
            // the homepage, including a homepage that redirected somewhere first.
            discoveryDone = true;
            for (const candidate of discoverSameSiteUrls(input, {
              from: url,
              hrefs: anchorHrefs(response.body, contentType),
            })) {
              if (queue.includes(candidate)) continue;
              discovered.push(candidate);
              queue.push(candidate);
            }
          }
          break;
        }
      }

      // The fetch is free. A run that read nothing at all is still an outcome the
      // caller records rather than a provider failure: the skip counts say why.
      return { ok: true, value: { pages, skipped: skips.counts }, costCents: 0 };
    },
  };
}
