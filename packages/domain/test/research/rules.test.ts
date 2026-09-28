import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_RESEARCH_HOSTS,
  isPublicResearchAddress,
  isPublicResearchUrl,
  permittedResearchUrl,
  researchUrlsForFirm,
} from '../../research/sourcePolicy.ts';
import { blocksFromPlainText, parsePageText, MAX_BLOCKS, MAX_TEXT_CHARACTERS } from '../../research/pageText.ts';
import { FACT_KEYS, validateFactSelections } from '../../research/facts.ts';

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
    // `/careers` is the sixth path; four pages stops at `/contact`.
    expect(permittedResearchUrl(firm, 'https://example.test/careers')).toBe('blocked');
    expect(permittedResearchUrl({ ...firm, maxPagesPerFirm: 8 }, 'https://example.test/careers')).toBe('firm_site');
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

  it('builds the run’s URL list: the firm’s pages first, then the links', () => {
    expect(researchUrlsForFirm({ firmWebsite: 'https://example.test/', links: ['https://news.test/piece'], maxPagesPerFirm: 2 })).toEqual([
      'https://example.test/',
      'https://example.test/about',
      'https://news.test/piece',
    ]);
  });

  it('gives a firm with no website and no link nothing to read', () => {
    expect(researchUrlsForFirm({ firmWebsite: null, links: [], maxPagesPerFirm: 4 })).toEqual([]);
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
      blocks: [
        { id: 'b1', text: 'We manage residential property for owners.' },
        { id: 'b2', text: 'Our maintenance team handles every work order.' },
        { id: 'b3', text: '' },
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
      },
    ]);
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
      [{ sourceReference: 'https://long.test/', blocks: [{ id: 'b1', text: 'a'.repeat(501) }] }],
    );
    expect(facts).toEqual([]);
    expect(refused[0]?.refusal).toBe('quote_too_long');
  });

  it('has no key that could hold a name, an address, a number or an e-mail', () => {
    const contactish = FACT_KEYS.filter(key => /email|address|phone_number|full_name|person_name/u.test(key));
    expect(contactish, 'a fact key would carry contact data').toEqual([]);
  });
});
