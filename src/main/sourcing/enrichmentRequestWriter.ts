/**
 * Enrichment request writer — the app side of the founder's explicit
 * "Find contact info" action (the ONLY way an enrichment lookup can happen;
 * no bulk enrichment, ever).
 *
 * One click writes ONE ndjson line to
 * s3://<inbox>/upstream/enrichment-requests/<date>-<ulid>.ndjson validated
 * against the exact cloud schema (enrichmentRequestSchema). The writer
 * requires the current domain qualification/fit/contact/suppression gates
 * and rate-limits to one request per cloud entity per 30 days via
 * the sourcing_enrichment_requests ledger (persisted only after a
 * successful upload). Failures never trigger an automatic replay.
 */
import { randomBytes } from 'node:crypto';

import {
  enrichmentRequestSchema,
  type FindContactInfoReceipt,
} from '../../shared/contracts/enrichmentRequestContract';
import { getFindContactEligibility } from '../domain/founderSalesDomain';
import type { Clock } from '../domain/support/clock';
import { runWithAbortDeadline } from '../runtime/abortDeadline';
import { InboxCredentialsUnavailableError } from './inboxClient';
import type { UpstreamObjectStore, UpstreamSyncDomainGate } from './upstreamSync';

export const UPSTREAM_ENRICHMENT_REQUESTS_PREFIX = 'upstream/enrichment-requests/';

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
  private readonly inFlight = new Map<string, Promise<FindContactInfoReceipt>>();

  constructor(input: {
    domainGate: UpstreamSyncDomainGate;
    createStore: () => Promise<UpstreamObjectStore>;
    clock: Clock;
  }) {
    this.domainGate = input.domainGate;
    this.createStore = input.createStore;
    this.clock = input.clock;
  }

  request(input: { personId: string }): Promise<FindContactInfoReceipt> {
    const personId = input.personId;
    const pending = this.inFlight.get(personId);
    if (pending !== undefined) return pending;
    const request = this.requestOnce({ personId }).finally(() => {
      this.inFlight.delete(personId);
    });
    this.inFlight.set(personId, request);
    return request;
  }

  private async requestOnce(input: { personId: string }): Promise<FindContactInfoReceipt> {
    const eligibility = await this.domainGate.withDomain((domain) => getFindContactEligibility(
      domain.getEnrichmentRequestCandidate(input), this.clock.now(),
    ));
    if (!eligibility.eligible) {
      return { written: false, refusalReason: eligibility.refusalReason };
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
    let uploadSignal!: AbortSignal;
    const outcome = await runWithAbortDeadline({
      code: 'S3_UPLOAD_TIMEOUT',
      timeoutMs: 60_000,
      operation: (signal) => {
        uploadSignal = signal;
        return this.domainGate.withDomain<FindContactInfoReceipt | { cloudEntityId: string }>((domain) => {
          signal.throwIfAborted();
          // Both credentials and the deadline wrapper may yield. Re-read here,
          // with no await or SQL transaction between this decision and upload.
          const candidate = domain.getEnrichmentRequestCandidate(input);
          const now = this.clock.now();
          const current = getFindContactEligibility(candidate, now);
          if (!current.eligible) return { written: false, refusalReason: current.refusalReason };
          const line = enrichmentRequestSchema.parse({
            cloud_entity_id: candidate.cloudEntityId,
            requested_at: now,
            situs_address: {
              line1: candidate.situsAddress!.line1,
              locality: candidate.situsAddress!.locality,
              region: candidate.situsAddress!.region,
              postal_code: candidate.situsAddress!.postalCode,
            },
            owner_full_name: candidate.ownerFullName,
          });
          const date = now.slice(0, 10);
          const ulid = generateUlid(Date.parse(now));
          return store.putObjectText({
            key: `${UPSTREAM_ENRICHMENT_REQUESTS_PREFIX}${date}-${ulid}.ndjson`,
            body: `${JSON.stringify(line)}\n`,
            contentType: 'application/x-ndjson',
            signal,
          }).then(() => ({ cloudEntityId: line.cloud_entity_id }));
        });
      },
    });
    uploadSignal.throwIfAborted();
    if (!('cloudEntityId' in outcome)) return outcome;
    await this.domainGate.withDomain((domain) => {
      domain.recordEnrichmentRequested({ cloudEntityId: outcome.cloudEntityId });
    });
    return { written: true, refusalReason: null };
  }
}
