/**
 * Small regex-based US situs-address extractor for listing alert emails.
 *
 * Handles the common "street line, City, ST 02906" shape (optionally with a
 * ", Apt/Unit/# ..." segment before the city). Deliberately NOT libpostal:
 * when the shape does not match we return null and the event ships with
 * situs_address null + lower provenance confidence.
 */
import type { PostalAddress } from "@callie-sourcing/shared";

export interface ExtractedAddress {
  line1: string;
  locality: string;
  region: string;
  postal_code: string;
}

// street (starts with a house number, no commas) [, unit] , city , ST zip
const ADDRESS_RE =
  /(\d+[A-Za-z0-9 .'#/-]*?(?:,\s*(?:Apt|Apartment|Unit|Ste|Suite|#)\s*[A-Za-z0-9-]+)?)\s*,\s*([A-Za-z][A-Za-z .'-]*?)\s*,\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/;

export function extractUsAddress(text: string): ExtractedAddress | null {
  const match = ADDRESS_RE.exec(text);
  if (!match) return null;
  const [, rawLine1, locality, region, postalCode] = match;
  if (!rawLine1 || !locality || !region || !postalCode) return null;
  // The street segment can greedily swallow preceding prose that contains
  // numbers ("1.5 ba 123 Hope St"). Refine: start line1 at the LAST
  // house-number-like token (digits, space, then a letter).
  let line1 = rawLine1;
  const starts = [...line1.matchAll(/\b\d+[A-Za-z]?\s+(?=[A-Za-z])/g)];
  const last = starts[starts.length - 1];
  if (last && last.index !== undefined && last.index > 0) {
    line1 = line1.slice(last.index);
  }
  return {
    line1: line1.replace(/\s+/g, " ").trim(),
    locality: locality.replace(/\s+/g, " ").trim(),
    region,
    postal_code: postalCode,
  };
}

export function toPostalAddress(addr: ExtractedAddress): PostalAddress {
  return {
    line1: addr.line1,
    locality: addr.locality,
    region: addr.region,
    postal_code: addr.postal_code,
    country_code: "US",
  };
}
