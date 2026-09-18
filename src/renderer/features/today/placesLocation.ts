/**
 * City and state from the saved Google Places source excerpt. The worker stores
 * the FETCHED `place-<id>` source with the JSON `{ id, displayName,
 * formattedAddress, nationalPhoneNumber, internationalPhoneNumber, websiteUri }`
 * as its excerpt; this reads `formattedAddress` and nothing else. Pure, total,
 * and honest: anything that is not that excerpt yields null.
 */
export type PlacesLocation = Readonly<{ city: string | null; state: string | null; formattedAddress: string }>;

const COUNTRY_WORDS = new Set(['usa', 'us', 'united states', 'united states of america']);
const STATE = /^([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/;

export function parsePlacesLocation(excerpt: string): PlacesLocation | null {
  let parsed: unknown;
  try { parsed = JSON.parse(excerpt); } catch { return null; }
  if (parsed === null || typeof parsed !== 'object') return null;
  const address = (parsed as { formattedAddress?: unknown }).formattedAddress;
  if (typeof address !== 'string' || address.trim().length === 0) return null;
  const parts = address.split(',').map(part => part.trim()).filter(part => part.length > 0);
  if (parts.length > 0 && COUNTRY_WORDS.has(parts[parts.length - 1]!.toLowerCase())) parts.pop();
  const tail = parts.length > 0 ? STATE.exec(parts[parts.length - 1]!) : null;
  const state = tail ? tail[1]! : null;
  // "Street, City, ST ZIP": the city is the part before the state. Without a state token we cannot tell a city from a street.
  const city = tail && parts.length >= 2 ? parts[parts.length - 2]! : null;
  return Object.freeze({ city, state, formattedAddress: address });
}

/** The saved source that carries the Places listing, if any. */
export function findPlacesSource<T extends { excerpt: string }>(sources: readonly T[]): (T & { location: PlacesLocation }) | null {
  for (const source of sources) {
    const location = parsePlacesLocation(source.excerpt);
    if (location) return { ...source, location };
  }
  return null;
}
