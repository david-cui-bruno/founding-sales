import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_RESEARCH_HOSTS,
  discoverSameSiteUrls,
  isPublicResearchAddress,
  isPublicResearchUrl,
  MAX_DISCOVERED_CANDIDATES,
  permittedRedirectTarget,
  permittedResearchUrl,
  researchUrlsForFirm,
  withoutFragment,
} from '../../research/sourcePolicy.ts';
import {
  anchorHrefs,
  blocksFromPlainText,
  parsePageText,
  MAX_ANCHOR_HREFS,
  MAX_BLOCKS,
  MAX_TEXT_CHARACTERS,
} from '../../research/pageText.ts';
import { jobIdempotencyKey, RESEARCH_FIRM_JOB_KEY_PREFIX } from '../../jobs/jobKinds.ts';
import { DEFAULT_RESEARCH_SETTINGS } from '../../research/settings.ts';
import { FACT_KEYS, PERSON_FACT_KEYS, validateFactSelections } from '../../research/facts.ts';

/**
 * The rules research is made of, proved without a socket.
 *
 * The first test is the one that keeps the rest honest: it reads every file in
 * `packages/domain/research` and fails on a network import. That is what makes "no
 * live provider call anywhere in the domain" a property of the tree rather than a
 * claim in a comment, and it is why the two live adapters are in `apps/worker`.
 */

const RESEARCH_DIRECTORY = fileURLToPath(new URL('../../research/', import.meta.url));

function researchSourceFiles(directory: string = RESEARCH_DIRECTORY): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...researchSourceFiles(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files.sort();
}

describe('the domain package opens no socket', () => {
  it('imports no network module and calls no bare fetch', () => {
    const offenders: string[] = [];
    for (const file of researchSourceFiles()) {
      const source = readFileSync(file, 'utf8');
      const name = file.slice(RESEARCH_DIRECTORY.length);
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/gu)) {
        const specifier = match[1] ?? '';
        // `node:net` is allowed for `isIP` alone, which opens nothing.
        if (specifier === 'node:net') continue;
        if (/^node:(https?|dns|net|tls|dgram)$/u.test(specifier) || specifier === 'undici') {
          offenders.push(`${name} imports ${specifier}`);
        }
      }
      if (/(?<![.\w])fetch\s*\(/u.test(source)) offenders.push(`${name} calls fetch(`);
    }
    expect(offenders, 'a research module can reach the network').toEqual([]);
  });

  it('imports nothing that could enroll, send or dial', () => {
    const forbidden = [/sequences?\//iu, /enroll/iu, /outbound/iu, /gmail/iu, /mailbox/iu, /\/dial/iu, /\/send/iu];
    const offenders: string[] = [];
    for (const file of researchSourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/gu)) {
        const specifier = match[1] ?? '';
        if (forbidden.some(pattern => pattern.test(specifier))) {
          offenders.push(`${file.slice(RESEARCH_DIRECTORY.length)} imports ${specifier}`);
        }
      }
    }
    expect(offenders, 'a research module can reach an outreach path').toEqual([]);
  });

  it('names no outreach table in any statement', () => {
    const forbiddenTables = [
      'sequence_enrollments',
      'step_executions',
      'outbound_messages',
      'dial_tickets',
      'mailboxes',
      'mail_messages',
      'sequence_versions',
    ];
    const offenders: string[] = [];
    for (const file of researchSourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const table of forbiddenTables) {
        if (new RegExp(`(?:INTO|FROM|UPDATE|JOIN)\\s+${table}\\b`, 'iu').test(source)) {
          offenders.push(`${file.slice(RESEARCH_DIRECTORY.length)}: ${table}`);
        }
      }
    }
    expect(offenders, 'a research statement named an outreach table').toEqual([]);
  });
});

describe('which addresses research may connect to', () => {
  it('admits an ordinary public IPv4 address', () => {
    for (const address of ['93.184.216.34', '1.1.1.1', '8.8.8.8', '203.1.0.5']) {
      expect(isPublicResearchAddress(address), address).toBe(true);
    }
  });

  it('refuses every private, loopback, link-local, CGNAT, multicast and reserved range', () => {
    const refused = [
      '10.0.0.1', // RFC 1918
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '127.0.0.1', // loopback
      '169.254.169.254', // the cloud metadata endpoint
      '100.64.0.1', // CGNAT
      '100.127.255.255',
      '192.0.2.1', // documentation
      '198.18.0.1', // benchmarking
      '198.51.100.7',
      '203.0.113.9',
      '224.0.0.1', // multicast
      '240.0.0.1', // reserved
      '0.0.0.0',
      '255.255.255.255',
    ];
    for (const address of refused) expect(isPublicResearchAddress(address), address).toBe(false);
  });

  it('refuses IPv6 outright, public or not', () => {
    for (const address of ['::1', 'fe80::1', '2606:4700:4700::1111', 'fd00::1']) {
      expect(isPublicResearchAddress(address), address).toBe(false);
    }
  });
});

describe('which URLs research may request', () => {
  const firm = { firmWebsite: 'https://example.test/', links: [], maxPagesPerFirm: 4 };

  it('permits the firm’s own allow-listed pages, on the bare host and on www', () => {
    expect(permittedResearchUrl(firm, 'https://example.test/')).toBe('firm_site');
    expect(permittedResearchUrl(firm, 'https://example.test/about')).toBe('firm_site');
    expect(permittedResearchUrl(firm, 'https://www.example.test/services')).toBe('firm_site');
  });

  it('refuses a path nobody allow-listed, and a page past max_pages_per_firm', () => {
    expect(permittedResearchUrl(firm, 'https://example.test/blog/2026/hello')).toBe('blocked');
    // `/team` is the sixth path; four pages stops at `/careers`.
    expect(permittedResearchUrl(firm, 'https://example.test/team')).toBe('blocked');
    expect(permittedResearchUrl({ ...firm, maxPagesPerFirm: 8 }, 'https://example.test/team')).toBe('firm_site');
  });

  it('reads a careers or jobs page at the default settings, because two judgments need one', () => {
    // The order of `RESEARCH_PAGE_PATHS` is load-bearing against the default of four:
    // `hiring_maintenance` is the only evidence problem-evidence and timing have, and a
    // job posting is the only place it comes from. Careers fifth would mean two
    // judgments read `unknown` on every firm for a reason nobody could see.
    const urls = researchUrlsForFirm({
      firmWebsite: 'https://example.test/',
      links: [],
      maxPagesPerFirm: DEFAULT_RESEARCH_SETTINGS.maxPagesPerFirm,
    });
    expect(urls.some(url => /\/careers$|\/jobs$/u.test(url)), urls.join(' ')).toBe(true);
    expect(permittedResearchUrl(firm, 'https://example.test/careers')).toBe('firm_site');
  });

  it('refuses another host, plain http, credentials, a port and a bare private address', () => {
    expect(permittedResearchUrl(firm, 'https://other.test/')).toBe('blocked');
    expect(permittedResearchUrl(firm, 'http://example.test/')).toBe('blocked');
    expect(permittedResearchUrl(firm, 'https://user:pass@example.test/')).toBe('blocked');
    expect(permittedResearchUrl(firm, 'https://example.test:8443/')).toBe('blocked');
    expect(isPublicResearchUrl('https://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isPublicResearchUrl('https://127.0.0.1/')).toBe(false);
  });

  it('refuses every blocked host, and their subdomains', () => {
    for (const host of BLOCKED_RESEARCH_HOSTS) {
      expect(isPublicResearchUrl(`https://${host}/x`), host).toBe(false);
      expect(isPublicResearchUrl(`https://www.${host}/x`), host).toBe(false);
    }
    // The point of blocking the aggregators: the firm's own careers page is the only
    // job source there is.
    expect(isPublicResearchUrl('https://indeed.com/jobs?q=maintenance')).toBe(false);
    expect(permittedResearchUrl({ ...firm, maxPagesPerFirm: 8 }, 'https://example.test/jobs')).toBe('firm_site');
  });

  it('permits a link a person added, once, on any public host — and never by prefix', () => {
    const withLink = { ...firm, links: ['https://news.test/piece'] };
    expect(permittedResearchUrl(withLink, 'https://news.test/piece')).toBe('added_link');
    // Approving one page is not approving a directory.
    expect(permittedResearchUrl(withLink, 'https://news.test/piece/two')).toBe('blocked');
    expect(permittedResearchUrl(withLink, 'https://news.test/')).toBe('blocked');
    // And a person cannot add what the host rule refuses.
    expect(permittedResearchUrl({ ...firm, links: ['https://linkedin.com/company/x'] }, 'https://linkedin.com/company/x')).toBe('blocked');
  });

  it('builds the run’s URL list: the added links first, then the firm’s pages', () => {
    // A link is a person's decision about this firm; a fixed path is a guess about
    // every firm. If the budget covers one page and somebody has said which page
    // matters, that is the page.
    expect(researchUrlsForFirm({ firmWebsite: 'https://example.test/', links: ['https://news.test/piece'], maxPagesPerFirm: 2 })).toEqual([
      'https://news.test/piece',
      'https://example.test/',
    ]);
  });

  it('never returns more URLs than max_pages_per_firm, however many links there are', () => {
    // The number `worstCaseRunCents` prices, and therefore the number
    // `claimResearchClearance` authorized. Appending links on top of it meant a firm
    // with six links sent ten pages against a bound computed for four.
    const links = Array.from({ length: 6 }, (_, index) => `https://news.test/piece-${String(index)}`);
    for (const maxPagesPerFirm of [1, 2, 4, 8]) {
      const urls = researchUrlsForFirm({ firmWebsite: 'https://example.test/', links, maxPagesPerFirm });
      expect(urls.length, String(maxPagesPerFirm)).toBe(maxPagesPerFirm);
    }
  });

  it('refuses a URL with a query string, and drops a fragment', () => {
    // A fetched URL is stored — in `firm_links`, and as an evidence item's source
    // reference — and a query string is where a session token or an address lives.
    expect(isPublicResearchUrl('https://example.test/about?session=abc')).toBe(false);
    expect(isPublicResearchUrl('https://example.test/about#team')).toBe(false);
    expect(permittedResearchUrl(firm, 'https://example.test/about?utm_source=x')).toBe('blocked');
    expect(withoutFragment('https://example.test/about#team')).toBe('https://example.test/about');
    // A link somebody pasted with a fragment is normalised and then permitted.
    const withLink = { ...firm, links: ['https://news.test/piece'] };
    expect(permittedResearchUrl(withLink, withoutFragment('https://news.test/piece#top'))).toBe('added_link');
  });

  it('gives a firm with no website and no link nothing to read', () => {
    expect(researchUrlsForFirm({ firmWebsite: null, links: [], maxPagesPerFirm: 4 })).toEqual([]);
  });
});

describe('where a redirect may land', () => {
  const firm = { firmWebsite: 'https://example.test/', links: [], maxPagesPerFirm: 4 };
  const from = { url: 'https://example.test/', permission: 'firm_site' as const };

  it('lets a same-site hop keep the permission of the URL that led to it, whatever the path', () => {
    // The ordinary case, and the one the exact-path re-check used to lose: a homepage
    // that answers 301 to `/home`, `/en/` or `/index.html`. None of those is an
    // allow-listed path, and refusing them made such a firm yield nothing at all.
    for (const target of ['https://example.test/home', 'https://example.test/en/', 'https://example.test/index.html']) {
      expect(permittedRedirectTarget(firm, from, target), target).toBe('firm_site');
    }
    // www and the bare host are the same site in both directions.
    expect(permittedRedirectTarget(firm, from, 'https://www.example.test/home')).toBe('firm_site');
    expect(
      permittedRedirectTarget(firm, { url: 'https://www.example.test/', permission: 'firm_site' }, 'https://example.test/x'),
    ).toBe('firm_site');
  });

  it('still refuses a target that is not an https URL on a public, unblocked host', () => {
    for (const target of [
      'http://example.test/home',
      'https://example.test:8443/home',
      'https://user:pass@example.test/home',
    ]) {
      expect(permittedRedirectTarget(firm, from, target), target).toBe('blocked');
    }
  });

  it('refuses a cross-site hop unless the target is itself a link a person added', () => {
    // The firm's own server does not get to choose a second site for research to read.
    expect(permittedRedirectTarget(firm, from, 'https://other.test/')).toBe('blocked');
    expect(permittedRedirectTarget(firm, from, 'https://linkedin.com/company/x')).toBe('blocked');
    const withLink = { ...firm, links: ['https://news.test/piece'] };
    expect(permittedRedirectTarget(withLink, from, 'https://news.test/piece')).toBe('added_link');
    // An added link that redirects on its own site stays an added link, and one that
    // redirects to the firm's site gets the ordinary firm rule.
    const fromLink = { url: 'https://news.test/piece', permission: 'added_link' as const };
    expect(permittedRedirectTarget(withLink, fromLink, 'https://news.test/piece-moved')).toBe('added_link');
    expect(permittedRedirectTarget(withLink, fromLink, 'https://example.test/about')).toBe('firm_site');
    expect(permittedRedirectTarget(withLink, fromLink, 'https://example.test/blog/x')).toBe('blocked');
  });

  it('cannot turn a blocked URL into a permitted one', () => {
    expect(
      permittedRedirectTarget(firm, { url: 'https://other.test/', permission: 'blocked' }, 'https://other.test/x'),
    ).toBe('blocked');
  });
});

describe('the links a firm’s own homepage offers', () => {
  const firm = { firmWebsite: 'https://example.test/', links: [], maxPagesPerFirm: 4 };
  const found = (...hrefs: readonly string[]): { from: string; hrefs: readonly string[] } => ({
    from: 'https://example.test/',
    hrefs,
  });

  it('keeps the same-site pages that look like the pages research was going to ask for', () => {
    // Exactly the names real sites use, and exactly the ones the fixed path list misses.
    expect(
      discoverSameSiteUrls(firm, found('/about-us', '/our-team', '/contact-us', '/join-our-team', '/staff/')),
    ).toEqual([
      'https://example.test/about-us',
      'https://example.test/our-team',
      'https://example.test/contact-us',
      'https://example.test/join-our-team',
      'https://example.test/staff',
    ]);
  });

  it('drops a page that is not one of those, and the homepage itself', () => {
    expect(discoverSameSiteUrls(firm, found('/', '/blog/2026/hello', '/privacy', 'index.html'))).toEqual([]);
  });

  it('drops another host, a blocked host, and every scheme that is not https', () => {
    expect(
      discoverSameSiteUrls(
        firm,
        found(
          'https://other.test/about-us',
          'https://www.linkedin.com/company/x/about',
          'http://example.test/about-us',
          'mailto:hello@example.test',
          'tel:+15551234567',
          'javascript:void(0)',
          '#about-us',
          '',
        ),
      ),
    ).toEqual([]);
  });

  it('normalises a relative, query-bearing, fragment-bearing or www href to one URL', () => {
    expect(
      discoverSameSiteUrls(firm, found(
        'about-us',
        '/about-us?utm_source=nav',
        '/about-us#top',
        'https://www.example.test/about-us/',
        '//example.test/about-us',
      )),
    ).toEqual(['https://example.test/about-us', 'https://www.example.test/about-us']);
  });

  it('does not offer a page this run is already fetching from the fixed list', () => {
    // At four pages the run asks for `/`, `/about`, `/services` and `/careers`, so a
    // link to any of them is a second fetch of the same bytes.
    expect(discoverSameSiteUrls(firm, found('/about', '/services', '/careers'))).toEqual([]);
    // At two it is not reading that far down, so `/careers` is a page it would lose.
    expect(discoverSameSiteUrls({ ...firm, maxPagesPerFirm: 2 }, found('/careers'))).toEqual([
      'https://example.test/careers',
    ]);
  });

  it('bounds the candidates before the filter, so a page of a thousand links costs the same', () => {
    const hrefs = [
      ...Array.from({ length: MAX_DISCOVERED_CANDIDATES }, (_, index) => `/section-${String(index)}`),
      '/about-us',
    ];
    // The twenty-first same-site link is never looked at, whatever it says.
    expect(discoverSameSiteUrls(firm, found(...hrefs))).toEqual([]);
    expect(discoverSameSiteUrls(firm, found('/about-us', ...hrefs))).toEqual(['https://example.test/about-us']);
  });

  it('gives a firm with no website nothing to discover', () => {
    expect(discoverSameSiteUrls({ ...firm, firmWebsite: null }, found('/about-us'))).toEqual([]);
  });

  it('permits a discovered URL as the firm’s own page, and only the exact ones discovered', () => {
    const discovered = ['https://example.test/about-us'];
    expect(permittedResearchUrl({ ...firm, discovered }, 'https://example.test/about-us')).toBe('firm_site');
    // Not by prefix: a discovered page is not a discovered directory.
    expect(permittedResearchUrl({ ...firm, discovered }, 'https://example.test/about-us/history')).toBe('blocked');
    expect(permittedResearchUrl(firm, 'https://example.test/about-us')).toBe('blocked');
  });
});

describe('scanning a page for its anchors', () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
  const html = (source: string): readonly string[] => anchorHrefs(bytes(source), 'text/html; charset=utf-8');

  it('reads href values in document order, quoted three ways', () => {
    expect(html('<a href="/about-us">About</a> <a href=\'/our-team\'>Team</a> <a href=/contact-us>Contact</a>')).toEqual([
      '/about-us',
      '/our-team',
      '/contact-us',
    ]);
  });

  it('reads an href that is not the first attribute, and ignores an anchor without one', () => {
    expect(html('<a class="nav" data-x="1" href="/careers" rel="nofollow">Jobs</a><a name="top"></a>')).toEqual([
      '/careers',
    ]);
  });

  it('decodes the entities an href in real markup contains', () => {
    expect(html('<a href="/about-us?a=1&amp;b=2">x</a>')).toEqual(['/about-us?a=1&b=2']);
  });

  it('does not decide anything: mailto, javascript and broken values come back as written', () => {
    // Every decision about these is `discoverSameSiteUrls`, which is pure.
    expect(html('<a href="mailto:x@y.test">m</a><a href="javascript:void(0)">j</a><a href="  ">b</a>')).toEqual([
      'mailto:x@y.test',
      'javascript:void(0)',
    ]);
  });

  it('is not a link scan of plain text, an oversized body, or an `abbr` tag', () => {
    expect(anchorHrefs(bytes('<a href="/about-us">x</a>'), 'text/plain')).toEqual([]);
    expect(anchorHrefs(new Uint8Array(1_000_001), 'text/html')).toEqual([]);
    expect(html('<abbr href="/about-us">x</abbr>')).toEqual([]);
  });

  it('stops at its own bound', () => {
    const source = Array.from({ length: MAX_ANCHOR_HREFS + 5 }, (_, index) => `<a href="/p${String(index)}">x</a>`).join('');
    expect(html(source).length).toBe(MAX_ANCHOR_HREFS);
  });
});

describe('turning page bytes into bounded blocks', () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

  it('refuses a body over a megabyte whole, and says it was truncated', () => {
    const parsed = parsePageText(bytes('x'.repeat(1_000_001)), 'text/html');
    expect(parsed.blocks).toEqual([]);
    expect(parsed.truncated).toBe(true);
  });

  it('reads nothing from a media type that is not html or plain text', () => {
    expect(parsePageText(bytes('<p>hello</p>'), 'application/pdf').blocks).toEqual([]);
  });

  it('drops a testimonial rather than quoting somebody else as the firm', () => {
    const parsed = parsePageText(bytes('<p>We manage property.</p><blockquote>They are great.</blockquote>'), 'text/html');
    expect(parsed.blocks.map(block => block.text)).toEqual(['We manage property.']);
  });

  it('bounds the block count and the character count, dropping whole blocks', () => {
    const many = blocksFromPlainText(Array.from({ length: 300 }, (_, index) => `line ${String(index)}`).join('\n'));
    expect(many.blocks.length).toBe(MAX_BLOCKS);
    expect(many.truncated).toBe(true);

    const long = blocksFromPlainText([`${'a'.repeat(MAX_TEXT_CHARACTERS - 10)}`, 'b'.repeat(200)].join('\n'));
    expect(long.blocks.length).toBe(1);
    expect(long.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARACTERS);
    expect(long.truncated).toBe(true);
  });

  it('gives every block a stable id', () => {
    const parsed = blocksFromPlainText('one\ntwo\nthree');
    expect(parsed.blocks.map(block => block.id)).toEqual(['b1', 'b2', 'b3']);
  });
});

describe('admitting what a provider selected', () => {
  const sources = [
    {
      sourceReference: 'https://example.test/',
      firstParty: true,
      blocks: [
        { id: 'b1', text: 'We manage residential property for owners.' },
        { id: 'b2', text: 'Our maintenance team handles every work order.' },
        { id: 'b3', text: '' },
        { id: 'b4', text: 'Dana Placeholder, Maintenance Coordinator — call 555-0100.' },
      ],
    },
  ];

  it('looks the quote up locally, so a provider cannot supply one', () => {
    const { facts } = validateFactSelections(
      [{ key: 'target_fit', sourceReference: 'https://example.test/', blockId: 'b1' }],
      sources,
    );
    expect(facts).toEqual([
      {
        key: 'target_fit',
        sourceReference: 'https://example.test/',
        blockId: 'b1',
        quote: 'We manage residential property for owners.',
        firstParty: true,
      },
    ]);
  });

  it('stores no quote for a key whose block names a person or a number', () => {
    // The block is still checked — an unknown or overlong one is refused — and then
    // not carried, because a contact's deletion does not reach a firm's rows and this
    // sentence would outlive the person in it.
    const { facts } = validateFactSelections(
      [
        { key: 'named_role', sourceReference: 'https://example.test/', blockId: 'b4' },
        { key: 'phone_listed', sourceReference: 'https://example.test/', blockId: 'b4' },
        { key: 'role', sourceReference: 'https://example.test/', blockId: 'b4' },
      ],
      sources,
    );
    expect(facts.map(fact => fact.key)).toEqual(['named_role', 'phone_listed', 'role']);
    expect(facts.map(fact => fact.quote)).toEqual([null, null, null]);
    // And the block is still named, so the judgment can cite it.
    expect(facts.every(fact => fact.blockId === 'b4')).toBe(true);
    expect(JSON.stringify(facts)).not.toContain('Dana Placeholder');
    expect(JSON.stringify(facts)).not.toContain('555-0100');
    expect(PERSON_FACT_KEYS).toEqual(['named_role', 'phone_listed', 'role']);
  });

  it('carries the source’s first-party flag onto every fact', () => {
    const thirdParty = [{ ...sources[0]!, sourceReference: 'https://news.test/piece', firstParty: false }];
    const { facts } = validateFactSelections(
      [{ key: 'target_fit', sourceReference: 'https://news.test/piece', blockId: 'b1' }],
      thirdParty,
    );
    expect(facts[0]?.firstParty).toBe(false);
  });

  it('refuses an unknown key, an unknown source, an unknown block and a repeat', () => {
    const { facts, refused } = validateFactSelections(
      [
        { key: 'budget', sourceReference: 'https://example.test/', blockId: 'b1' },
        { key: 'target_fit', sourceReference: 'https://elsewhere.test/', blockId: 'b1' },
        { key: 'target_fit', sourceReference: 'https://example.test/', blockId: 'b9' },
        { key: 'target_fit', sourceReference: 'https://example.test/', blockId: 'b3' },
        { key: 'target_fit', sourceReference: 'https://example.test/', blockId: 'b1' },
        { key: 'target_fit', sourceReference: 'https://example.test/', blockId: 'b1' },
      ],
      sources,
    );
    expect(facts.length).toBe(1);
    expect(refused.map(entry => entry.refusal)).toEqual([
      'unknown_key',
      'unknown_source',
      'unknown_block',
      'unknown_block',
      'duplicate_selection',
    ]);
  });

  it('refuses a block too long to be a quote rather than cutting it', () => {
    const { facts, refused } = validateFactSelections(
      [{ key: 'ownership', sourceReference: 'https://long.test/', blockId: 'b1' }],
      [{ sourceReference: 'https://long.test/', firstParty: true, blocks: [{ id: 'b1', text: 'a'.repeat(501) }] }],
    );
    expect(facts).toEqual([]);
    expect(refused[0]?.refusal).toBe('quote_too_long');
  });

  it('has no key that could hold a name, an address, a number or an e-mail', () => {
    const contactish = FACT_KEYS.filter(key => /email|address|phone_number|full_name|person_name/u.test(key));
    expect(contactish, 'a fact key would carry contact data').toEqual([]);
  });

  it('builds a research.firm job key in SQL the same way the helper does', () => {
    // `finaliseAbandonedRuns` joins a run to its job by this key, in SQL, to leave a run
    // whose lease is still live alone. The prefix is shared rather than repeated, and
    // this is the comparison that keeps the SQL and the helper the same string.
    const firmId = '00000000-0000-4000-8000-00000000000f';
    expect(jobIdempotencyKey.researchFirm(firmId, 7)).toBe(`${RESEARCH_FIRM_JOB_KEY_PREFIX}${firmId}:7`);
  });
});
