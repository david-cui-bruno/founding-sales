import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_FILL_CONFIDENCE,
  COMPANY_FACT_KEYS,
  COORDINATE_ZONE_STATES,
  FILLABLE_CANONICAL_FIELDS,
  RESEARCH_FIRM_ZONE_SOURCES,
  businessEmailCandidates,
  decideSuggestionEffect,
  duplicatePairKey,
  findBusinessEmail,
  isPublicResearchAddress,
  isUsableCoordinate,
  mailtoTargets,
  mediaTypeOf,
  parsePageText,
  permittedFirmSources,
  researchSourcePolicy,
  targetFitVerdict,
  validateFactSelections,
  websiteHost,
  websiteRootOf,
  withheldEmails,
  zoneForCoordinate,
  type FactSelection,
} from '../../research/index.ts';
import { decideEligibilityUnderPolicy, type PublishedRoutePolicy } from '../../research/routeEligibility.ts';
import { MULTI_ZONE_STATES } from '../../src/rules/statePosture.ts';
import { resolveFirmZone } from '../../src/rules/statePosture.ts';
import { RECORDED_PAGES } from '../../research/testing/fixtures.ts';

/**
 * The pure research rules, and the two structural promises the package makes.
 *
 * Nothing here touches the database, and — as the first describe block proves —
 * nothing in the package it tests can touch a network.
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

describe('the research package cannot reach a network (7.4, and the brief)', () => {
  // A module that can open a socket can call a provider, and "providers sit behind
  // interfaces with recorded fixtures" would be a convention rather than a fact.
  const FORBIDDEN = [
    'node:http',
    'node:https',
    'node:net',
    'node:dns',
    'node:tls',
    'undici',
    '@aws-sdk',
    'node-fetch',
  ];

  it('imports no transport module anywhere under research/', () => {
    const offenders: string[] = [];
    for (const file of researchSourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/gu)) {
        const specifier = match[1] ?? '';
        // `node:net` is permitted in exactly one place: `isIP`, which is how the
        // address allowlist recognises a literal address in a URL. It opens nothing.
        if (specifier === 'node:net' && file.endsWith('sourcePolicy.ts')) continue;
        if (FORBIDDEN.some(forbidden => specifier === forbidden || specifier.startsWith(`${forbidden}/`))) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders, 'a research module imported a transport').toEqual([]);
  });

  it('never names fetch, XMLHttpRequest or a bare http URL', () => {
    const offenders: string[] = [];
    for (const file of researchSourceFiles()) {
      const source = readFileSync(file, 'utf8');
      // Comments and documentation mention the words; code that *calls* them looks
      // like `fetch(`, and that is what this refuses.
      if (/(?<![A-Za-z.])fetch\s*\(/u.test(source)) offenders.push(`${file}: fetch(`);
      if (/XMLHttpRequest/u.test(source)) offenders.push(`${file}: XMLHttpRequest`);
    }
    expect(offenders, 'a research module called out to the network').toEqual([]);
  });

  it('has exactly one provider implementation directory, and it is the fixtures', () => {
    const implementations = researchSourceFiles().filter(file => /testing\//u.test(file));
    expect(implementations.map(file => file.slice(RESEARCH_DIRECTORY.length))).toEqual(['testing/fixtures.ts']);
  });
});

describe('the source policy (ported from companySourcePolicy)', () => {
  it('admits an https URL on a public host', () => {
    expect(researchSourcePolicy('https://northgate-residential.example.test/')).toBe('candidate');
    expect(researchSourcePolicy('https://northgate-residential.example.test:443/team')).toBe('candidate');
  });

  it('refuses everything that is not one', () => {
    for (const url of [
      'http://northgate-residential.example.test/',
      'https://user:secret@northgate-residential.example.test/',
      'https://northgate-residential.example.test:8443/',
      'https://localhost/',
      'https://intranet.local/',
      'https://nowhere/',
      'https://10.0.0.5/',
      'https://169.254.169.254/latest/meta-data/',
      'https://127.0.0.1/',
      'https://192.168.1.1/',
      'not a url at all',
    ]) {
      expect(researchSourcePolicy(url), url).toBe('blocked');
    }
  });

  it('blocks LinkedIn, which research has never read', () => {
    expect(researchSourcePolicy('https://www.linkedin.com/in/someone')).toBe('blocked');
  });

  it('refuses every private and reserved IPv4 range, and all of IPv6', () => {
    for (const address of [
      '10.1.2.3',
      '127.0.0.1',
      '100.64.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.0.2.1',
      '192.168.0.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '::1',
      '2001:db8::1',
      '0.0.0.0',
    ]) {
      expect(isPublicResearchAddress(address), address).toBe(false);
    }
    expect(isPublicResearchAddress('93.184.216.34')).toBe(true);
  });

  it('takes a firm domain only from a website that could be its own', () => {
    expect(websiteRootOf('https://www.Northgate-Residential.example.test/about')).toEqual({
      domain: 'northgate-residential.example.test',
      sourceUrl: 'https://www.northgate-residential.example.test/',
    });
    // A shared platform is somebody else's site, whatever the listing says.
    expect(websiteRootOf('https://facebook.com/northgate')).toBeNull();
    expect(websiteRootOf('https://pages.yelp.com/northgate')).toBeNull();
    // A listing that published `http://` yields the https root: the fetch is
    // https-only, so the scheme is normalised rather than the firm discarded. Ported
    // behaviour, from `websiteRoot` in placesDiscoveryProvider.
    expect(websiteRootOf('http://northgate-residential.example.test/')).toEqual({
      domain: 'northgate-residential.example.test',
      sourceUrl: 'https://northgate-residential.example.test/',
    });
    expect(websiteRootOf('nonsense')).toBeNull();
    expect(websiteRootOf('https://10.0.0.5/')).toBeNull();
  });

  it('permits exactly the discovery paths, on both hosts, bounded by maxPages', () => {
    expect(permittedFirmSources('example.test', 2)).toEqual([
      'https://example.test/',
      'https://example.test/services',
      'https://www.example.test/',
      'https://www.example.test/services',
    ]);
    expect(permittedFirmSources('example.test', 99)).toHaveLength(8);
    expect(permittedFirmSources('example.test', 0)).toHaveLength(2);
  });
});

describe('page text (ported from companyPageText and htmlText)', () => {
  const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

  it('refuses an oversized body whole rather than parsing a truncated tag', () => {
    const huge = bytes(`<p>${'a'.repeat(1_000_001)}</p>`);
    const parsed = parsePageText(huge, 'text/html');
    expect(parsed.blocks).toEqual([]);
    expect(parsed.truncated).toBe(true);
  });

  it('parses nothing from a media type it does not understand', () => {
    expect(parsePageText(bytes('%PDF-1.7'), 'application/pdf').blocks).toEqual([]);
    expect(mediaTypeOf('text/html; charset=utf-8')).toBe('text/html');
  });

  it('drops a testimonial, a hidden element and a script, and keeps whole blocks', () => {
    const parsed = parsePageText(bytes(RECORDED_PAGES['https://northgate-residential.example.test/'] ?? ''), 'text/html');
    const texts = parsed.blocks.map(block => block.text);
    expect(texts).toContain('We are a regional residential property management company.');
    expect(texts).toContain('Operating footprint: El Paso and the surrounding county.');
    expect(texts.some(text => text.includes('Best managers we have ever used'))).toBe(false);
    expect(texts.some(text => text.includes('Hidden marketing copy'))).toBe(false);
  });

  it('stops at an unterminated tag instead of guessing', () => {
    const parsed = parsePageText(bytes('<p>published</p><p>after an unclosed tag <div class="'), 'text/html');
    expect(parsed.blocks.map(block => block.text)).toEqual(['published', 'after an unclosed tag']);
  });

  it('reads a mailto link whose visible label is not an address', () => {
    expect(
      mailtoTargets('<a href="mailto:office@example.test?subject=Hello">contact the team</a>'),
    ).toEqual(['office@example.test']);
    // Only a complete, quoted href. An unquoted or truncated attribute is not mined.
    expect(mailtoTargets('<a href=mailto:office@example.test>x</a>')).toEqual([]);
  });

  it('gives every block a stable id, so a fact can name one', () => {
    const parsed = parsePageText(bytes('<p>one</p><p>two</p>'), 'text/html');
    expect(parsed.blocks).toEqual([
      { id: 'b1', text: 'one' },
      { id: 'b2', text: 'two' },
    ]);
  });
});

describe('the business email (ported from businessEmailDiscovery)', () => {
  const page = (text: string) => [{ sourceReference: 'https://example.test/', text }];

  it('prefers a role mailbox over a personal name', () => {
    const found = findBusinessEmail({
      domain: 'example.test',
      pages: page('dana.example@example.test\ninfo@example.test'),
    });
    expect(found.finding).toMatchObject({ email: 'info@example.test', selection: 'role_mailbox' });
  });

  it('refuses free mail, off-domain addresses and withheld contacts, and counts each', () => {
    const found = findBusinessEmail({
      domain: 'example.test',
      pages: page(
        [
          'someone@gmail.com',
          'sales@partner.test',
          'Tenant emergency line: emergency@example.test',
          'office@example.test',
        ].join('\n'),
      ),
    });
    expect(found.finding).toMatchObject({ email: 'office@example.test' });
    expect(found.refused).toMatchObject({ free_mail: 1, off_domain: 1, withheld_contact: 1 });
  });

  it('never guesses an address from a pattern', () => {
    const found = findBusinessEmail({ domain: 'example.test', pages: page('Call us on the number above.') });
    expect(found.finding).toBeNull();
  });

  it('accepts a subdomain of the firm but not a domain that merely ends in it', () => {
    expect(
      findBusinessEmail({ domain: 'example.test', pages: page('info@mail.example.test') }).finding,
    ).toMatchObject({ email: 'info@mail.example.test' });
    expect(
      findBusinessEmail({ domain: 'example.test', pages: page('info@notexample.test') }).finding,
    ).toBeNull();
  });

  it('withholds a tenant or emergency address found on any page', () => {
    const pages = [
      { sourceReference: 'a', text: 'Business email: office@example.test' },
      { sourceReference: 'b', text: 'After hours: office@example.test' },
    ];
    expect(withheldEmails(pages)).toEqual(['office@example.test']);
    expect(findBusinessEmail({ domain: 'example.test', pages }).finding).toBeNull();
  });

  it('strips a trailing sentence mark and lower-cases', () => {
    expect(businessEmailCandidates(page('Write to Info@Example.test.')).map(c => c.email)).toEqual([
      'info@example.test',
    ]);
  });

  it('refuses a firm with no parsable domain', () => {
    expect(findBusinessEmail({ domain: null, pages: page('info@example.test') }).refused.unparsable).toBe(1);
  });
});

describe('fact provenance (ported from companyFactExtraction)', () => {
  const sources = [
    {
      sourceReference: 'https://example.test/',
      blocks: [
        { id: 'b1', text: 'We manage residential buildings on behalf of their owners.' },
        { id: 'b2', text: 'Operating footprint: two counties, but not the third.' },
      ],
    },
  ];

  it('admits a selection and looks the quote up from the block', () => {
    const selections: FactSelection[] = [
      { key: 'target_fit', sourceReference: 'https://example.test/', blockId: 'b1' },
    ];
    const validated = validateFactSelections(selections, sources);
    expect(validated.facts).toEqual([
      {
        key: 'target_fit',
        sourceReference: 'https://example.test/',
        blockId: 'b1',
        quote: 'We manage residential buildings on behalf of their owners.',
      },
    ]);
    expect(validated.refused).toEqual([]);
  });

  it('refuses an unknown key, an unknown source, an unknown block and a repeat', () => {
    const validated = validateFactSelections(
      [
        { key: 'prospect_pain', sourceReference: 'https://example.test/', blockId: 'b1' },
        { key: 'role', sourceReference: 'https://elsewhere.test/', blockId: 'b1' },
        { key: 'role', sourceReference: 'https://example.test/', blockId: 'b99' },
        { key: 'target_fit', sourceReference: 'https://example.test/', blockId: 'b1' },
        { key: 'target_fit', sourceReference: 'https://example.test/', blockId: 'b1' },
      ],
      sources,
    );
    expect(validated.facts).toHaveLength(1);
    expect(validated.refused.map(entry => entry.refusal)).toEqual([
      'unknown_key',
      'unknown_source',
      'unknown_block',
      'duplicate_selection',
    ]);
  });

  it('keeps the whole block, so a qualifier or a negation cannot be dropped', () => {
    const validated = validateFactSelections(
      [{ key: 'operating_footprint', sourceReference: 'https://example.test/', blockId: 'b2' }],
      sources,
    );
    expect(validated.facts[0]?.quote).toBe('Operating footprint: two counties, but not the third.');
  });

  it('lets not_target win over target_fit', () => {
    const facts = validateFactSelections(
      [
        { key: 'target_fit', sourceReference: 'https://example.test/', blockId: 'b1' },
        { key: 'not_target', sourceReference: 'https://example.test/', blockId: 'b2' },
      ],
      sources,
    ).facts;
    expect(targetFitVerdict(facts)).toBe('no');
    expect(targetFitVerdict([])).toBeNull();
  });

  it('has no contact fact in its closed set', () => {
    for (const key of COMPANY_FACT_KEYS) {
      expect(key).not.toMatch(/email|phone|address|mobile|contact_name/u);
    }
  });
});

describe('the coordinate zone source (9.2, and the coordinator note)', () => {
  it('resolves the thirteen states G3a had to refuse, in their interiors', () => {
    // Tennessee is the coordinator's example: the postal table answers nothing there.
    expect(zoneForCoordinate('TN', { latitude: 36.1627, longitude: -86.7816 })).toBe('America/Chicago');
    expect(zoneForCoordinate('TN', { latitude: 35.9606, longitude: -83.9207 })).toBe('America/New_York');
    expect(zoneForCoordinate('MI', { latitude: 42.3314, longitude: -83.0458 })).toBe('America/Detroit');
    expect(zoneForCoordinate('MI', { latitude: 45.9, longitude: -88.07 })).toBe('America/Menominee');
    expect(zoneForCoordinate('KY', { latitude: 38.2527, longitude: -85.7585 })).toBe('America/Kentucky/Louisville');
    expect(zoneForCoordinate('KY', { latitude: 36.9685, longitude: -86.4808 })).toBe('America/Chicago');
    expect(zoneForCoordinate('ID', { latitude: 47.6588, longitude: -117.426 })).toBe('America/Los_Angeles');
    expect(zoneForCoordinate('ID', { latitude: 43.615, longitude: -116.2023 })).toBe('America/Boise');
    expect(zoneForCoordinate('ND', { latitude: 46.8772, longitude: -96.7898 })).toBe('America/Chicago');
    expect(zoneForCoordinate('NE', { latitude: 41.87, longitude: -103.66 })).toBe('America/Denver');
  });

  it('keeps answering for the two states the postal table covers', () => {
    expect(zoneForCoordinate('TX', { latitude: 31.7587, longitude: -106.4869 })).toBe('America/Denver');
    expect(zoneForCoordinate('TX', { latitude: 29.7604, longitude: -95.3698 })).toBe('America/Chicago');
    expect(zoneForCoordinate('FL', { latitude: 30.4213, longitude: -87.2169 })).toBe('America/Chicago');
    expect(zoneForCoordinate('FL', { latitude: 25.7617, longitude: -80.1918 })).toBe('America/New_York');
  });

  it('refuses the seam rather than guessing', () => {
    // Chattanooga sits inside Tennessee's margin.
    expect(zoneForCoordinate('TN', { latitude: 35.0456, longitude: -85.3097 })).toBeNull();
    // Hudspeth County, Texas, reaches east of the meridian, which is why the margin
    // is wide there.
    expect(zoneForCoordinate('TX', { latitude: 31.0, longitude: -104.8 })).toBeNull();
  });

  it('refuses an enclave rather than claim it, and refuses Arizona entirely', () => {
    // Indiana's western counties, Nevada's one Mountain town and Oregon's Malheur
    // County are the three refusing sides.
    expect(zoneForCoordinate('IN', { latitude: 39.7684, longitude: -86.158 })).toBe('America/Indiana/Indianapolis');
    expect(zoneForCoordinate('IN', { latitude: 37.9716, longitude: -87.5711 })).toBeNull();
    expect(zoneForCoordinate('NV', { latitude: 36.1699, longitude: -115.1398 })).toBe('America/Los_Angeles');
    expect(zoneForCoordinate('NV', { latitude: 40.7391, longitude: -114.0353 })).toBeNull();
    expect(zoneForCoordinate('OR', { latitude: 45.5152, longitude: -122.6784 })).toBe('America/Los_Angeles');
    expect(zoneForCoordinate('OR', { latitude: 44.0266, longitude: -116.963 })).toBeNull();
    expect(COORDINATE_ZONE_STATES).not.toContain('AZ');
    expect(zoneForCoordinate('AZ', { latitude: 33.4484, longitude: -112.074 })).toBeNull();
  });

  it('says nothing about a single-zone state, leaving the state default to answer', () => {
    expect(zoneForCoordinate('RI', { latitude: 41.824, longitude: -71.4128 })).toBeNull();
    expect(zoneForCoordinate('CA', { latitude: 34.0522, longitude: -118.2437 })).toBeNull();
  });

  it('only ever answers with a zone the state is known to observe', () => {
    for (const state of COORDINATE_ZONE_STATES) {
      const observed = MULTI_ZONE_STATES[state as keyof typeof MULTI_ZONE_STATES];
      expect(observed, state).toBeDefined();
      for (const longitude of [-180, -120, -100, -85, -60, 0, 180]) {
        for (const latitude of [20, 35, 45, 55, 65]) {
          const zone = zoneForCoordinate(state, { latitude, longitude });
          if (zone === null) continue;
          expect(observed, `${state} ${String(latitude)},${String(longitude)}`).toContain(zone);
        }
      }
    }
  });

  it('refuses an unusable coordinate, including a provider zero', () => {
    expect(isUsableCoordinate({ latitude: 0, longitude: 0 })).toBe(false);
    expect(isUsableCoordinate({ latitude: 91, longitude: 0 })).toBe(false);
    expect(isUsableCoordinate({ latitude: Number.NaN, longitude: 1 })).toBe(false);
    expect(zoneForCoordinate('TN', { latitude: 0, longitude: 0 })).toBeNull();
  });

  it('is the primary rule, with the postal table behind it', () => {
    expect(RESEARCH_FIRM_ZONE_SOURCES.map(source => source.name)).toEqual(['coordinates', 'postal']);
    // A Texas firm whose coordinate and whose ZIP prefix disagree resolves from the
    // coordinate, because the coordinate is the better source.
    const resolved = resolveFirmZone(
      { state: 'TX', postalCode: '77002', latitude: 31.7587, longitude: -106.4869 },
      RESEARCH_FIRM_ZONE_SOURCES,
    );
    expect(resolved).toMatchObject({ kind: 'resolved', zone: 'America/Denver', source: 'coordinates' });
    // With no coordinate, the postal table still answers.
    expect(resolveFirmZone({ state: 'TX', postalCode: '79901' }, RESEARCH_FIRM_ZONE_SOURCES)).toMatchObject({
      source: 'postal',
      zone: 'America/Denver',
    });
    // With neither, a multi-zone state fails closed exactly as before.
    expect(resolveFirmZone({ state: 'TN' }, RESEARCH_FIRM_ZONE_SOURCES)).toMatchObject({
      kind: 'unresolved',
      reason: 'state_spans_zones',
    });
  });
});

describe('the eligibility decision under a published policy (7.4)', () => {
  const policy = (overrides: Partial<PublishedRoutePolicy> = {}): PublishedRoutePolicy => ({
    id: '11111111-1111-4111-8111-111111111111',
    version: 'route-policy.1',
    minimumAssociationConfidence: 0.8,
    requireTechnicalValidation: true,
    trustedSources: ['salesperson', 'reply'],
    note: null,
    effectiveFrom: '2026-09-20T00:00:00.000Z',
    ...overrides,
  });

  it('leaves a research provider route a candidate until it is validated', () => {
    expect(
      decideEligibilityUnderPolicy(
        { source: 'research_provider', technicalValidation: 'unknown', associationConfidence: 0.95 },
        policy(),
      ),
    ).toEqual({ eligibility: 'candidate', policyVersion: null });
  });

  it('promotes a validated route at or above the threshold, and records the version', () => {
    expect(
      decideEligibilityUnderPolicy(
        { source: 'research_provider', technicalValidation: 'passed', associationConfidence: 0.8 },
        policy(),
      ),
    ).toEqual({ eligibility: 'usable', policyVersion: 'route-policy.1' });
  });

  it('keeps a validated route below the threshold a candidate', () => {
    expect(
      decideEligibilityUnderPolicy(
        { source: 'research_provider', technicalValidation: 'passed', associationConfidence: 0.79 },
        policy(),
      ),
    ).toMatchObject({ eligibility: 'candidate' });
  });

  it('makes a failed validation invalid rather than weak', () => {
    expect(
      decideEligibilityUnderPolicy(
        { source: 'salesperson', technicalValidation: 'failed', associationConfidence: 1 },
        policy(),
      ),
    ).toEqual({ eligibility: 'invalid', policyVersion: null });
  });

  it('a policy that waives validation still needs confidence or a trusted source', () => {
    const waived = policy({ requireTechnicalValidation: false, version: 'route-policy.2' });
    expect(
      decideEligibilityUnderPolicy(
        { source: 'research_provider', technicalValidation: 'unknown', associationConfidence: null },
        waived,
      ),
    ).toMatchObject({ eligibility: 'candidate' });
    expect(
      decideEligibilityUnderPolicy(
        { source: 'research_provider', technicalValidation: 'unknown', associationConfidence: 0.9 },
        waived,
      ),
    ).toEqual({ eligibility: 'usable', policyVersion: 'route-policy.2' });
    expect(
      decideEligibilityUnderPolicy(
        { source: 'salesperson', technicalValidation: 'failed', associationConfidence: 1 },
        waived,
      ),
    ).toMatchObject({ eligibility: 'invalid' });
  });
});

describe('what may fill a canonical field without a person (7.4)', () => {
  it('fills an empty fillable field from a high-confidence fact', () => {
    expect(
      decideSuggestionEffect({
        kind: 'canonical_field',
        fieldKey: 'locality',
        confidence: AUTOMATIC_FILL_CONFIDENCE,
        existingValue: null,
      }),
    ).toEqual({ effect: 'fill', field: 'locality' });
  });

  it('never overwrites a value that is already there', () => {
    expect(
      decideSuggestionEffect({
        kind: 'canonical_field',
        fieldKey: 'locality',
        confidence: 1,
        existingValue: 'Providence',
      }),
    ).toEqual({ effect: 'propose', reason: 'value_present' });
  });

  it('proposes rather than fills below the threshold', () => {
    expect(
      decideSuggestionEffect({
        kind: 'canonical_field',
        fieldKey: 'locality',
        confidence: AUTOMATIC_FILL_CONFIDENCE - 0.01,
        existingValue: null,
      }),
    ).toEqual({ effect: 'propose', reason: 'confidence_below_threshold' });
  });

  it('proposes every other kind, whatever the confidence', () => {
    for (const kind of ['contact', 'phone_route', 'email_route', 'duplicate_firm'] as const) {
      expect(
        decideSuggestionEffect({ kind, fieldKey: undefined, confidence: 1, existingValue: null }),
      ).toEqual({ effect: 'propose', reason: 'not_a_fact' });
    }
  });

  it('refuses to fill a field outside the closed fillable set', () => {
    expect(
      decideSuggestionEffect({
        kind: 'canonical_field',
        fieldKey: 'name',
        confidence: 1,
        existingValue: null,
      }),
    ).toEqual({ effect: 'propose', reason: 'not_a_fillable_field' });
    // The set contains nothing a contact route, a note or a message could occupy.
    for (const field of FILLABLE_CANONICAL_FIELDS) {
      expect(field).not.toMatch(/email|phone|note|body|contact|assign/u);
    }
  });

  it('is stricter than the threshold a route needs, on purpose', () => {
    expect(AUTOMATIC_FILL_CONFIDENCE).toBeGreaterThan(0.8);
  });
});

describe('duplicate pair identity', () => {
  it('gives one pair one key whichever side asks', () => {
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    expect(duplicatePairKey(a, b)).toBe(duplicatePairKey(b, a));
  });

  it('reads a host from a website and nothing from nonsense', () => {
    expect(websiteHost('https://www.Example.test/about')).toBe('example.test');
    expect(websiteHost('not a url')).toBeNull();
    expect(websiteHost(null)).toBeNull();
  });
});
describe('the container images ship this package (the PR 135 lesson)', () => {
  // `Dockerfile.*` and `Dockerfile.*.dockerignore` are allow-lists of
  // directories, so a package a process imports but nobody listed is simply
  // absent from the image and the container dies with ERR_MODULE_NOT_FOUND —
  // which is how G3b's `packages/domain/crm` was lost. Docker is not available
  // on a development machine, so this is the cheap check that runs anyway.
  const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const readRoot = (name: string): string => readFileSync(join(repositoryRoot, name), 'utf8');

  // Which `@fss/domain/<name>` subpaths each process's own source imports, plus
  // the subpaths this package reaches into from inside. Both have to be in the
  // image; only the first is visible in the app's own files.
  const RESEARCH_REACHES = ['crm', 'db', 'jobs', 'src'] as const;

  it('research reaches exactly the sibling directories this test claims', () => {
    const reached = new Set<string>();
    for (const file of researchSourceFiles()) {
      for (const match of readFileSync(file, 'utf8').matchAll(/from '\.\.\/([a-z]+)\//gu)) {
        reached.add(match[1] as string);
      }
    }
    expect([...reached].sort()).toEqual([...RESEARCH_REACHES]);
  });

  for (const service of ['api', 'worker'] as const) {
    it(`the ${service} image copies every domain directory its process loads`, () => {
      const dockerfile = readRoot(`Dockerfile.${service}`);
      const ignore = readRoot(`Dockerfile.${service}.dockerignore`);
      const source = researchSourceFiles(join(repositoryRoot, 'apps', service, 'src'));
      const imported = new Set<string>();
      for (const file of source) {
        for (const match of readFileSync(file, 'utf8').matchAll(/from '@fss\/domain\/([a-z]+)'/gu)) {
          imported.add(match[1] as string);
        }
      }
      // Nothing is asserted about which directories a process happens to import;
      // whatever they are, and whatever they reach, the image has to carry them.
      if (!imported.has('research')) return;
      for (const directory of [...imported, ...RESEARCH_REACHES]) {
        expect(dockerfile).toContain(`COPY packages/domain/${directory} packages/domain/${directory}`);
        expect(ignore).toContain(`!packages/domain/${directory}`);
      }
    });

    it(`the ${service} image leaves the recorded fixtures out`, () => {
      // `**/test/**` does not match a directory called `testing`, so the
      // fixtures would otherwise ride into production inside `research`.
      expect(readRoot(`Dockerfile.${service}.dockerignore`)).toContain('packages/domain/research/testing');
      expect(readRoot(`Dockerfile.${service}`)).toMatch(/RUN rm -rf .*packages\/domain\/research\/testing/u);
    });
  }
});
