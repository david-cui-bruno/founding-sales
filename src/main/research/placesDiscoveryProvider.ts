import { createHash } from 'node:crypto';
import { z } from 'zod';
import { companySourcePolicy } from './companySourcePolicy';
import { ResearchDiscoveryError } from './researchDiscoveryError';
import { normaliseCompanyPhone } from '../../shared/contracts/localCompanyPhoneRouteContract';
import { audienceQuerySchema, researchLimitsSchema, PLACES_MAX_COMPANIES, type AudienceQuery, type CompanyCandidate, type CompanyDiscoveryPort } from './companyResearchTypes';

/** Google Places API (New) Text Search. Every call is treated as Enterprise SKU and reserved before it is made. */
export const PLACES_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
export const PLACES_FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.primaryType,places.types,nextPageToken';
export const PLACES_PAGE_SIZE = PLACES_MAX_COMPANIES;
/** A text query yields at most three pages before the cursor moves to the next query of the grid. */
export const PLACES_MAX_PAGES_PER_QUERY = 3;
const PLACES_MAX_RESPONSE_BYTES = 256 * 1024;
const PLACES_TIMEOUT_MS = 15000;
/** The paths the bounded page provider fetches for a discovered company, in its own order. */
const RESEARCH_PAGE_PATHS = ['/', '/services', '/team', '/careers'] as const;
/** Business-profile websites that point at a shared platform never name the company's own site. */
const SHARED_PLATFORM_HOSTS = ['facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'youtube.com', 'yelp.com', 'google.com', 'apartments.com', 'zillow.com', 'realtor.com', 'trulia.com', 'nextdoor.com', 'tiktok.com'];
const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;

// A place id becomes the route's evidence source id (`place-<id>`), which is bounded at 200 characters.
const placeSchema = z.object({ id: z.string().trim().min(1).max(190), displayName: z.object({ text: z.string().trim().min(1).max(300) }).optional(),
  formattedAddress: z.string().trim().max(500).optional(), nationalPhoneNumber: z.string().trim().max(60).optional(), internationalPhoneNumber: z.string().trim().max(60).optional(),
  websiteUri: z.string().trim().max(2048).optional(), primaryType: z.string().max(120).optional(), types: z.array(z.string().max(120)).max(50).optional() });
const responseSchema = z.object({ places: z.array(placeSchema).max(PLACES_PAGE_SIZE).optional(), nextPageToken: z.string().min(1).max(4096).optional() });
type Place = z.infer<typeof placeSchema>;

export type PlacesEvidence = { url: string; fetchedAt: string; sha256: string; excerpt: string };
export type PlacesCandidate = CompanyCandidate & { placeId: string; listedPhone: string | null; evidence: PlacesEvidence };
export type PlacesSkipReason = 'no_website' | 'website_blocked' | 'duplicate_domain' | 'duplicate_phone';
export type PlacesPage = { textQuery: string; pageToken: string | null; nextPageToken: string | null; returned: number; candidates: PlacesCandidate[]; skipped: Record<PlacesSkipReason, number> };
export type PlacesPosition = { queryIndex: number; pageToken: string | null };

/** The territory grid: every targeting term across every region, terms outermost. */
export function placesQueryGrid(audience: AudienceQuery): string[] {
  const query = audienceQuerySchema.parse(audience);
  return query.terms.flatMap(term => query.regions.map(region => `${term} in ${region}`));
}
/** Exactly the URLs the page provider may fetch for a Places-born company: its root and the discovery paths within `maxPages`, on the bare and `www.` host. */
export function placesPermittedSources(domain: string, maxPages: number): string[] {
  const paths = RESEARCH_PAGE_PATHS.slice(0, Math.max(1, Math.min(maxPages, RESEARCH_PAGE_PATHS.length)));
  return [domain, `www.${domain}`].flatMap(host => paths.map(path => `https://${host}${path}`));
}
/** Website host without `www.`, or null when the listed website cannot name a company's own https site. */
function websiteRoot(websiteUri: string): { domain: string; sourceUrl: string } | null {
  let host: string;
  try { host = new URL(websiteUri).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; }
  if (!host) return null;
  const sourceUrl = `https://${host}/`;
  const domain = host.replace(/^www\./, '');
  if (companySourcePolicy(sourceUrl) !== 'candidate' || domain.length > 253 || !domainPattern.test(domain)) return null;
  if (SHARED_PLATFORM_HOSTS.some(shared => domain === shared || domain.endsWith(`.${shared}`))) return null;
  return { domain, sourceUrl };
}
function excerptOf(place: Place): string {
  const { id, displayName, formattedAddress, nationalPhoneNumber, internationalPhoneNumber, websiteUri } = place;
  return JSON.stringify({ id, displayName: displayName?.text, formattedAddress, nationalPhoneNumber, internationalPhoneNumber, websiteUri }).slice(0, 12000);
}
/** Deterministic mapping of one response page. Firms without a website are counted and skipped; a page never repeats a domain or a listed phone. */
export function mapPlacesPage(input: { textQuery: string; pageToken: string | null; body: unknown; raw: Buffer; fetchedAt: string }): PlacesPage {
  const parsed = responseSchema.safeParse(input.body);
  if (!parsed.success) throw new ResearchDiscoveryError('output_invalid');
  const evidenceBase = { url: PLACES_TEXT_SEARCH_URL, fetchedAt: input.fetchedAt, sha256: createHash('sha256').update(input.raw).digest('hex') };
  const skipped: Record<PlacesSkipReason, number> = { no_website: 0, website_blocked: 0, duplicate_domain: 0, duplicate_phone: 0 };
  const domains = new Set<string>(); const phones = new Set<string>(); const candidates: PlacesCandidate[] = [];
  for (const place of parsed.data.places ?? []) {
    if (!place.websiteUri) { skipped.no_website++; continue; }
    const root = websiteRoot(place.websiteUri);
    if (!root) { skipped.website_blocked++; continue; }
    if (domains.has(root.domain)) { skipped.duplicate_domain++; continue; }
    const written = place.nationalPhoneNumber ?? place.internationalPhoneNumber;
    const listedPhone = written ? normaliseCompanyPhone(written) : null;
    if (listedPhone && phones.has(listedPhone)) { skipped.duplicate_phone++; continue; }
    domains.add(root.domain); if (listedPhone) phones.add(listedPhone);
    candidates.push({ name: place.displayName?.text ?? root.domain, domain: root.domain, sourceUrl: root.sourceUrl, placeId: place.id, listedPhone,
      evidence: { ...evidenceBase, excerpt: excerptOf(place) } });
  }
  return { textQuery: input.textQuery, pageToken: input.pageToken, nextPageToken: parsed.data.nextPageToken ?? null, returned: parsed.data.places?.length ?? 0, candidates, skipped };
}
/** Exactly one bounded fetch, no redirects or retries. The raw bytes are hashed so the receipt names the response that was actually read. */
async function fetchBytesOnce(input: { fetch: typeof globalThis.fetch; url: string; init: RequestInit; signal: AbortSignal }): Promise<{ status: number; raw: Buffer }> {
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), PLACES_TIMEOUT_MS);
  try {
    let response: Response;
    try { response = await input.fetch(input.url, { ...input.init, redirect: 'error', signal }); }
    catch { throw new ResearchDiscoveryError('transport_uncertain'); }
    if (response.status < 200 || response.status >= 300) {
      void response.body?.cancel().catch((): undefined => undefined);
      throw new ResearchDiscoveryError('http_rejected', response.status);
    }
    const declared = response.headers.get('content-length');
    if ((declared !== null && (!/^\d+$/.test(declared) || Number(declared) > PLACES_MAX_RESPONSE_BYTES)) || !response.body) throw new ResearchDiscoveryError('response_body_invalid');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        if (signal.aborted) throw new ResearchDiscoveryError('transport_uncertain');
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try { chunk = await reader.read(); } catch { throw new ResearchDiscoveryError('transport_uncertain'); }
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > PLACES_MAX_RESPONSE_BYTES) throw new ResearchDiscoveryError('response_body_invalid');
        chunks.push(chunk.value);
      }
    } finally { void reader.cancel().catch((): undefined => undefined); }
    return { status: response.status, raw: Buffer.concat(chunks) };
  } finally { clearTimeout(timer); }
}
/** One Places text-search page for one grid query. Credentials come from the worker's private boundary, never from configuration. */
export async function requestPlacesTextSearch(input: { textQuery: string; pageToken: string | null; pageSize: number; apiKey: string; fetch: typeof globalThis.fetch; signal: AbortSignal; fetchedAt: string }): Promise<PlacesPage> {
  if (!input.apiKey) throw new Error('Places credentials unconfigured');
  const pageSize = z.number().int().min(1).max(PLACES_PAGE_SIZE).parse(input.pageSize);
  const textQuery = z.string().trim().min(1).max(500).parse(input.textQuery);
  input.signal.throwIfAborted();
  const { raw } = await fetchBytesOnce({ fetch: input.fetch, url: PLACES_TEXT_SEARCH_URL, signal: input.signal, init: { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': input.apiKey, 'X-Goog-FieldMask': PLACES_FIELD_MASK },
    body: JSON.stringify({ textQuery, pageSize, ...(input.pageToken ? { pageToken: input.pageToken } : {}) }) } });
  let body: unknown;
  try { body = JSON.parse(raw.toString('utf8')); } catch { throw new ResearchDiscoveryError('response_body_invalid'); }
  return mapPlacesPage({ textQuery, pageToken: input.pageToken, body, raw, fetchedAt: input.fetchedAt });
}
/** The discovery port for one grid position. The caller owns the cursor; `onPage` receives the page metadata the port signature cannot carry. */
export function createPlacesDiscoveryProvider(options: { credentials: { apiKey: string }; fetch: typeof globalThis.fetch; clock: { now(): string };
  position(): PlacesPosition; onPage?(page: PlacesPage): void | Promise<void> }): CompanyDiscoveryPort {
  return { async discover(query, limits, signal) {
    const parsedLimits = researchLimitsSchema.parse(limits);
    if (parsedLimits.maxCompanies > PLACES_PAGE_SIZE) throw new Error(`Places research requires at most ${PLACES_PAGE_SIZE} companies per batch`);
    const grid = placesQueryGrid(query);
    const position = options.position();
    const textQuery = grid[position.queryIndex];
    if (textQuery === undefined) throw new Error('Places query grid exhausted');
    signal.throwIfAborted();
    const page = await requestPlacesTextSearch({ textQuery, pageToken: position.pageToken, pageSize: parsedLimits.maxCompanies, apiKey: options.credentials.apiKey,
      fetch: options.fetch, signal, fetchedAt: options.clock.now() });
    signal.throwIfAborted();
    await options.onPage?.(page);
    return page.candidates;
  } };
}
