import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_REDIRECTS,
  RESEARCH_USER_AGENT,
  normaliseRobotsPath,
  robotsForbids,
  robotsRules,
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
    expect(robotsRules('User-agent: GPTBot\nDisallow: /\n')).toEqual({ allow: [], disallow: [] });
    expect(robotsRules('User-agent: *\nDisallow: /private\nAllow: /private/ok\n')).toEqual({
      allow: ['/private/ok'],
      disallow: ['/private'],
    });
    expect(robotsRules('# nothing here\n')).toEqual({ allow: [], disallow: [] });
    // An empty `Disallow` is the standard's "nothing", not a pattern matching everything.
    expect(robotsRules('User-agent: *\nDisallow:\n')).toEqual({ allow: [], disallow: [] });
  });

  it('reads `*` and `$` the way the standard does', () => {
    const rules = robotsRules('User-agent: *\nDisallow: /*.pdf$\nDisallow: /a/*/private\n');
    expect(robotsForbids(rules, '/brochure.pdf')).toBe(true);
    // Anchored: the same extension in the middle of a path is not the rule.
    expect(robotsForbids(rules, '/brochure.pdf.html')).toBe(false);
    expect(robotsForbids(rules, '/a/b/private')).toBe(true);
    expect(robotsForbids(rules, '/a/private')).toBe(false);
    // A literal dot stays a literal dot.
    expect(robotsForbids(robotsRules('User-agent: *\nDisallow: /a.b\n'), '/axb')).toBe(false);
  });

  it('uses the CallieResearch group alone when there is one, and never merges it with `*`', () => {
    // RFC 9309 §2.2.1: the most specific matching group applies, and only it. A site
    // that shuts `*` out and then writes a group for us has told us exactly what we may
    // read, and a union of the two would honour the refusal and throw away the
    // permission.
    const both = robotsRules('User-agent: *\nDisallow: /\n\nUser-agent: CallieResearch\nDisallow: /private\n');
    expect(both).toEqual({ allow: [], disallow: ['/private'] });
    expect(robotsForbids(both, '/about')).toBe(false);
    expect(robotsForbids(both, '/private/x')).toBe(true);
    // The named group wins by existing, even when it says nothing is forbidden.
    const permissive = robotsRules('User-agent: *\nDisallow: /\n\nUser-agent: callieresearch\nAllow: /\n');
    expect(robotsForbids(permissive, '/anything')).toBe(false);
    // With no named group, the `*` group is the one that applies.
    expect(robotsRules('User-agent: *\nDisallow: /x\n')).toEqual({ allow: [], disallow: ['/x'] });
    // Two agent lines in a row share one group, as real files write them.
    const shared = robotsRules('User-agent: GPTBot\nUser-agent: CallieResearch\nDisallow: /x\n');
    expect(shared.disallow).toEqual(['/x']);
  });

  it('gives a named Disallow the answer over a longer Allow from the ignored `*` group', () => {
    // The trap: a wildcard Allow in the `*` group is not a longer match, because the
    // `*` group is not consulted at all when a named one exists.
    const rules = robotsRules(
      'User-agent: *\nAllow: /reports/quarterly/2026/index.html\n\nUser-agent: CallieResearch\nDisallow: /reports\n',
    );
    expect(robotsForbids(rules, '/reports/quarterly/2026/index.html')).toBe(true);
  });

  it('compares percent-encoded and literal paths as one path', () => {
    // §2.2.2: unreserved octets are compared decoded. A site that disallowed `/%7Ejoe`
    // meant `/~joe`, and a fetcher that read the two as different paths would walk
    // straight past what it asked.
    expect(normaliseRobotsPath('/%7Ejoe/%7ex')).toBe('/~joe/~x');
    expect(robotsForbids(robotsRules('User-agent: *\nDisallow: /%7Ejoe\n'), '/~joe/cv')).toBe(true);
    expect(robotsForbids(robotsRules('User-agent: *\nDisallow: /~joe\n'), '/%7Ejoe/cv')).toBe(true);
    // A reserved octet keeps its escape, upper-cased, so the two forms still meet.
    expect(robotsForbids(robotsRules('User-agent: *\nDisallow: /a%2fb\n'), '/a%2Fb')).toBe(true);
  });

  it('matches a non-ASCII path against its percent-encoded rule, and a literal star as a literal', () => {
    // Both sides are brought to percent-encoded octets before they are compared, which
    // is the only form the two can meet in: a site writes `/caf%C3%A9` and a link
    // carries `/café`, and they are one path.
    expect(robotsForbids(robotsRules('User-agent: *\nDisallow: /caf%C3%A9\n'), '/café/menu')).toBe(true);
    expect(robotsForbids(robotsRules('User-agent: *\nDisallow: /café\n'), '/caf%C3%A9/menu')).toBe(true);
    // `*` in a rule is the wildcard; `%2A` in a rule is a literal star and matches only
    // one. A request path's own star is encoded, so it cannot become a wildcard.
    const literal = robotsRules('User-agent: *\nDisallow: /file-%2A\n');
    expect(robotsForbids(literal, '/file-*')).toBe(true);
    expect(robotsForbids(literal, '/file-anything')).toBe(false);
    const wildcard = robotsRules('User-agent: *\nDisallow: /file-*\n');
    expect(robotsForbids(wildcard, '/file-anything')).toBe(true);
    expect(robotsForbids(wildcard, '/file-*')).toBe(true);
  });

  it('lets an empty named group win over a restrictive `*` group', () => {
    // §2.2.1: the most specific group applies *alone*, and a group with no rules is
    // still a group. A file that names CallieResearch and says nothing under it has
    // allowed everything, however strict the `*` group above it is.
    const rules = robotsRules('User-agent: *\nDisallow: /\n\nUser-agent: CallieResearch\n');
    expect(rules).toEqual({ allow: [], disallow: [] });
    expect(robotsForbids(rules, '/about')).toBe(false);
  });

  it('gives the longest match the answer, so Disallow / plus Allow /about is readable', () => {
    const rules = robotsRules('User-agent: *\nDisallow: /\nAllow: /about\n');
    expect(robotsForbids(rules, '/about')).toBe(false);
    expect(robotsForbids(rules, '/pricing')).toBe(true);
    // A tie goes to Allow, which is the standard's rule and the readable direction.
    expect(robotsForbids(robotsRules('User-agent: *\nDisallow: /x\nAllow: /x\n'), '/x')).toBe(false);
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

describe('a robots file that cannot be read is not permission', () => {
  const pageResponses = {
    'https://example.test/': ok(HOME),
  };

  it('skips the host’s pages when robots answers 500, times out, or is over the cap', async () => {
    const answers: readonly RawResponse[] = [
      { statusCode: 500, headers: {}, body: null, abortedOverCap: false },
      { statusCode: 200, headers: {}, body: null, abortedOverCap: true },
    ];
    for (const robots of answers) {
      const { provider } = harness({
        answers: { 'example.test': ['93.184.216.34'] },
        responses: { 'https://example.test/robots.txt': robots, ...pageResponses },
      });
      const outcome = await provider.fetchPages({ ...request, urls: ['https://example.test/'] });
      expect(outcome.ok && outcome.value.pages).toEqual([]);
      expect(outcome.ok && outcome.value.skipped).toEqual({ robots_unreadable: 1 });
    }
    // A thrown request — a timeout or a reset — is the same answer.
    const { provider } = harness({
      answers: { 'example.test': ['93.184.216.34'] },
      responses: pageResponses,
    });
    const outcome = await provider.fetchPages({ ...request, urls: ['https://example.test/'] });
    expect(outcome.ok && outcome.value.skipped).toEqual({ robots_unreadable: 1 });
  });

  it('treats only a 404 or a 410 as "there are no rules"', async () => {
    for (const statusCode of [404, 410]) {
      const { provider } = harness({
        answers: { 'example.test': ['93.184.216.34'] },
        responses: {
          'https://example.test/robots.txt': { statusCode, headers: {}, body: null, abortedOverCap: false },
          ...pageResponses,
        },
      });
      const outcome = await provider.fetchPages({ ...request, urls: ['https://example.test/'] });
      expect(outcome.ok && outcome.value.pages.length, String(statusCode)).toBe(1);
    }
  });

  it('refuses a robots redirect that the URL rule refuses, query string included', async () => {
    // The one request that used to be exempt from `isPublicResearchUrl`. A firm's own
    // server could point `/robots.txt` at `/robots.txt?token=…`, and this fetcher
    // refuses a query string everywhere else because a fetched URL is a stored URL.
    for (const location of ['/robots.txt?token=abc123', 'http://example.test/robots.txt', '/robots.txt#top']) {
      const { provider, sent } = harness({
        answers: { 'example.test': ['93.184.216.34'] },
        responses: {
          'https://example.test/robots.txt': {
            statusCode: 301,
            headers: { location },
            body: null,
            abortedOverCap: false,
          },
          ...pageResponses,
        },
      });
      const outcome = await provider.fetchPages({ ...request, urls: ['https://example.test/'] });
      // A fragment is dropped rather than refused, so that one is followed — to the
      // same URL, which the fake answers with the same redirect until the hop limit.
      const skipped = outcome.ok ? outcome.value.skipped : {};
      expect(skipped['robots_unreadable'], location).toBe(1);
      expect(sent.some(entry => entry.url.includes('token=')), location).toBe(false);
    }
  });

  it('follows a robots redirect on the same site, and refuses one off it', async () => {
    const moved: RawResponse = {
      statusCode: 301,
      headers: { location: 'https://www.example.test/robots.txt' },
      body: null,
      abortedOverCap: false,
    };
    const { provider, sent } = harness({
      answers: { 'example.test': ['93.184.216.34'], 'www.example.test': ['93.184.216.35'] },
      responses: {
        'https://example.test/robots.txt': moved,
        'https://www.example.test/robots.txt': ok('User-agent: *\nDisallow: /about\n', 'text/plain'),
        ...pageResponses,
        'https://example.test/about': ok('<p>About us.</p>'),
      },
    });
    const outcome = await provider.fetchPages({
      ...request,
      maxPagesPerFirm: 2,
      urls: ['https://example.test/', 'https://example.test/about'],
    });
    // The redirected file was read, and its rule was honoured.
    expect(outcome.ok && outcome.value.pages.map(page => page.url)).toEqual(['https://example.test/']);
    expect(outcome.ok && outcome.value.skipped).toEqual({ robots_disallowed: 1 });
    // The second host was resolved on its own and the request carried its address.
    expect(sent.find(entry => entry.url === 'https://www.example.test/robots.txt')?.address).toBe('93.184.216.35');

    const offSite: RawResponse = {
      statusCode: 301,
      headers: { location: 'https://cdn.other.test/robots.txt' },
      body: null,
      abortedOverCap: false,
    };
    const away = harness({
      answers: { 'example.test': ['93.184.216.34'], 'cdn.other.test': ['93.184.216.36'] },
      responses: { 'https://example.test/robots.txt': offSite, ...pageResponses },
    });
    const second = await away.provider.fetchPages({ ...request, urls: ['https://example.test/'] });
    expect(second.ok && second.value.skipped).toEqual({ robots_unreadable: 1 });
    // And it was never asked for: another host's file is not this host's rules.
    expect(away.sent.some(entry => entry.url.includes('cdn.other.test'))).toBe(false);
  });
});

describe('a redirect on the firm’s own site keeps its permission', () => {
  const hop = (to: string): RawResponse => ({
    statusCode: 301,
    headers: { location: to },
    body: null,
    abortedOverCap: false,
  });

  it('fetches a homepage that answers 301 to /home', async () => {
    // The ordinary case the exact-path re-check used to lose, and losing it meant the
    // firm yielded nothing at all.
    const { provider } = harness({
      answers: { 'example.test': ['93.184.216.34'] },
      responses: {
        'https://example.test/robots.txt': robotsAllowing,
        'https://example.test/': hop('/home'),
        'https://example.test/home': ok(HOME),
      },
    });
    const outcome = await provider.fetchPages({ ...request, urls: ['https://example.test/'] });
    expect(outcome.ok && outcome.value.pages.map(page => page.url)).toEqual(['https://example.test/home']);
    // Still the firm's own words.
    expect(outcome.ok && outcome.value.pages[0]?.firstParty).toBe(true);
    expect(outcome.ok && outcome.value.skipped).toEqual({});
  });

  it('skips a redirect to another host that nobody added', async () => {
    const { provider, sent } = harness({
      answers: { 'example.test': ['93.184.216.34'], 'other.test': ['93.184.216.40'] },
      responses: {
        'https://example.test/robots.txt': robotsAllowing,
        'https://example.test/': hop('https://other.test/home'),
      },
    });
    const outcome = await provider.fetchPages({ ...request, urls: ['https://example.test/'] });
    expect(outcome.ok && outcome.value.pages).toEqual([]);
    expect(outcome.ok && outcome.value.skipped).toEqual({ url_not_permitted: 1 });
    // A public, resolvable host: the refusal is the policy's, not the address check's.
    expect(sent.some(entry => entry.hostname === 'other.test')).toBe(false);
  });

  it('skips a redirect target carrying a query string', async () => {
    const { provider } = harness({
      answers: { 'example.test': ['93.184.216.34'] },
      responses: {
        'https://example.test/robots.txt': robotsAllowing,
        'https://example.test/': hop('/home?session=abc123'),
      },
    });
    const outcome = await provider.fetchPages({ ...request, urls: ['https://example.test/'] });
    expect(outcome.ok && outcome.value.skipped).toEqual({ url_has_query: 1 });
  });

  it('drops a fragment rather than treating it as a different page', async () => {
    const { provider, sent } = harness({
      answers: { 'example.test': ['93.184.216.34'] },
      responses: {
        'https://example.test/robots.txt': robotsAllowing,
        'https://example.test/': hop('/home#top'),
        'https://example.test/home': ok(HOME),
      },
    });
    const outcome = await provider.fetchPages({ ...request, urls: ['https://example.test/'] });
    expect(outcome.ok && outcome.value.pages[0]?.url).toBe('https://example.test/home');
    expect(sent.some(entry => entry.url.includes('#'))).toBe(false);
  });

  it('marks a page on the firm’s own host as the firm’s own words, however it was permitted', async () => {
    // `added_link` wins before the host check, so a link somebody pastes to a page on
    // the firm's *own* site used to come back marked third-party — and a third-party
    // fact cannot decide fit. Whose words these are is a fact about the URL, not about
    // which clause let it through.
    const { provider } = harness({
      answers: { 'example.test': ['93.184.216.34'] },
      responses: {
        'https://example.test/robots.txt': robotsAllowing,
        'https://example.test/news/we-grew': ok('<p>We now manage 400 doors.</p>'),
      },
    });
    const outcome = await provider.fetchPages({
      ...request,
      links: ['https://example.test/news/we-grew'],
      urls: ['https://example.test/news/we-grew'],
    });
    expect(outcome.ok && outcome.value.pages[0]?.firstParty).toBe(true);
  });

  it('marks a page fetched from an added link as not the firm’s own words', async () => {
    const { provider } = harness({
      answers: { 'news.test': ['93.184.216.50'] },
      responses: {
        'https://news.test/robots.txt': robotsAllowing,
        'https://news.test/piece': ok('<p>The firm manages 400 doors, we are told.</p>'),
      },
    });
    const outcome = await provider.fetchPages({
      ...request,
      links: ['https://news.test/piece'],
      urls: ['https://news.test/piece'],
    });
    expect(outcome.ok && outcome.value.pages[0]?.firstParty).toBe(false);
  });
});

describe('the homepage’s own links', () => {
  const NAV = `<p>We manage residential property for owners.</p>
    <a href="/about-us">About us</a>
    <a href="/careers/">Careers</a>
    <a href="/blog/2026/hello">Blog</a>
    <a href="https://other.test/about-us">Our partner</a>
    <a href="https://www.linkedin.com/company/x/about">LinkedIn</a>
    <a href="mailto:hello@example.test">E-mail</a>
    <a href="javascript:void(0)">Menu</a>`;

  const site = (extra: Readonly<Record<string, RawResponse>> = {}): Readonly<Record<string, RawResponse>> => ({
    'https://example.test/robots.txt': robotsAllowing,
    'https://example.test/': ok(NAV),
    ...extra,
  });

  it('fetches the about and careers pages it found, within the page budget', async () => {
    const { provider, sent } = harness({
      answers: { 'example.test': ['93.184.216.34'], 'other.test': ['93.184.216.40'] },
      responses: site({
        'https://example.test/about-us': ok('<p>Founded in 1994.</p>'),
        'https://example.test/careers': ok('<p>We are hiring a maintenance coordinator.</p>'),
      }),
    });
    // Three pages of budget and one fixed URL, so discovery has two to spend.
    const outcome = await provider.fetchPages({
      ...request,
      maxPagesPerFirm: 3,
      urls: ['https://example.test/'],
    });
    expect(outcome.ok && outcome.value.pages.map(page => page.url)).toEqual([
      'https://example.test/',
      'https://example.test/about-us',
      'https://example.test/careers',
    ]);
    // Discovered pages are the firm's own words: its own host, its own navigation.
    expect(outcome.ok && outcome.value.pages.every(page => page.firstParty)).toBe(true);
    // And nothing off the site was asked for, whatever the homepage linked to.
    expect(sent.every(entry => entry.hostname === 'example.test')).toBe(true);
  });

  it('never exceeds the page budget, however many links the homepage has', async () => {
    const { provider } = harness({
      answers: { 'example.test': ['93.184.216.34'] },
      responses: site({
        'https://example.test/about-us': ok('<p>Founded in 1994.</p>'),
        'https://example.test/careers': ok('<p>Hiring.</p>'),
      }),
    });
    const outcome = await provider.fetchPages({ ...request, maxPagesPerFirm: 2, urls: ['https://example.test/'] });
    expect(outcome.ok && outcome.value.pages.length).toBe(2);
    // The third candidate is not a refusal; there is no budget left for it.
    expect(outcome.ok && outcome.value.skipped['page_budget_reached']).toBe(1);
  });

  it('still asks robots about a discovered page', async () => {
    const { provider } = harness({
      answers: { 'example.test': ['93.184.216.34'] },
      responses: site({
        'https://example.test/robots.txt': ok('User-agent: *\nDisallow: /careers\n', 'text/plain'),
        'https://example.test/about-us': ok('<p>Founded in 1994.</p>'),
      }),
    });
    // Three pages of budget: `/careers` is not in the fixed prefix at three, so the
    // homepage's link to it is a page this run would otherwise have gained.
    const outcome = await provider.fetchPages({ ...request, maxPagesPerFirm: 3, urls: ['https://example.test/'] });
    expect(outcome.ok && outcome.value.pages.map(page => page.url)).toEqual([
      'https://example.test/',
      'https://example.test/about-us',
    ]);
    expect(outcome.ok && outcome.value.skipped['robots_disallowed']).toBe(1);
  });

  it('discovers from a homepage that redirected first', async () => {
    const { provider } = harness({
      answers: { 'example.test': ['93.184.216.34'] },
      responses: site({
        'https://example.test/': {
          statusCode: 301,
          headers: { location: '/home' },
          body: null,
          abortedOverCap: false,
        },
        'https://example.test/home': ok(NAV),
        'https://example.test/about-us': ok('<p>Founded in 1994.</p>'),
      }),
    });
    const outcome = await provider.fetchPages({ ...request, maxPagesPerFirm: 2, urls: ['https://example.test/'] });
    expect(outcome.ok && outcome.value.pages.map(page => page.url)).toEqual([
      'https://example.test/home',
      'https://example.test/about-us',
    ]);
  });
});

// Slice P1, invariant I1: the pause predicate is asked before every request.
describe('the research pause, asked before each request', () => {
  const responses = {
    'https://example.test/robots.txt': robotsAllowing,
    'https://example.test/': ok(HOME),
    'https://example.test/about': ok(HOME),
  };

  it('makes no request at all once research is off, even when it went off during the address lookup', async () => {
    let on = true;
    const sent: string[] = [];
    const provider = researchPageFetch({
      lookup: async () => {
        on = false; // turned off while the name was being resolved
        return await Promise.resolve(['93.184.216.34']);
      },
      request: async options => {
        sent.push(options.url);
        return await Promise.resolve(responses[options.url as keyof typeof responses] ?? ok(HOME));
      },
      now: () => Date.parse('2026-09-28T14:00:00.000Z'),
    });
    const answer = await provider.fetchPages({
      ...request,
      maxPagesPerFirm: 2,
      urls: ['https://example.test/', 'https://example.test/about'],
      shouldContinue: async () => await Promise.resolve(on),
    });
    expect(sent).toEqual([]);
    expect(answer.ok).toBe(true);
    if (answer.ok) {
      expect(answer.value.pages).toEqual([]);
      expect(answer.value.skipped['paused']).toBe(2);
    }
  });

  it('stops between pages: off after the first page, nothing more is requested', async () => {
    let on = true;
    const sent: string[] = [];
    const provider = researchPageFetch({
      lookup: async () => await Promise.resolve(['93.184.216.34']),
      request: async options => {
        sent.push(options.url);
        if (options.url === 'https://example.test/') on = false;
        return await Promise.resolve(responses[options.url as keyof typeof responses] ?? ok(HOME));
      },
      now: () => Date.parse('2026-09-28T14:00:00.000Z'),
    });
    const answer = await provider.fetchPages({
      ...request,
      maxPagesPerFirm: 2,
      urls: ['https://example.test/', 'https://example.test/about'],
      shouldContinue: async () => await Promise.resolve(on),
    });
    expect(sent).toEqual(['https://example.test/robots.txt', 'https://example.test/']);
    expect(answer.ok && answer.value.pages.length).toBe(1);
  });
});
