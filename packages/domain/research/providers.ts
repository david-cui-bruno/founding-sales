import type { FactSelection } from './facts.ts';

/**
 * The three provider seams, as interfaces.
 *
 * Every research path in this package talks to a provider only through one of these,
 * and nothing in `packages/domain/research/**` imports `node:https`, `node:dns` or
 * `fetch`. That is not tidiness. It is what makes "no live provider calls anywhere"
 * checkable: `test/research/rules.test.ts` reads every file in this directory and
 * fails on a network import, and the fixture implementations in `testing/` are the
 * only implementations that exist in the repository at all.
 *
 * The real adapters — the pinned-DNS https fetch of
 * `src/main/research/companyPageProvider.ts`, the Places text search of
 * `placesDiscoveryProvider.ts`, the structured model call of
 * `companyFactExtraction.ts` — are a later, separately reviewed change that supplies
 * one object each. Their obligations are written into the contracts below rather than
 * left to the implementer to remember, because the old build learned each of them the
 * hard way:
 *
 *   * resolve the name, check **every** answer against `isPublicResearchAddress`, and
 *     pin the connection to the address that was checked;
 *   * refuse redirects to anything `researchSourcePolicy` does not call a candidate;
 *   * bound the response in bytes before decoding, and hash the exact bytes read;
 *   * never let a provider supply a quote — return a block reference and let
 *     `validateFactSelections` look the text up.
 *
 * ## Costs and failures
 *
 * A provider result carries what the call cost and, when it failed, a short redacted
 * code. Both go into `research_provider_ledger` beside the workspace business date
 * (7.4: "Provider calls, costs, failures, and evidence retention are capped and
 * audited"), so the accounting is per provider rather than one number for research.
 */

/** A short lower-snake code. `research_provider_ledger_failure_code_shape` refuses the rest. */
export type ProviderFailureCode = string;

export interface ProviderCallCost {
  /** What this call cost, in micros. Zero for a provider whose reviewed price is zero. */
  readonly costMicros: number;
}

export type ProviderOutcome<T> =
  | ({ readonly ok: true; readonly value: T } & ProviderCallCost)
  | ({ readonly ok: false; readonly failureCode: ProviderFailureCode } & ProviderCallCost);

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** What the caller asks a discovery provider for: one page of one query. */
export interface DiscoveryRequest {
  /** The exact text query. Hashed into the job's `query_hash`. */
  readonly query: string;
  /** The provider's opaque continuation token, or null for the first page. */
  readonly pageToken: string | null;
  readonly maxCandidates: number;
}

/**
 * One firm a discovery provider listed.
 *
 * `listingReference` is the provider's own stable identifier for the listing — a place
 * id, not a URL — and it becomes the evidence item's `source_reference`, so the
 * evidence names the record that was actually read.
 */
export interface DiscoveryCandidate {
  readonly name: string;
  /** The firm's own website host, lower case, no scheme and no `www.`. */
  readonly domain: string;
  /** The https root of that host. Must be a `candidate` under `researchSourcePolicy`. */
  readonly sourceUrl: string;
  readonly listingReference: string;
  /** E.164, or null when the listing published none. */
  readonly listedPhone: string | null;
  readonly addressLine: string | null;
  readonly locality: string | null;
  /** A two-letter US state code, or null. Without it the coordinate cannot pick a zone. */
  readonly regionCode: string | null;
  readonly postalCode: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

export interface DiscoveryPage {
  readonly query: string;
  readonly pageToken: string | null;
  readonly nextPageToken: string | null;
  readonly candidates: readonly DiscoveryCandidate[];
  /**
   * A sha256 of the exact response bytes. It is the page's identity in
   * `research_pages.page_hash` and Appendix C's `{page_hash}`, so it must be taken
   * over the bytes that were read and nothing else.
   */
  readonly responseHash: string;
  /** Candidates the provider returned and the adapter dropped, by reason. Counted only. */
  readonly skipped: Readonly<Record<string, number>>;
}

export interface DiscoveryProvider {
  readonly providerKey: string;
  discover(request: DiscoveryRequest): Promise<ProviderOutcome<DiscoveryPage>>;
}

// ---------------------------------------------------------------------------
// Page fetch
// ---------------------------------------------------------------------------

export interface PageFetchRequest {
  /**
   * The exact URLs that may be requested, in order. The caller builds them with
   * `permittedFirmSources`; the adapter must request nothing else, including after a
   * redirect.
   */
  readonly urls: readonly string[];
  readonly maxBytes: number;
}

export interface FetchedPage {
  readonly url: string;
  /** A sha256 of the exact bytes read. The evidence item's `content_hash`. */
  readonly contentHash: string;
  /** The `content-type` header value, as received. */
  readonly contentType: string;
  /** The bytes read, for `parsePageText`. Never stored. */
  readonly body: Uint8Array;
  readonly retrievedAt: string;
}

export interface PageFetchResult {
  readonly pages: readonly FetchedPage[];
  /** URLs the adapter refused or could not read, by reason. Counted only. */
  readonly skipped: Readonly<Record<string, number>>;
}

export interface PageFetchProvider {
  readonly providerKey: string;
  fetchPages(request: PageFetchRequest): Promise<ProviderOutcome<PageFetchResult>>;
}

// ---------------------------------------------------------------------------
// Fact extraction
// ---------------------------------------------------------------------------

/** One page's blocks, offered to an extraction provider by reference only. */
export interface ExtractionSource {
  readonly sourceReference: string;
  readonly blocks: readonly { readonly id: string; readonly text: string }[];
}

export interface ExtractionRequest {
  readonly sources: readonly ExtractionSource[];
  readonly maxInputBytes: number;
}

export interface ExtractionProvider {
  readonly providerKey: string;
  /**
   * Selections, never text. The quote is looked up from the block the selection names
   * (`validateFactSelections`), so a provider that paraphrases cannot be believed.
   */
  extract(request: ExtractionRequest): Promise<ProviderOutcome<readonly FactSelection[]>>;
}

/**
 * The providers a research run was given. Every one is optional: a run with no
 * extraction provider records the pages and the deterministic findings and no model
 * facts, which is a smaller result rather than a failure.
 */
export interface ResearchProviders {
  readonly discovery?: DiscoveryProvider | undefined;
  readonly pageFetch?: PageFetchProvider | undefined;
  readonly extraction?: ExtractionProvider | undefined;
}
