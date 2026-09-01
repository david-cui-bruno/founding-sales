/**
 * Field extraction from classified alert emails.
 *
 * Defensive by design: alert templates change without notice. Extract what we
 * can, null the rest, and let the caller lower provenance confidence when
 * fields are missing. Raw prose is never returned to callers beyond what is
 * needed to compute typed flags.
 */
import type { PainMention } from "@callie-sourcing/shared";
import { extractUsAddress, type ExtractedAddress } from "./address";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Crude tag stripper good enough for alert-card text extraction. */
export function stripTags(html: string): string {
  return html
    .replace(/<(?:style|script)\b[\s\S]*?<\/(?:style|script)>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|td|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** Strip query/fragment (tracking params) for stable listing URLs. */
export function normalizeListingUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

// ---------------------------------------------------------------------------
// FRBO listing alerts (Zillow / Apartments.com)
// ---------------------------------------------------------------------------

export interface ExtractedListing {
  listing_url: string;
  rent_usd: number | null;
  beds: number | null;
  baths: number | null;
  property_kind: "single_family" | "multi_family" | "condo" | "apartment" | "other";
  address: ExtractedAddress | null;
}

const LISTING_URL_PATTERNS: Record<"zillow_frbo" | "apartments_frbo", RegExp> = {
  zillow_frbo: /https?:\/\/(?:www\.)?zillow\.com\/homedetails\/[^\s"'<>]+/gi,
  apartments_frbo: /https?:\/\/(?:www\.)?apartments\.com\/[^\s"'<>]+/gi,
};

// Links that appear in footers, never listings.
const NON_LISTING_HINTS = /unsubscribe|preferences|privacy|settings|help|support|about/i;

function detectPropertyKind(text: string): ExtractedListing["property_kind"] {
  const t = text.toLowerCase();
  if (/multi[\s-]?family|duplex|triplex|\b\d+\s*units?\b/.test(t)) return "multi_family";
  if (/single[\s-]?family|\bhouse\b/.test(t)) return "single_family";
  if (/\bcondo(?:minium)?\b/.test(t)) return "condo";
  if (/\bapartment\b|\bapt\b/.test(t)) return "apartment";
  return "other";
}

function extractRent(text: string): number | null {
  const match = /\$\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.\d{2})?(?:\s*\/\s*mo(?:nth)?)?/.exec(text);
  if (!match || !match[1]) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function extractBeds(text: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*(?:bd|bds|beds?|br|bedrooms?)\b/i.exec(text);
  if (!match || !match[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function extractBaths(text: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*(?:ba|baths?|bathrooms?)\b/i.exec(text);
  if (!match || !match[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Extract one listing per unique listing URL. Each listing's fields come from
 * the chunk of body between its first link occurrence and the next listing's
 * link (alert emails render one card per listing, top to bottom).
 */
export function extractFrboListings(
  classification: "zillow_frbo" | "apartments_frbo",
  html: string | null,
  text: string | null,
): ExtractedListing[] {
  const body = html ?? text ?? "";
  if (!body) return [];

  const pattern = new RegExp(LISTING_URL_PATTERNS[classification].source, "gi");
  const seen = new Map<string, number>(); // normalized url -> first index
  for (const match of body.matchAll(pattern)) {
    if (NON_LISTING_HINTS.test(match[0])) continue;
    const normalized = normalizeListingUrl(match[0]);
    if (NON_LISTING_HINTS.test(normalized)) continue;
    if (!seen.has(normalized)) seen.set(normalized, match.index ?? 0);
  }

  const entries = [...seen.entries()].sort((a, b) => a[1] - b[1]);
  const listings: ExtractedListing[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const [url, start] = entry;
    // Card chunk: from this listing's link to the next listing's link (alert
    // emails render one card per listing, top to bottom, with the link at
    // the top of the card). No lookback: it would bleed the previous card's
    // fields into this one.
    const next = entries[i + 1];
    const chunkEnd = next ? next[1] : Math.min(body.length, start + 3000);
    const rawChunk = body.slice(start, chunkEnd);
    const chunkText = html ? stripTags(rawChunk) : rawChunk;

    listings.push({
      listing_url: url,
      rent_usd: extractRent(chunkText),
      beds: extractBeds(chunkText),
      baths: extractBaths(chunkText),
      property_kind: detectPropertyKind(chunkText),
      address: extractUsAddress(chunkText),
    });
  }

  return listings;
}

// ---------------------------------------------------------------------------
// F5Bot keyword alerts
// ---------------------------------------------------------------------------

export interface F5BotHit {
  keyword: string;
  post_url: string;
  platform: "reddit" | "hackernews" | "other";
  /**
   * Post title, used ONLY to compute typed pain flags. Callers MUST NOT copy
   * it into an event (design rule: flags, not prose).
   */
  title: string;
}

export function platformFromUrl(url: string): F5BotHit["platform"] {
  try {
    const host = new URL(url).host.toLowerCase();
    if (host === "reddit.com" || host.endsWith(".reddit.com")) return "reddit";
    if (host === "news.ycombinator.com") return "hackernews";
    return "other";
  } catch {
    return "other";
  }
}

const URL_IN_LINE = /https?:\/\/[^\s"'<>]+/;

/**
 * F5Bot emails are plain text: repeated blocks of
 *   Keyword: "some keyword"
 *   Reddit Post (r/sub): the post title
 *   https://www.reddit.com/...
 * Parse defensively; skip URLs we cannot tie to a keyword.
 */
export function extractF5BotHits(text: string | null): F5BotHit[] {
  if (!text) return [];
  const hits: F5BotHit[] = [];
  const lines = text.split(/\r?\n/);

  let keyword: string | null = null;
  let lastTitleLine = "";

  for (const line of lines) {
    const keywordMatch = /^\s*keyword:\s*(.+?)\s*$/i.exec(line);
    if (keywordMatch && keywordMatch[1]) {
      keyword = keywordMatch[1].replace(/^["']|["']$/g, "").trim();
      lastTitleLine = "";
      continue;
    }

    const urlMatch = URL_IN_LINE.exec(line);
    if (urlMatch) {
      const beforeUrl = line.slice(0, urlMatch.index).trim();
      const title = (beforeUrl || lastTitleLine).replace(/^[^:]{0,40}:\s*/, "").trim();
      if (keyword) {
        hits.push({
          keyword,
          post_url: urlMatch[0],
          platform: platformFromUrl(urlMatch[0]),
          title,
        });
      }
      lastTitleLine = "";
      continue;
    }

    if (line.trim()) lastTitleLine = line.trim();
  }

  return hits;
}

// ---------------------------------------------------------------------------
// Pain flag matching (typed flags from prose, prose discarded)
// ---------------------------------------------------------------------------

const PAIN_PATTERNS: Array<[PainMention, RegExp]> = [
  ["no_heat", /no[\s-]?heat|heat(?:ing)?\s+(?:is\s+)?(?:out|broken|not working)|without heat/i],
  ["slow_repair", /slow[\s-]?repairs?|(?:still|never|won't|wont)\s+fix|taking (?:weeks|months|forever)/i],
  ["unresponsive", /unresponsive|(?:won't|wont|doesn't|doesnt|never)\s+(?:respond|reply|answer|call back)|ignor(?:es|ing)/i],
  ["plumbing", /plumb(?:ing|er)|leak(?:ing|y)?\s*(?:pipe|faucet|toilet|sink)?|clogged|burst pipe|water damage/i],
  ["electrical", /electric(?:al|ian)?|wiring|breaker|outlet|power (?:out|issue)/i],
  ["pests", /pests?|mice|mouse|rats?|roach(?:es)?|cockroach|bed\s?bugs?|infestation|rodent/i],
  ["mold", /mold|mildew/i],
];

export function matchPainMentions(title: string): PainMention[] {
  const found: PainMention[] = [];
  for (const [pain, pattern] of PAIN_PATTERNS) {
    if (pattern.test(title)) found.push(pain);
  }
  return found;
}
