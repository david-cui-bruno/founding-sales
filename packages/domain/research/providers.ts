import type { FactSelection } from './facts.ts';

/**
 * The two provider seams, as interfaces.
 *
 * Every research path talks to a provider only through one of these, and nothing in
 * `packages/domain/research/**` imports `node:https`, `node:http`, `node:dns`,
 * `undici` or `fetch`. That is not tidiness. It is what makes "no live provider call
 * anywhere in the domain" checkable: `test/research/rules.test.ts` reads every file in
 * the directory and fails on a network import, so the only implementations that can
 * exist here are fakes.
 *
 * The live adapters are in `apps/worker/src/research/`: `companyPageFetch.ts` and
 * `anthropicExtraction.ts`. Their obligations are written into the contracts below
 * rather than left to the implementer to remember, because the old build learned
 * each of them the hard way:
 *
 *   * **resolve the name, check every answer, pin the connection.** A firm's DNS
 *     answer is attacker-controlled input. Every address must pass
 *     `isPublicResearchAddress`, and the socket must connect to the address that was
 *     checked rather than resolving the name a second time.
 *   * **re-check every redirect.** A redirect is a new URL and gets the whole rule
 *     again — `permittedResearchUrl`, a fresh resolution, a fresh pin — because
 *     otherwise the firm decides where the worker connects.
 *   * **bound the response in bytes before decoding, and hash the exact bytes read.**
 *     The content hash is the evidence item's identity, so it has to be over what was
 *     actually read and nothing else.
 *   * **never let a provider supply a quote.** An extraction returns
 *     `{ key, sourceReference, blockId }` and `validateFactSelections` looks the text
 *     up locally, so a model that paraphrases cannot be believed rather than being
 *     believed wrongly.
 */

/** A short lower-snake code. `provider_ledger_failure_code_shape` refuses the rest. */
export type ProviderFailureCode = string;

export interface ProviderCallCost {
  /** What this call cost, in whole cents. Zero for a fetch, which is free. */
  readonly costCents: number;
  /**
   * True when `costCents` is not a figure the provider reported.
   *
   * A transport that threw and a response that carried no `usage` are the two cases,
   * and in both of them the call may well have happened and been billed. The caller
   * records the run's **reservation** rather than this zero and marks the run
   * `cost_estimated`, because zero is the one answer that is certainly wrong: a budget
   * that reads a burned call as free is a budget a broken provider walks straight
   * through.
   */
  readonly costEstimated?: boolean | undefined;
}

export type ProviderOutcome<T> =
  | ({ readonly ok: true; readonly value: T } & ProviderCallCost)
  | ({ readonly ok: false; readonly failureCode: ProviderFailureCode } & ProviderCallCost);

// ---------------------------------------------------------------------------
// Page fetch
// ---------------------------------------------------------------------------

export interface PageFetchRequest {
  /**
   * The exact URLs that may be requested, in order. The caller builds them with
   * `researchUrlsForFirm`; the adapter must request nothing else, including after a
   * redirect, and re-asks `permittedResearchUrl` itself rather than trusting this.
   */
  readonly urls: readonly string[];
  /** So the adapter can re-check a redirect against the same rule the caller used. */
  readonly firmWebsite: string | null;
  readonly links: readonly string[];
  readonly maxPagesPerFirm: number;
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
  /**
   * True when the page is on the firm's own site — an allow-listed path, or one its own
   * homepage linked to. False for a link a person added on another host.
   *
   * It travels with the page rather than being re-derived at the other end, because the
   * adapter is the only place that knows which of the two permissions a URL was fetched
   * under after a chain of redirects.
   */
  readonly firstParty: boolean;
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
  readonly firmName: string;
}

/**
 * What one extraction returns: which blocks say what, and the two generated lines.
 *
 * `questions` and `opening` are the only text a model authors that reaches a person,
 * and they are stored in `research_runs.brief` under `generated: true` so the desktop
 * can label them. Everything else on the call brief is the firm's own words.
 */
export interface ExtractionAnswer {
  readonly selections: readonly FactSelection[];
  readonly questions: readonly [string, string] | null;
  readonly opening: string | null;
  readonly modelName: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ExtractionProvider {
  readonly providerKey: string;
  /** Selections, never text. The quote is looked up from the block the selection names. */
  extract(request: ExtractionRequest): Promise<ProviderOutcome<ExtractionAnswer>>;
}
