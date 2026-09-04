/**
 * Enrichment request writer — the app side of the founder's explicit
 * "Find contact info" action (the ONLY way an enrichment lookup can happen;
 * no bulk enrichment, ever).
 *
 * One click writes ONE ndjson line to
 * s3://<inbox>/upstream/enrichment-requests/<date>-<ulid>.ndjson validated
 * against the exact cloud schema (enrichmentRequestSchema). The writer
 * refuses when the person has no cloud entity link or no usable situs
 * address, and rate-limits to one request per cloud entity per 30 days via
 * the sourcing_enrichment_requests ledger (persisted only after a
 * successful upload, so a failed upload retries).
 */
import { randomBytes } from 'node:crypto';

import {
  enrichmentRequestSchema,
  type FindContactInfoReceipt,
} from '../../shared/contracts/enrichmentRequestContract';
import type { Clock } from '../domain/support/clock';
import { runWithAbortDeadline } from '../runtime/abortDeadline';
import { InboxCredentialsUnavailableError } from './inboxClient';
import type { UpstreamObjectStore, UpstreamSyncDomainGate } from './upstreamSync';

export const UPSTREAM_ENRICHMENT_REQUESTS_PREFIX = 'upstream/enrichment-requests/';

const RATE_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Crockford-base32 ULID (26 chars): 48-bit timestamp + 80 random bits. */
export function generateUlid(timestampMs: number): string {
  let time = timestampMs;
  const timeChars = new Array<string>(10);
  for (let index = 9; index >= 0; index -= 1) {
    timeChars[index] = CROCKFORD[time % 32]!;
    time = Math.floor(time / 32);
  }
  const random = randomBytes(16);
  let randomChars = '';
  for (let index = 0; index < 16; index += 1) {
    randomChars += CROCKFORD[random[index]! % 32]!;
  }
  return timeChars.join('') + randomChars;
}

export class EnrichmentRequestWriter {
  private readonly domainGate: UpstreamSyncDomainGate;
  private readonly createStore: () => Promise<UpstreamObjectStore>;
  private readonly clock: Clock;

  constructor(input: {
    domainGate: UpstreamSyncDomainGate;
    createStore: () => Promise<UpstreamObjectStore>;
    clock: Clock;
  }) {
    this.domainGate = input.domainGate;
    this.createStore = input.createStore;
    this.clock = input.clock;
  }

  async request(input: { personId: string }): Promise<FindContactInfoReceipt> {
    const candidate = await this.domainGate.withDomain(
      (domain) => domain.getEnrichmentRequestCandidate({ personId: input.personId }),
    );
    if (candidate.cloudEntityId === null || candidate.situsAddress === null
      || candidate.ownerFullName.trim().length === 0) {
      return { written: false, refusalReason: 'not_eligible' };
    }
    const now = this.clock.now();
    if (candidate.lastRequestedAt !== null) {
      const elapsed = new Date(now).getTime()
        - new Date(candidate.lastRequestedAt).getTime();
      if (elapsed < RATE_LIMIT_MS) {
        return { written: false, refusalReason: 'rate_limited' };
      }
    }
    let store: UpstreamObjectStore;
    try {
      store = await this.createStore();
    } catch (error) {
      if (error instanceof InboxCredentialsUnavailableError) {
        return { written: false, refusalReason: 'credentials_unavailable' };
      }
      throw error;
    }
    const line = enrichmentRequestSchema.parse({
      cloud_entity_id: candidate.cloudEntityId,
      requested_at: now,
      situs_address: {
        line1: candidate.situsAddress.line1,
        locality: candidate.situsAddress.locality,
        region: candidate.situsAddress.region,
        postal_code: candidate.situsAddress.postalCode,
      },
      owner_full_name: candidate.ownerFullName,
    });
    const date = now.slice(0, 10);
    const ulid = generateUlid(new Date(now).getTime());
    let uploadSignal!: AbortSignal;
    await runWithAbortDeadline({
      code: 'S3_UPLOAD_TIMEOUT',
      timeoutMs: 60_000,
      operation: (signal) => {
        uploadSignal = signal;
        return store.putObjectText({
          key: `${UPSTREAM_ENRICHMENT_REQUESTS_PREFIX}${date}-${ulid}.ndjson`,
          body: `${JSON.stringify(line)}\n`,
          contentType: 'application/x-ndjson',
          signal,
        });
      },
    });
    uploadSignal.throwIfAborted();
    const cloudEntityId = candidate.cloudEntityId;
    await this.domainGate.withDomain((domain) => {
      domain.recordEnrichmentRequested({ cloudEntityId });
    });
    return { written: true, refusalReason: null };
  }
}
