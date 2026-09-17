import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PLACES_FIELD_MASK, PLACES_TEXT_SEARCH_URL, createPlacesDiscoveryProvider, placesPermittedSources, placesQueryGrid, requestPlacesTextSearch,
  type PlacesPage } from './placesDiscoveryProvider';

const now = '2026-09-17T12:00:00.000Z';
const limits = { maxCompanies: 20, maxPages: 2, maxBytes: 100000, maxCostMicros: 35000 };
const audience = { residential: true, regions: ['Providence, RI', 'Boston, MA'], terms: ['property management company'] };
/** Three fictional firms: one has no website, two have listed phones. One website is http with www. */
const places = [
  { id: 'place-alpha', displayName: { text: 'Alpha Residential Management', languageCode: 'en' }, formattedAddress: '1 Fictional St, Providence, RI', nationalPhoneNumber: '(401) 555-0101', internationalPhoneNumber: '+1 401-555-0101', websiteUri: 'http://www.alpha-pm.example/', primaryType: 'property_management_company', types: ['property_management_company'] },
  { id: 'place-beta', displayName: { text: 'Beta Property Group' }, formattedAddress: '2 Fictional Ave, Boston, MA', nationalPhoneNumber: '(617) 555-0102', websiteUri: 'https://beta-group.example/contact' },
  { id: 'place-gamma', displayName: { text: 'Gamma Rentals' }, formattedAddress: '3 Fictional Rd, Boston, MA', nationalPhoneNumber: '(617) 555-0103' },
];
function fixture(body: unknown = { places, nextPageToken: 'token-2' }, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const fetch: typeof globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return new Response(raw, { status, headers: { 'content-type': 'application/json' } }); };
  return { calls, fetch, raw, sha256: createHash('sha256').update(raw).digest('hex') };
}
const request = (f: ReturnType<typeof fixture>, pageToken: string | null = null) => requestPlacesTextSearch({ textQuery: 'property management company in Providence, RI', pageToken, pageSize: 20,
  apiKey: 'fictional-places-key', fetch: f.fetch, signal: new AbortController().signal, fetchedAt: now });

describe('Places text search discovery provider', () => {
  it('sends one Places API (New) text search with key and field mask headers and never follows redirects', async () => {
    const f = fixture(); await request(f);
    expect(f.calls).toHaveLength(1);
    const [call] = f.calls;
    expect(call!.url).toBe(PLACES_TEXT_SEARCH_URL);
    expect(call!.init.method).toBe('POST'); expect(call!.init.redirect).toBe('error');
    expect(call!.init.headers).toMatchObject({ 'X-Goog-Api-Key': 'fictional-places-key', 'X-Goog-FieldMask': PLACES_FIELD_MASK, 'Content-Type': 'application/json' });
    expect(JSON.parse(String(call!.init.body))).toEqual({ textQuery: 'property management company in Providence, RI', pageSize: 20 });
    const second = fixture(); await request(second, 'token-2');
    expect(JSON.parse(String(second.calls[0]!.init.body))).toEqual({ textQuery: 'property management company in Providence, RI', pageSize: 20, pageToken: 'token-2' });
  });
  it('maps firms with a website into candidates with normalised listed phones and skips firms without one', async () => {
    const f = fixture(); const page = await request(f);
    expect(page.nextPageToken).toBe('token-2'); expect(page.returned).toBe(3);
    expect(page.skipped).toEqual({ no_website: 1, website_blocked: 0, duplicate_domain: 0, duplicate_phone: 0 });
    expect(page.candidates.map(c => ({ name: c.name, domain: c.domain, sourceUrl: c.sourceUrl, placeId: c.placeId, listedPhone: c.listedPhone }))).toEqual([
      { name: 'Alpha Residential Management', domain: 'alpha-pm.example', sourceUrl: 'https://www.alpha-pm.example/', placeId: 'place-alpha', listedPhone: '+14015550101' },
      { name: 'Beta Property Group', domain: 'beta-group.example', sourceUrl: 'https://beta-group.example/', placeId: 'place-beta', listedPhone: '+16175550102' },
    ]);
    for (const candidate of page.candidates) {
      expect(candidate.evidence).toMatchObject({ url: PLACES_TEXT_SEARCH_URL, fetchedAt: now, sha256: f.sha256 });
      expect(candidate.evidence.excerpt).toContain(candidate.placeId); expect(candidate.evidence.excerpt.length).toBeLessThanOrEqual(12000);
    }
    expect(page.candidates[0]!.evidence.excerpt).toContain('(401) 555-0101');
  });
  it('counts blocked, shared-platform and duplicate websites or phones instead of creating candidates for them', async () => {
    const f = fixture({ places: [
      { id: 'p1', displayName: { text: 'Blocked' }, websiteUri: 'https://narpm.org/member/1', nationalPhoneNumber: '(401) 555-0201' },
      { id: 'p2', displayName: { text: 'Social only' }, websiteUri: 'https://www.facebook.com/somefirm', nationalPhoneNumber: '(401) 555-0202' },
      { id: 'p3', displayName: { text: 'Local host' }, websiteUri: 'https://intranet/', nationalPhoneNumber: '(401) 555-0203' },
      { id: 'p4', displayName: { text: 'First' }, websiteUri: 'https://first.example/', nationalPhoneNumber: '(401) 555-0204' },
      { id: 'p5', displayName: { text: 'Same domain' }, websiteUri: 'https://www.first.example/about', nationalPhoneNumber: '(401) 555-0205' },
      { id: 'p6', displayName: { text: 'Same phone' }, websiteUri: 'https://second.example/', nationalPhoneNumber: '401-555-0204' },
      { id: 'p7', displayName: { text: 'No US phone' }, websiteUri: 'https://third.example/', internationalPhoneNumber: '+44 20 7946 0958' },
    ] });
    const page = await request(f);
    expect(page.nextPageToken).toBeNull();
    expect(page.skipped).toEqual({ no_website: 0, website_blocked: 3, duplicate_domain: 1, duplicate_phone: 1 });
    expect(page.candidates.map(c => [c.domain, c.listedPhone])).toEqual([['first.example', '+14015550204'], ['third.example', null]]);
  });
  it('classifies rejected, invalid and uncertain provider outcomes without retrying', async () => {
    const rejected = fixture({ error: { code: 403 } }, 403);
    await expect(request(rejected)).rejects.toMatchObject({ name: 'ResearchDiscoveryError', reason: 'http_rejected', httpStatus: 403 });
    expect(rejected.calls).toHaveLength(1);
    await expect(request(fixture('not json'))).rejects.toMatchObject({ reason: 'response_body_invalid' });
    await expect(request(fixture({ places: [{ displayName: { text: 'missing id' } }] }))).rejects.toMatchObject({ reason: 'output_invalid' });
    let attempts = 0;
    const lost: typeof globalThis.fetch = async () => { attempts++; throw new Error('fictional lost response'); };
    await expect(requestPlacesTextSearch({ textQuery: 'q', pageToken: null, pageSize: 20, apiKey: 'k', fetch: lost, signal: new AbortController().signal, fetchedAt: now }))
      .rejects.toMatchObject({ reason: 'transport_uncertain' });
    expect(attempts).toBe(1);
    await expect(requestPlacesTextSearch({ textQuery: 'q', pageToken: null, pageSize: 20, apiKey: '', fetch: lost, signal: new AbortController().signal, fetchedAt: now })).rejects.toThrow('Places credentials unconfigured');
    expect(attempts).toBe(1);
  });
  it('builds the territory grid as terms across regions and per-account sources for the pages that are actually fetched', () => {
    expect(placesQueryGrid(audience)).toEqual(['property management company in Providence, RI', 'property management company in Boston, MA']);
    expect(placesPermittedSources('alpha-pm.example', 2)).toEqual(['https://alpha-pm.example/', 'https://alpha-pm.example/services', 'https://www.alpha-pm.example/', 'https://www.alpha-pm.example/services']);
    expect(placesPermittedSources('alpha-pm.example', 10)).toHaveLength(8);
  });
  it('implements the discovery port for one grid position, reports the page and refuses batches above the page size', async () => {
    const f = fixture(); const pages: PlacesPage[] = [];
    const provider = createPlacesDiscoveryProvider({ credentials: { apiKey: 'fictional-places-key' }, fetch: f.fetch, clock: { now: () => now },
      position: () => ({ queryIndex: 1, pageToken: 'token-2' }), onPage: page => { pages.push(page); } });
    const candidates = await provider.discover(audience, limits, new AbortController().signal);
    expect(candidates.map(c => c.domain)).toEqual(['alpha-pm.example', 'beta-group.example']);
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ textQuery: 'property management company in Boston, MA', pageSize: 20, pageToken: 'token-2' });
    expect(pages).toHaveLength(1); expect(pages[0]!.textQuery).toBe('property management company in Boston, MA');
    await expect(provider.discover(audience, { ...limits, maxCompanies: 21 }, new AbortController().signal)).rejects.toThrow('at most 20 companies');
    const exhausted = createPlacesDiscoveryProvider({ credentials: { apiKey: 'k' }, fetch: f.fetch, clock: { now: () => now }, position: () => ({ queryIndex: 2, pageToken: null }) });
    await expect(exhausted.discover(audience, limits, new AbortController().signal)).rejects.toThrow('grid exhausted');
    expect(f.calls).toHaveLength(1);
  });
});
