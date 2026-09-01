/**
 * Build CloudSourceEvents from extracted mail fields.
 *
 * Design rule (CONTRACT.md): typed fields only. Post titles / listing prose
 * are consumed here to compute flags and then discarded.
 */
import {
  computeIdempotencyKey,
  newCloudEntityId,
  newSourceEventId,
  TRIGGER_TYPES,
  type CloudSourceEvent,
} from "@callie-sourcing/shared";
import { toPostalAddress } from "./address";
import type { ExtractedListing, F5BotHit } from "./extract";
import { matchPainMentions, normalizeListingUrl } from "./extract";

export const ADAPTER_NAME = "mail-parse";
export const ADAPTER_VERSION = "1.0.0";

/** Confidence when all expected fields parsed. */
const FULL_CONFIDENCE = 0.9;
/** Confidence when some expected fields are missing (template drift). */
const DEGRADED_CONFIDENCE = 0.6;

export interface MailMeta {
  /** SES messageId — natural key component for this mail. */
  messageId: string;
  /** Date header (or receipt time) — observed_at. */
  observedAt: Date;
  /** Time the Lambda ran — fetched_at. */
  fetchedAt: Date;
}

export function buildFrboEvent(
  listing: ExtractedListing,
  source: "zillow" | "apartments",
  meta: MailMeta,
): CloudSourceEvent {
  const listingUrl = normalizeListingUrl(listing.listing_url);
  const missingField =
    listing.rent_usd === null ||
    listing.beds === null ||
    listing.baths === null ||
    listing.address === null;

  return {
    contract_version: 1,
    id: newSourceEventId(meta.fetchedAt.getTime()),
    // Natural key = the listing URL; fingerprint = extracted content, so a
    // re-listed unit at a new price is a new event but the same alert
    // delivered twice is not.
    idempotency_key: computeIdempotencyKey(
      "frbo",
      `${source}:${listingUrl}`,
      JSON.stringify({
        rent_usd: listing.rent_usd,
        beds: listing.beds,
        baths: listing.baths,
      }),
    ),
    channel: "frbo",
    source_uri: `ses:${source}-alert:${meta.messageId}`,
    fetched_at: meta.fetchedAt.toISOString(),
    observed_at: meta.observedAt.toISOString(),
    entity: {
      cloud_entity_id: newCloudEntityId(meta.fetchedAt.getTime()),
      // FRBO alert emails rarely name the owner; person stays null and the
      // app resolves identity downstream.
      person: null,
      property: {
        situs_address: listing.address ? toPostalAddress(listing.address) : null,
        parcel_id: null,
        unit_count: null,
        year_built: null,
        use_code: null,
      },
      known_person: false,
    },
    payload: {
      listing_url: listingUrl,
      rent_usd: listing.rent_usd,
      beds: listing.beds,
      baths: listing.baths,
      property_kind: listing.property_kind,
      listed_at: null, // alert emails do not carry a reliable listing date
    },
    signal_flags: {
      // By-owner listing implies self-management.
      self_managed: true,
      vacancy: null,
      pain_mentions: [],
      urgency: 1,
      portfolio_hint: null,
    },
    trigger: {
      type: "frbo_listing",
      weight: 1.0,
      half_life_days: TRIGGER_TYPES.frbo_listing.half_life_days,
      window: null,
    },
    scores: null,
    provenance: {
      adapter: ADAPTER_NAME,
      adapter_version: ADAPTER_VERSION,
      confidence: missingField ? DEGRADED_CONFIDENCE : FULL_CONFIDENCE,
    },
  };
}

export function buildCommunityEvent(hit: F5BotHit, meta: MailMeta): CloudSourceEvent {
  // Title is consumed for typed flags only; it is NOT copied into the event.
  const painMentions = matchPainMentions(hit.title);

  return {
    contract_version: 1,
    id: newSourceEventId(meta.fetchedAt.getTime()),
    idempotency_key: computeIdempotencyKey(
      "community",
      `f5bot:${hit.post_url}`,
      hit.keyword,
    ),
    channel: "community",
    source_uri: `ses:f5bot-alert:${meta.messageId}`,
    fetched_at: meta.fetchedAt.toISOString(),
    observed_at: meta.observedAt.toISOString(),
    entity: {
      cloud_entity_id: newCloudEntityId(meta.fetchedAt.getTime()),
      person: null,
      property: null,
      known_person: false,
    },
    payload: {
      platform: hit.platform,
      topic_keywords: [hit.keyword],
      post_url: hit.post_url,
    },
    signal_flags: {
      self_managed: null,
      vacancy: null,
      pain_mentions: painMentions,
      urgency: 1,
      portfolio_hint: null,
    },
    trigger: {
      type: "community_post",
      weight: 1.0,
      half_life_days: TRIGGER_TYPES.community_post.half_life_days,
      window: null,
    },
    scores: null,
    provenance: {
      adapter: ADAPTER_NAME,
      adapter_version: ADAPTER_VERSION,
      confidence: hit.title ? FULL_CONFIDENCE : DEGRADED_CONFIDENCE,
    },
  };
}
