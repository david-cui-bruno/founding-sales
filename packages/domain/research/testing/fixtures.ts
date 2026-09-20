import { createHash } from 'node:crypto';
import type { FactSelection } from '../facts.ts';
import type {
  DiscoveryCandidate,
  DiscoveryPage,
  DiscoveryProvider,
  DiscoveryRequest,
  ExtractionProvider,
  ExtractionRequest,
  FetchedPage,
  PageFetchProvider,
  PageFetchRequest,
  PageFetchResult,
  ProviderOutcome,
} from '../providers.ts';

/**
 * Recorded provider fixtures.
 *
 * These are the only implementations of the three provider interfaces in the
 * repository. Every test and every local run uses one; nothing opens a socket.
 *
 * "Recorded" means the responses are written down here, in the shape the real adapter
 * produces, rather than generated on demand by a mock library. A recorded fixture
 * fails the same way a provider does — a page with no website, a page whose bytes are
 * over the bound, a provider that refuses with a code — and it is the same bytes every
 * run, so a content hash is stable and a replay test can prove it.
 *
 * ## No real business exists here
 *
 * Every name is invented, every host is under `example.test` (reserved by RFC 6761),
 * every number is in the NANP 555-01XX fictional block, and every address is a
 * fictional street in a real city, at a coordinate chosen for which side of a
 * time-zone boundary it falls on and nothing else. `npm run verify:secrets` scans
 * this file like any other.
 */

/** sha256 of a UTF-8 string. The fixtures' content hashes are real hashes of real bytes. */
export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Four recorded listings.
 *
 * * `northgate` is in Texas, west of the El Paso margin, so its coordinate resolves
 *   `America/Denver` where G3a's postal table would also have answered.
 * * `riverbend` is in Tennessee — one of the thirteen states the postal table refuses
 *   — comfortably west of the Eastern boundary, so its coordinate resolves
 *   `America/Chicago`. This is the coordinator's note, as a fixture.
 * * `seamwater` sits inside the Tennessee margin, so it resolves nothing and the firm
 *   is recorded with an unresolved zone.
 * * `platformonly` lists a shared-platform website, so the adapter skips it.
 */
export const RECORDED_LISTINGS: readonly DiscoveryCandidate[] = Object.freeze([
  Object.freeze({
    name: 'Northgate Residential Management',
    domain: 'northgate-residential.example.test',
    sourceUrl: 'https://northgate-residential.example.test/',
    listingReference: 'listing-northgate-0001',
    listedPhone: '+14015550142',
    addressLine: '1200 Fictional Mesa Road',
    locality: 'El Paso',
    regionCode: 'TX',
    postalCode: '79901',
    latitude: 31.7587,
    longitude: -106.4869,
  }),
  Object.freeze({
    name: 'Riverbend Property Group',
    domain: 'riverbend-property.example.test',
    sourceUrl: 'https://riverbend-property.example.test/',
    listingReference: 'listing-riverbend-0002',
    listedPhone: '+14015550163',
    addressLine: '88 Invented Broadway',
    locality: 'Nashville',
    regionCode: 'TN',
    postalCode: '37201',
    latitude: 36.1627,
    longitude: -86.7816,
  }),
  Object.freeze({
    name: 'Seamwater Rentals',
    domain: 'seamwater-rentals.example.test',
    sourceUrl: 'https://seamwater-rentals.example.test/',
    listingReference: 'listing-seamwater-0003',
    listedPhone: null,
    addressLine: '4 Imaginary Ridge',
    locality: 'Chattanooga',
    regionCode: 'TN',
    postalCode: '37402',
    // Inside Tennessee's 0.3 degree margin: the table refuses rather than guess.
    latitude: 35.0456,
    longitude: -85.3097,
  }),
  Object.freeze({
    name: 'Platform Only Lettings',
    domain: 'facebook.com',
    sourceUrl: 'https://facebook.com/',
    listingReference: 'listing-platform-0004',
    listedPhone: null,
    addressLine: null,
    locality: null,
    regionCode: null,
    postalCode: null,
    latitude: null,
    longitude: null,
  }),
]);

export interface RecordedDiscoveryOptions {
  readonly providerKey?: string;
  readonly costMicros?: number;
  /** Listings to return, defaulting to the three that survive the source policy. */
  readonly candidates?: readonly DiscoveryCandidate[];
  readonly nextPageToken?: string | null;
  /** When set, the provider refuses with this code and returns no page. */
  readonly failureCode?: string;
  /** Incremented per call so a test can prove a replay did not call again. */
  readonly calls?: { count: number };
}

/**
 * A discovery provider that answers from `RECORDED_LISTINGS`.
 *
 * The response hash is a real sha256 over the serialized page, so two calls with the
 * same request produce the same `page_hash` and the idempotency key is stable — which
 * is the property Appendix C's `research:{query_hash}:{page_hash}` depends on.
 */
export function recordedDiscoveryProvider(options: RecordedDiscoveryOptions = {}): DiscoveryProvider {
  const providerKey = options.providerKey ?? 'places';
  const costMicros = options.costMicros ?? 32_000;
  const candidates =
    options.candidates ?? RECORDED_LISTINGS.filter(listing => listing.domain.endsWith('.example.test'));
  const skipped = Object.freeze({
    website_blocked: RECORDED_LISTINGS.length - candidates.length,
  });

  return {
    providerKey,
    discover: async (request: DiscoveryRequest): Promise<ProviderOutcome<DiscoveryPage>> => {
      if (options.calls !== undefined) options.calls.count += 1;
      if (options.failureCode !== undefined) {
        return await Promise.resolve({ ok: false, failureCode: options.failureCode, costMicros });
      }
      const returned = candidates.slice(0, Math.max(0, request.maxCandidates));
      const page: DiscoveryPage = {
        query: request.query,
        pageToken: request.pageToken,
        nextPageToken: options.nextPageToken ?? null,
        candidates: returned,
        responseHash: sha256(JSON.stringify({ query: request.query, pageToken: request.pageToken, returned })),
        skipped,
      };
      return await Promise.resolve({ ok: true, value: page, costMicros });
    },
  };
}

// ---------------------------------------------------------------------------
// Page fetch
// ---------------------------------------------------------------------------

/**
 * One recorded page per fixture firm. The markup exercises the parser's rules on
 * purpose: a `blockquote` testimonial that must not become a fact, a hidden element,
 * a `mailto:` link whose visible label is not an address, a free-mail address, an
 * off-domain address, and a tenant-emergency line whose address must be withheld.
 */
export const RECORDED_PAGES: Readonly<Record<string, string>> = Object.freeze({
  'https://northgate-residential.example.test/': [
    '<html><body>',
    '<h1>Northgate Residential Management</h1>',
    '<p>We are a regional residential property management company.</p>',
    '<p>Operating footprint: El Paso and the surrounding county.</p>',
    '<blockquote>Best managers we have ever used. — a tenant</blockquote>',
    '<p style="display:none">Hidden marketing copy that was never published.</p>',
    '<p>Business email: <a href="mailto:info@northgate-residential.example.test">write to the office</a></p>',
    '<p>Personal inbox: northgate.manager@gmail.com</p>',
    '<p>Tenant emergency line: emergency@northgate-residential.example.test</p>',
    '<p>Our listing partner: sales@platform-partner.example.test</p>',
    '</body></html>',
  ].join('\n'),
  'https://riverbend-property.example.test/': [
    '<html><body>',
    '<h1>Riverbend Property Group</h1>',
    '<p>We manage residential buildings on behalf of their owners.</p>',
    '<p>Operating footprint: Nashville and middle Tennessee.</p>',
    '<p>Office: <a href="mailto:office@riverbend-property.example.test">contact the team</a></p>',
    '</body></html>',
  ].join('\n'),
  'https://seamwater-rentals.example.test/': [
    '<html><body>',
    '<h1>Seamwater Rentals</h1>',
    '<p>We are a commercial brokerage only and do not manage property for others.</p>',
    '</body></html>',
  ].join('\n'),
});

export interface RecordedPageFetchOptions {
  readonly providerKey?: string;
  readonly costMicros?: number;
  readonly pages?: Readonly<Record<string, string>>;
  readonly failureCode?: string;
  readonly calls?: { count: number };
  /** A fixed instant, so a fixture's evidence retrieval time is not the wall clock. */
  readonly retrievedAt?: string;
}

/**
 * A page-fetch provider that answers from `RECORDED_PAGES`.
 *
 * It honours the request's allowlist exactly: a URL that is not in `RECORDED_PAGES` is
 * skipped as `not_recorded`, which is the fixture's stand-in for a 404 and proves the
 * caller tolerates a firm whose `/team` page does not exist.
 */
export function recordedPageFetchProvider(options: RecordedPageFetchOptions = {}): PageFetchProvider {
  const providerKey = options.providerKey ?? 'company_page';
  const costMicros = options.costMicros ?? 0;
  const recorded = options.pages ?? RECORDED_PAGES;
  const retrievedAt = options.retrievedAt ?? '2026-09-20T12:00:00.000Z';

  return {
    providerKey,
    fetchPages: async (request: PageFetchRequest): Promise<ProviderOutcome<PageFetchResult>> => {
      if (options.calls !== undefined) options.calls.count += 1;
      if (options.failureCode !== undefined) {
        return await Promise.resolve({ ok: false, failureCode: options.failureCode, costMicros });
      }
      const pages: FetchedPage[] = [];
      let notRecorded = 0;
      let overBound = 0;
      for (const url of request.urls) {
        const markup = recorded[url];
        if (markup === undefined) {
          notRecorded += 1;
          continue;
        }
        const body = encoder.encode(markup);
        if (body.byteLength > request.maxBytes) {
          overBound += 1;
          continue;
        }
        pages.push({
          url,
          contentHash: sha256(body),
          contentType: 'text/html; charset=utf-8',
          body,
          retrievedAt,
        });
      }
      return await Promise.resolve({
        ok: true,
        value: { pages, skipped: { not_recorded: notRecorded, over_byte_bound: overBound } },
        costMicros,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Fact extraction
// ---------------------------------------------------------------------------

export interface RecordedExtractionOptions {
  readonly providerKey?: string;
  readonly costMicros?: number;
  readonly failureCode?: string;
  readonly calls?: { count: number };
  /**
   * Return a selection whose quote would have to be invented. The caller must refuse
   * it, which is the provenance rule of `validateFactSelections` under test.
   */
  readonly returnUnknownBlock?: boolean;
  /** Return a key outside `COMPANY_FACT_KEYS`. Also refused. */
  readonly returnUnknownKey?: boolean;
}

/**
 * An extraction provider that selects blocks by a deterministic rule rather than a
 * model: the first block containing a phrase that maps to a fact key.
 *
 * That is the honest fixture for this seam. The real provider's judgement is not
 * reproducible, so a recorded fixture cannot imitate it; what a test needs to pin down
 * is the *admission* rule — that a selection naming an unknown block or an unknown key
 * is refused, and that an admitted fact's quote is the block's whole text.
 */
export function recordedExtractionProvider(options: RecordedExtractionOptions = {}): ExtractionProvider {
  const providerKey = options.providerKey ?? 'page_facts';
  const costMicros = options.costMicros ?? 8_000;
  const phrases: readonly [string, string][] = [
    ['manage residential buildings on behalf', 'target_fit'],
    ['brokerage only', 'not_target'],
    ['residential property management company', 'residential_scope'],
    ['operating footprint', 'operating_footprint'],
  ];

  return {
    providerKey,
    extract: async (request: ExtractionRequest): Promise<ProviderOutcome<readonly FactSelection[]>> => {
      if (options.calls !== undefined) options.calls.count += 1;
      if (options.failureCode !== undefined) {
        return await Promise.resolve({ ok: false, failureCode: options.failureCode, costMicros });
      }
      const selections: FactSelection[] = [];
      for (const source of request.sources) {
        for (const block of source.blocks) {
          const lowered = block.text.toLowerCase();
          for (const [phrase, key] of phrases) {
            if (!lowered.includes(phrase)) continue;
            selections.push({ key, sourceReference: source.sourceReference, blockId: block.id });
          }
        }
      }
      if (options.returnUnknownBlock === true) {
        const first = request.sources[0];
        if (first !== undefined) {
          selections.push({ key: 'ownership', sourceReference: first.sourceReference, blockId: 'b9999' });
        }
      }
      if (options.returnUnknownKey === true) {
        const first = request.sources[0];
        const block = first?.blocks[0];
        if (first !== undefined && block !== undefined) {
          selections.push({ key: 'prospect_pain', sourceReference: first.sourceReference, blockId: block.id });
        }
      }
      return await Promise.resolve({ ok: true, value: selections, costMicros });
    },
  };
}
