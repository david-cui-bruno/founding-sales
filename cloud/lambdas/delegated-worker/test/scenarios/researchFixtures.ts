import type { PageHttp } from '../../../../../src/main/research/companyPageProvider';
import { PLACES_TEXT_SEARCH_URL } from '../../../../../src/main/research/placesDiscoveryProvider';
import type { QueueClient } from '../../src/queue/queueClient';
import type { JobKind } from '../../src/queue/jobs';
import type { ResearchDependencies } from '../../src/v1/research';
import type { v1Fixture } from './v1Fixture';

/**
 * The provider boundaries S4's two jobs take, as fictional injected functions. Nothing here reaches Google
 * Places, a real website or DNS: the Places fetch answers from a scripted list of pages, the page fetch answers
 * a fixed body per path, and the resolver returns one public documentation address. Every domain, address and
 * number is fictional, and the numbers stay outside the reserved 555-0100 to 555-0199 block the production
 * launcher refuses so a card built from them would still be dialable.
 */

export type PlacesListing = { id: string; name: string; address?: string | undefined; phone?: string | undefined; website?: string | undefined };
export type PlacesReply = { places: PlacesListing[]; nextPageToken?: string };

/** One Places text-search page body, in the field shape the carried provider parses. */
export function placesPage(listings: readonly PlacesListing[], nextPageToken?: string): PlacesReply {
  return {
    places: listings.map(listing => ({
      id: listing.id, displayName: { text: listing.name },
      ...(listing.address === undefined ? {} : { formattedAddress: listing.address }),
      ...(listing.phone === undefined ? {} : { nationalPhoneNumber: listing.phone }),
      ...(listing.website === undefined ? {} : { websiteUri: listing.website }),
    })) as unknown as PlacesListing[],
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
  };
}

export type PlacesScript = { pages?: PlacesReply[] };
/** An injected fetch that answers exactly the Places text search and refuses every other URL. */
export function placesFetch(script: PlacesScript): { fetch: typeof globalThis.fetch; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const pages = [...(script.pages ?? [])];
  const fetch: typeof globalThis.fetch = async (resource, init) => {
    const url = String(resource);
    if (url !== PLACES_TEXT_SEARCH_URL) throw new Error(`unconfigured fictional URL: ${url}`);
    calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    const page = pages.shift();
    if (!page) throw new Error('unconfigured fictional Places page');
    return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

/** A page fetch that answers one fixed HTML body for every permitted URL, and counts what it was asked for. */
export function pageHttpOf(bodyOf: (url: string) => string | null): { pageHttp: PageHttp; urls: string[] } {
  const urls: string[] = [];
  const pageHttp: PageHttp = async ({ url }) => {
    urls.push(url);
    const body = bodyOf(url);
    if (body === null) return new Response('', { status: 404, headers: { 'content-type': 'text/html' } });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  return { pageHttp, urls };
}

/**
 * The address the fictional resolver answers with. The page provider's allowlist refuses every private range and
 * every reserved documentation block (203.0.113.0/24 among them), so a fictional address has to sit outside all of
 * them; nothing ever connects to it, because the injected `PageHttp` below answers instead of a socket.
 */
export const fictionalResolve = async (): Promise<string[]> => ['93.184.216.34'];

export function recordingQueue(): QueueClient & { sent: { jobId: string; kind: JobKind }[] } {
  const sent: { jobId: string; kind: JobKind }[] = [];
  return { sent, async enqueue(job: { jobId: string; kind: JobKind }) { sent.push(job); } };
}

/** The research dependencies of one fixture, with every provider injected and nothing reachable. */
export function researchDeps(f: ReturnType<typeof v1Fixture>, overrides: Partial<ResearchDependencies> = {}): ResearchDependencies {
  return {
    store: f.store,
    fetch: async () => { throw new Error('unconfigured fictional HTTP'); },
    places: { apiKey: 'fictional-places-key' },
    resolve: fictionalResolve,
    ...overrides,
  };
}
