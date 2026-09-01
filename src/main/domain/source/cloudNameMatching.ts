/**
 * Cloud identity matching support (duplicate-person fix).
 *
 * Public-record events (parcel/deed/permit/violation) are usually
 * contact-less, so handle-based identity resolution has nothing to match.
 * The app instead converges on the cloud entity link first and, for these
 * channels only, on a normalized display name restricted to persons that
 * are already cloud-linked. The normalization here is intentionally shared
 * with the 0008 dedupe migration so the runtime matcher and the data repair
 * agree byte-for-byte on what "the same owner name" means.
 */

export const CLOUD_PUBLIC_RECORD_CHANNELS = [
  'parcel', 'deed', 'permit', 'violation',
] as const;

export type CloudPublicRecordChannel = (typeof CLOUD_PUBLIC_RECORD_CHANNELS)[number];

export function isCloudPublicRecordChannel(
  channel: string,
): channel is CloudPublicRecordChannel {
  return (CLOUD_PUBLIC_RECORD_CHANNELS as readonly string[]).includes(channel);
}

/**
 * Uppercase, strip punctuation, collapse whitespace. "212, LLC." and
 * " 212  llc" both normalize to "212 LLC".
 */
export function normalizeCloudDisplayName(value: string): string {
  return value
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
