import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_REDIRECTS,
  RESEARCH_USER_AGENT,
  disallowedPaths,
  researchPageFetch,
  type RawResponse,
  type RequestOptions,
} from '../src/research/companyPageFetch.ts';

/**
 * The live page fetch, driven entirely by fakes. No test here opens a socket.
 *
 * What is proved is the part that cannot be proved in the domain package: that the
 * adapter resolves the name, checks **every** answer, connects to the address it
 * checked rather than to the name, asks the policy again after every redirect, stops
 * at the byte cap, and honours robots.
 *
 * ## The vacuous-pass traps, named
 *
 * **A fetcher that fetches nothing passes every refusal test.** So every refusal case
 * sits beside a request the same fetcher does make, and the happy path asserts the
 * page came back with the right hash.
 *
 * **A lookup nobody looked at.** The fake records what it was asked and what address
 * the request was given, and the pinning tests compare the two.
 */

const HOME = '<p>We manage residential property for owners.</p>';
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

interface Recorded {
  readonly url: string;
  readonly address: string;
  readonly hostname: string;
}

function harness(options: {
  readonly answers: Readonly<Record<string, readonly string[]>>;
  readonly responses: Readonly<Record<string, RawResponse | ((request: RequestOptions) => RawResponse)>>;
}): {
  readonly provider: ReturnType<typeof researchPageFetch>;
  readonly asked: string[];
  readonly sent: Recorded[];
} {
  const asked: string[] = [];
  const sent: Recorded[] = [];
  const provider = researchPageFetch({
    lookup: async hostname => {
      asked.push(hostname);
      const answer = options.answers[hostname];
      if (answer === undefined) throw new Error('ENOTFOUND');
      return answer;
    },
    request: async request => {
      sent.push({ url: request.url, address: request.address, hostname: request.hostname });
      const answer = options.responses[request.url];
      if (answer === undefined) throw new Error('no fake response for ' + request.url);
      return typeof answer === 'function' ? answer(request) : answer;
    },
    now: () => Date.parse('2026-09-28T14:00:00.000Z'),
  });
  return { provider, asked, sent };
}

const ok = (body: string, contentType = 'text/html; charset=utf-8'): RawResponse => ({
  statusCode: 200,
  headers: { 'content-type': contentType },
  body: bytes(body),
  abortedOverCap: false,
});

const robotsAllowing: RawResponse = ok('User-agent: *\nDisallow:\n', 'text/plain');

const request = {
  firmWebsite: 'https://example.test/',
  links: [] as readonly string[],
  maxPagesPerFirm: 1,
  maxBytes: 1_000_000,
};

describe('the fetch is pinned to the address it checked', () => {
  it('reads the page and hashes the exact bytes, connecting to the checked address', async () => {
    const { provider, asked, sent } = harness({
      answers: { 'example.test': ['93.184.216.34'] },
      responses: {
        'https://example.test/robots.txt': robotsAllowing,
        'https://example.test/': ok(HOME),
      },
    });
    const outcome = await provider.fetchPages({ ...request, urls: ['https://example.test/'] });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.pages.length).toBe(1);
    expect(outcome.value.pages[0]?.url).toBe('https://example.test/');
    // sha256 of the exact bytes read.
    expect(outcome.value.pages[0]?.contentHash).toBe(createHash('sha256').update(HOME, 'utf8').digest('hex'));
    expect(asked).toEqual(['example.test']);
    // The socket is given the address, and the name only for TLS and `Host`.
    for (const entry of sent) {
      expect(entry.address).toBe('93.184.216.34');
      expect(entry.hostname).toBe('example.test');
    }
  });

  it('refuses a name whose answers are not all public, even when one of them is', async () => {
    const { provider, sent } = harness({
      answers: { 'example.test': ['93.184.216.34', '169.254.169.254'] },
      responses: {},
    });
    const outcome = await provider.fetchPages({ ...request, urls: ['https://example.test/'] });
    expect(outcome.ok && outcome.value.pages).toEqual([]);
    expect(outcome.ok && outcome.value.skipped).toEqual({ address_not_public: 1 });
    // And nothing was sent at all: the refusal is before the socket.
    expect(sent).toEqual([]);
  });

  it('refuses a name that answers only with a private address', async () => {
    const { provider } = harness({ answers: { 'example.test': ['10.0.0.5'] }, responses: {} });
    const outcome = await provider.fetchPages({ ...request, urls: ['https://example.test/'] });
    expect(outcome.ok && outcome.value.skipped).toEqual({ address_not_public: 1 });
  });
});

describe('redirects', () => {
  it('follows a permitted redirect, re-resolving and re-pinning it', async () => {
    const { provider, asked, sent } = harness({
      answers: { 'example.test': ['93.184.216.34'], 'www.example.test': ['93.184.216.35'] },
      responses: {
        'https://example.test/robots.txt': robotsAllowing,
        'https://www.example.test/robots.txt': robotsAllowing,
        'https://example.test/': {
          statusCode: 301,
          headers: { location: 'https://www.example.test/' },
          body: null,
          abortedOverCap: false,
        },
        'https://www.example.test/': ok(HOME),
      },
    });
    const outcome = await provider.fetchPages({ ...request, urls: ['https://example.test/'] });
    expect(outcome.ok && outcome.value.pages[0]?.url).toBe('https://www.example.test/');
    // The second host was resolved on its own, and the request carried its address.
    expect(asked).toContain('www.example.test');
    expect(sent.find(entry => entry.url === 'https://www.example.test/')?.address).toBe('93.184.216.35');
  });

  it('refuses a redirect to a private address, and to a host the policy does not permit', async () => {
    const { provider } = harness({
      answers: { 'example.test': ['93.184.216.34'], 'internal.test': ['169.254.169.254'] },
      responses: {
        'https://example.test/robots.txt': robotsAllowing,
        'https://example.test/': {
          statusCode: 302,
          headers: { location: 'https://internal.test/' },
          body: null,
          abortedOverCap: false,
        },
      },
    });
    // Another host is not the firm's site and is not an added link, so the policy
    // refuses it before the address check is even reached.
    const outcome = await provider.fetchPages({ ...request, urls: ['https://example.test/'] });
    expect(outcome.ok && outcome.value.pages).toEqual([]);
    expect(outcome.ok && outcome.value.skipped).toEqual({ url_not_permitted: 1 });
  });

  it('stops after three hops rather than following a loop', async () => {
    const hop = (to: string): RawResponse => ({
      statusCode: 302,
      headers: { location: to },
      body: null,
      abortedOverCap: false,
    });
    const { provider } = harness({
      answers: { 'example.test': ['93.184.216.34'], 'www.example.test': ['93.184.216.34'] },
      responses: {
        'https://example.test/robots.txt': robotsAllowing,
        'https://www.example.test/robots.txt': robotsAllowing,
        'https://example.test/': hop('https://www.example.test/'),
        'https://www.example.test/': hop('https://example.test/'),
      },
    });
    const outcome = await provider.fetchPages({ ...request, urls: ['https://example.test/'] });
    expect(outcome.ok && outcome.value.skipped).toEqual({ redirect_limit: 1 });
    expect(MAX_REDIRECTS).toBe(3);
  });
});

describe('bounds and robots', () => {
  it('drops a page the byte cap aborted rather than hashing half of it', async () => {
    const { provider } = harness({
      answers: { 'example.test': ['93.184.216.34'] },
      responses: {
        'https://example.test/robots.txt': robotsAllowing,
        'https://example.test/': { statusCode: 200, headers: {}, body: null, abortedOverCap: true },
      },
    });
    const outcome = await provider.fetchPages({ ...request, urls: ['https://example.test/'], maxBytes: 1024 });
    expect(outcome.ok && outcome.value.pages).toEqual([]);
    expect(outcome.ok && outcome.value.skipped).toEqual({ page_over_bound: 1 });
  });

  it('honours a Disallow for `*` and one for CallieResearch by name', async () => {
    for (const robots of ['User-agent: *\nDisallow: /about\n', 'User-agent: CallieResearch\nDisallow: /about\n']) {
      const { provider } = harness({
        answers: { 'example.test': ['93.184.216.34'] },
        responses: {
          'https://example.test/robots.txt': ok(robots, 'text/plain'),
          'https://example.test/': ok(HOME),
        },
      });
      const outcome = await provider.fetchPages({
        ...request,
        maxPagesPerFirm: 2,
        urls: ['https://example.test/', 'https://example.test/about'],
      });
      // The home page still comes back, so this is not a fetcher that fetches nothing.
      expect(outcome.ok && outcome.value.pages.map(page => page.url)).toEqual(['https://example.test/']);
      expect(outcome.ok && outcome.value.skipped).toEqual({ robots_disallowed: 1 });
    }
  });

  it('ignores a Disallow written for somebody else', () => {
    expect(disallowedPaths('User-agent: GPTBot\nDisallow: /\n')).toEqual([]);
    expect(disallowedPaths('User-agent: *\nDisallow: /private\nAllow: /private/ok\n')).toEqual(['/private']);
    expect(disallowedPaths('# nothing here\n')).toEqual([]);
  });

  it('reads robots.txt once per host, however many pages it fetches', async () => {
    const { provider, sent } = harness({
      answers: { 'example.test': ['93.184.216.34'] },
      responses: {
        'https://example.test/robots.txt': robotsAllowing,
        'https://example.test/': ok(HOME),
        'https://example.test/about': ok('<p>About us.</p>'),
      },
    });
    await provider.fetchPages({
      ...request,
      maxPagesPerFirm: 2,
      urls: ['https://example.test/', 'https://example.test/about'],
    });
    expect(sent.filter(entry => entry.url.endsWith('/robots.txt')).length).toBe(1);
  });

  it('names itself, so a firm reading its own logs can find out who this is', () => {
    expect(RESEARCH_USER_AGENT).toBe('CallieResearch/1.0 (+https://usecallie.com)');
  });

  it('skips a page that failed and keeps the ones that did not', async () => {
    const { provider } = harness({
      answers: { 'example.test': ['93.184.216.34'] },
      responses: {
        'https://example.test/robots.txt': robotsAllowing,
        'https://example.test/': ok(HOME),
        'https://example.test/about': { statusCode: 404, headers: {}, body: null, abortedOverCap: false },
      },
    });
    const outcome = await provider.fetchPages({
      ...request,
      maxPagesPerFirm: 2,
      urls: ['https://example.test/', 'https://example.test/about'],
    });
    expect(outcome.ok && outcome.value.pages.length).toBe(1);
    expect(outcome.ok && outcome.value.skipped).toEqual({ status_404: 1 });
    // The fetch itself is free: the ledger row it produces is a count, not money.
    expect(outcome.costCents).toBe(0);
  });
});
