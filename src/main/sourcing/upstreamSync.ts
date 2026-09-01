/**
 * Upstream sync (plan Task 4): membership set + outcome label flush.
 *
 * Two privacy-preserving objects flow app -> cloud per CONTRACT.md:
 *
 * 1. `upstream/membership/<YYYY-MM-DD>.json` — every linked cloud entity ID
 *    plus salted HMACs of manually-added persons' contact handles. Handles
 *    are hashed with HMAC-SHA256 (lowercase hex) over the normalized value
 *    (E.164 phone / lowercased trimmed email); without a provisioned salt
 *    the `contact_hmacs` field is omitted entirely, never sent empty-salted.
 * 2. `upstream/outcomes/<YYYY-MM-DD>.ndjson` — unflushed outcome-outbox rows.
 *    The upload line schema is enums/ids/timestamps ONLY: `loss_reason_code`
 *    is the closed Lost-Nurture reason enum, so free text physically cannot
 *    serialize. Rows are marked flushed only after the upload succeeds.
 *
 * Main-process only, injected clock and object store; the production store
 * shares the poller's scoped key (PutObject on `upstream/*` arrives via
 * terraform; until then a live run may see AccessDenied and simply retries
 * on a later poll because nothing was marked flushed).
 */
import { createHmac } from 'node:crypto';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';

import type { FoundationRuntime } from '../foundation/foundationRuntime';
import type { Clock } from '../domain/support/clock';
import {
  INBOX_AWS_REGION,
  INBOX_BUCKET,
  InboxCredentialsUnavailableError,
  type InboxCredentialProvider,
} from './inboxClient';

export const UPSTREAM_MEMBERSHIP_PREFIX = 'upstream/membership/';
export const UPSTREAM_OUTCOMES_PREFIX = 'upstream/outcomes/';

/** Minimal write-side store surface; S3 or an in-memory fake. */
export type UpstreamObjectStore = {
  putObjectText(input: {
    key: string;
    body: string;
    contentType: string;
  }): Promise<void>;
};

export type UpstreamSyncDomainGate = Pick<FoundationRuntime, 'withDomain'>;

const cloudEntityIdSchema = z
  .string()
  .regex(/^ce_[0-9A-HJKMNP-TV-Z]{26}$/, 'ce_<ULID>');

/** Wire shape of `upstream/membership/<date>.json` (CONTRACT.md upstream). */
export const membershipUploadSchema = z.object({
  cloud_entity_ids: z.array(cloudEntityIdSchema),
  contact_hmacs: z.array(z.string().regex(/^[0-9a-f]{64}$/)).optional(),
}).strict();

/**
 * One `upstream/outcomes/<date>.ndjson` line. Enums, ids, and timestamps
 * only — the schema has nowhere to put names or notes by construction.
 * `loss_reason_code` mirrors the CRM's closed Lost-Nurture reason enum
 * (lifecycleTypes.LostNurtureReason).
 */
export const outcomeUploadLineSchema = z.object({
  cloud_entity_id: cloudEntityIdSchema,
  label: z.enum(['interviewed', 'offered', 'won', 'lost', 'override']),
  loss_reason_code: z.enum([
    'no_response', 'not_interested', 'bad_timing', 'not_decision_maker',
    'not_qualified', 'price', 'trust', 'chose_alternative', 'product_gap',
    'cadence_exhausted', 'disqualified', 'opt_out', 'other',
  ]).nullable(),
  override_direction: z.enum(['up', 'down']).nullable(),
  observed_at: z.string().datetime({ offset: false }),
}).strict();

export type UpstreamSyncReport = {
  membershipUploaded: boolean;
  outcomesFlushed: number;
};

/**
 * HMAC-SHA256 (lowercase hex) over one normalized handle. Phones are E.164
 * already; emails are lowercased and trimmed here as a final normalization
 * guard so cloud-side and app-side hashes always agree.
 */
export function contactHmac(input: {
  salt: string;
  kind: 'phone' | 'email';
  normalizedValue: string;
}): string {
  const canonical = input.kind === 'email'
    ? input.normalizedValue.trim().toLowerCase()
    : input.normalizedValue.trim();
  return createHmac('sha256', input.salt).update(canonical, 'utf8').digest('hex');
}

export class UpstreamSync {
  private readonly domainGate: UpstreamSyncDomainGate;
  private readonly loadHmacSalt: () => Promise<string | null>;
  private readonly clock: Clock;

  constructor(input: {
    domainGate: UpstreamSyncDomainGate;
    loadHmacSalt: () => Promise<string | null>;
    clock: Clock;
  }) {
    this.domainGate = input.domainGate;
    this.loadHmacSalt = input.loadHmacSalt;
    this.clock = input.clock;
  }

  /**
   * One full sync: membership snapshot then outcome flush. Throws on upload
   * failure so the caller (poller) can count it; outbox rows are marked
   * flushed strictly after their upload succeeded, so a failed run retries
   * the same rows next poll.
   */
  async run(store: UpstreamObjectStore): Promise<UpstreamSyncReport> {
    const date = this.clock.now().slice(0, 10);
    const membershipUploaded = await this.uploadMembership(store, date);
    const outcomesFlushed = await this.flushOutcomes(store, date);
    return { membershipUploaded, outcomesFlushed };
  }

  private async uploadMembership(
    store: UpstreamObjectStore,
    date: string,
  ): Promise<boolean> {
    const membership = await this.domainGate.withDomain(
      (domain) => domain.listCloudMembership(),
    );
    const salt = await this.loadHmacSalt();
    const upload: z.infer<typeof membershipUploadSchema> = salt === null
      ? { cloud_entity_ids: membership.cloudEntityIds }
      : {
        cloud_entity_ids: membership.cloudEntityIds,
        contact_hmacs: membership.manualContacts.map((contact) => contactHmac({
          salt,
          kind: contact.kind,
          normalizedValue: contact.normalizedValue,
        })),
      };
    const hasHmacs = upload.contact_hmacs !== undefined
      && upload.contact_hmacs.length > 0;
    if (upload.cloud_entity_ids.length === 0 && !hasHmacs) {
      return false;
    }
    await store.putObjectText({
      key: `${UPSTREAM_MEMBERSHIP_PREFIX}${date}.json`,
      body: JSON.stringify(membershipUploadSchema.parse(upload)),
      contentType: 'application/json',
    });
    return true;
  }

  private async flushOutcomes(
    store: UpstreamObjectStore,
    date: string,
  ): Promise<number> {
    const rows = await this.domainGate.withDomain(
      (domain) => domain.listUnflushedCloudOutcomes(),
    );
    if (rows.length === 0) return 0;
    const lines = rows.map((row) => JSON.stringify(outcomeUploadLineSchema.parse({
      cloud_entity_id: row.cloudEntityId,
      label: row.label,
      loss_reason_code: row.lossReasonCode,
      override_direction: row.overrideDirection,
      observed_at: row.observedAt,
    })));
    await store.putObjectText({
      key: `${UPSTREAM_OUTCOMES_PREFIX}${date}.ndjson`,
      body: `${lines.join('\n')}\n`,
      contentType: 'application/x-ndjson',
    });
    await this.domainGate.withDomain((domain) => {
      domain.markCloudOutcomesFlushed({ ids: rows.map((row) => row.id) });
    });
    return rows.length;
  }
}

/**
 * Production `UpstreamObjectStore` over the same scoped key the inbox
 * client uses. Constructed per call; throws
 * `InboxCredentialsUnavailableError` when no key is provisioned.
 */
export async function createS3UpstreamObjectStore(input: {
  credentialProvider: InboxCredentialProvider;
  bucket?: string;
  region?: string;
}): Promise<UpstreamObjectStore> {
  const credentials = await input.credentialProvider();
  if (credentials === null) {
    throw new InboxCredentialsUnavailableError();
  }
  const bucket = input.bucket ?? INBOX_BUCKET;
  const client = new S3Client({
    region: input.region ?? INBOX_AWS_REGION,
    credentials,
  });
  return {
    async putObjectText({ key, body, contentType }) {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }));
    },
  };
}
