import { createHash } from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import {
  isPublicResearchAddress,
  permittedResearchUrl,
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
 * Three at most, and each one is a new URL that gets the whole rule again —
 * `permittedResearchUrl`, a fresh resolution, a fresh pin. A redirect that is not
 * permitted is a skip with a reason rather than a followed hop, because otherwise the
 * firm's own server decides where this worker connects.
 *
 * ## robots.txt
 *
 * Fetched first, the same pinned way, and honoured for `*` and for `CallieResearch`.
 * A firm that has asked crawlers not to read a path has asked us, and the block that
 * would have become a quote must not exist. The file is fetched once per host per run.
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

/**
 * The paths a host's robots.txt disallows for `*` or for this fetcher.
 *
 * A deliberately small parser: group by `User-agent`, keep the `Disallow` prefixes of
 * the groups that name us or everybody, and ignore everything else. `Allow` is not
 * honoured, which is the conservative direction — a path both allowed and disallowed
 * is skipped.
 */
export function disallowedPaths(robots: string): readonly string[] {
  const disallowed: string[] = [];
  let applies = false;
  let sawAgentInGroup = false;
  for (const rawLine of robots.split(/\r?\n/u)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      // A new group starts at the first agent line after a rule line.
      if (!sawAgentInGroup) applies = false;
      sawAgentInGroup = true;
      const agent = value.toLowerCase();
      if (agent === '*' || agent === RESEARCH_ROBOTS_TOKEN) applies = true;
      continue;
    }
    sawAgentInGroup = false;
    if (field === 'disallow' && applies && value !== '') disallowed.push(value);
  }
  return disallowed;
}

function robotsForbids(disallowed: readonly string[], path: string): boolean {
  return disallowed.some(prefix => path === prefix || path.startsWith(prefix));
}

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
      const robotsByHost = new Map<string, readonly string[] | null>();

      const robotsFor = async (hostname: string, address: string): Promise<readonly string[] | null> => {
        const cached = robotsByHost.get(hostname);
        if (cached !== undefined) return cached;
        let rules: readonly string[] | null = [];
        try {
          const response = await request({
            url: `https://${hostname}/robots.txt`,
            address,
            hostname,
            // A robots file larger than this is not a robots file.
            maxBytes: 64 * 1024,
            timeoutMilliseconds: PAGE_TIMEOUT_MILLISECONDS,
          });
          if (response.statusCode === 200 && response.body !== null) {
            rules = disallowedPaths(new TextDecoder('utf-8').decode(response.body));
          }
        } catch {
          // A host that will not serve robots.txt has not disallowed anything. It is
          // not a reason to refuse the site: the absence of the file is the permissive
          // answer in the standard, and treating a timeout as a prohibition would make
          // a slow host unreadable for ever.
          rules = [];
        }
        robotsByHost.set(hostname, rules);
        return rules;
      };

      for (const initial of input.urls) {
        if (clock() >= deadline) {
          skips.bump('firm_timeout');
          continue;
        }
        let url = initial;
        let followed = 0;
        for (;;) {
          if (permittedResearchUrl(input, url) === 'blocked') {
            skips.bump('url_not_permitted');
            break;
          }
          const hostname = new URL(url).hostname.toLowerCase();
          const address = await checkedAddress(lookup, hostname);
          if (address === null) {
            skips.bump('address_not_public');
            break;
          }
          const rules = await robotsFor(hostname, address);
          if (rules !== null && robotsForbids(rules, new URL(url).pathname)) {
            skips.bump('robots_disallowed');
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
            // Resolved against the URL we asked for, then re-checked from the top of
            // this loop: a new policy decision, a new lookup, a new pin.
            url = new URL(location, url).toString();
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
          pages.push({
            url,
            // The exact bytes read, and nothing else: the hash and the blocks
            // `parsePageText` produces describe the same thing.
            contentHash: createHash('sha256').update(response.body).digest('hex'),
            contentType: headerOf(response, 'content-type'),
            body: response.body,
            retrievedAt: new Date(clock()).toISOString(),
          });
          break;
        }
      }

      // The fetch is free. A run that read nothing at all is still an outcome the
      // caller records rather than a provider failure: the skip counts say why.
      return { ok: true, value: { pages, skipped: skips.counts }, costCents: 0 };
    },
  };
}
