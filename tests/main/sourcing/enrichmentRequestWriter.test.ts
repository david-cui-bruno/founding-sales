import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  enrichmentRequestSchema,
  findContactInfoReceiptSchema,
  findContactInfoRequestSchema,
} from '../../../src/shared/contracts/enrichmentRequestContract';
import { suppressionUploadLineSchema } from '../../../src/shared/contracts/suppressionUploadContract';
import type { EnrichmentCandidate } from '../../../src/main/domain/founderSalesDomain';
import {
  EnrichmentRequestWriter,
  generateUlid,
  UPSTREAM_ENRICHMENT_REQUESTS_PREFIX,
} from '../../../src/main/sourcing/enrichmentRequestWriter';
import { InboxCredentialsUnavailableError } from '../../../src/main/sourcing/inboxClient';
import type { UpstreamObjectStore } from '../../../src/main/sourcing/upstreamSync';
import { RemoteOperationTimeoutError } from '../../../src/main/runtime/abortDeadline';

const NOW = '2026-09-01T15:00:00.000Z';

// Fixture copied VERBATIM from cloud/lambdas/enricher/test/fixtures.ts —
// the exact line shape the enricher Lambda validates before any vendor call.
const CLOUD_ENRICHMENT_FIXTURE = {
  cloud_entity_id: 'ce_01JC0000000000000000000000',
  requested_at: '2026-09-01T15:00:00.000Z',
  situs_address: {
    line1: '123 Hope St',
    locality: 'Providence',
    region: 'RI',
    postal_code: '02906',
  },
  owner_full_name: 'JANE ROE',
};

// Fixture copied VERBATIM from cloud/lambdas/suppression-sync/test/handler.test.ts.
const CLOUD_SUPPRESSION_FIXTURE = {
  contact_hmac: 'a'.repeat(64),
  kind: 'phone',
  reason: 'opt_out',
  observed_at: '2026-09-02T11:00:00.000Z',
};

const CANDIDATE: EnrichmentCandidate = {
  cloudEntityId: 'ce_01JC0000000000000000000000',
  ownerFullName: 'JANE ROE',
  situsAddress: {
    line1: '123 Hope St',
    locality: 'Providence',
    region: 'RI',
    postalCode: '02906',
  },
  lastRequestedAt: null,
};

function fakeGate(candidate: EnrichmentCandidate) {
  const recordEnrichmentRequested = vi.fn();
  const domain = {
    getEnrichmentRequestCandidate: vi.fn(() => candidate),
    recordEnrichmentRequested,
  };
  return {
    gate: { withDomain: async <T,>(operation: (d: typeof domain) => T) => operation(domain) },
    domain,
  };
}

function fakeStore() {
  const puts: {
    key: string;
    body: string;
    contentType: string;
    signal: AbortSignal;
  }[] = [];
  const store: UpstreamObjectStore = {
    putObjectText: async (input) => {
      puts.push(input);
    },
  };
  return { store, puts };
}

function buildWriter(input: {
  gate: ReturnType<typeof fakeGate>['gate'];
  store?: UpstreamObjectStore;
  createStore?: () => Promise<UpstreamObjectStore>;
}) {
  return new EnrichmentRequestWriter({
    domainGate: input.gate as never,
    createStore: input.createStore ?? (async () => input.store!),
    clock: { now: () => NOW },
  });
}

describe('contract schemas mirror the cloud schemas exactly', () => {
  it('round-trips the verbatim cloud enrichment request fixture', () => {
    const parsed = enrichmentRequestSchema.parse(CLOUD_ENRICHMENT_FIXTURE);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(CLOUD_ENRICHMENT_FIXTURE);
  });

  it('round-trips the verbatim cloud suppression line fixture', () => {
    const parsed = suppressionUploadLineSchema.parse(CLOUD_SUPPRESSION_FIXTURE);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(CLOUD_SUPPRESSION_FIXTURE);
  });

  it('rejects drift the cloud schema would reject', () => {
    expect(() => enrichmentRequestSchema.parse({
      ...CLOUD_ENRICHMENT_FIXTURE,
      situs_address: { ...CLOUD_ENRICHMENT_FIXTURE.situs_address, region: 'Rhode Island' },
    })).toThrow();
    expect(() => enrichmentRequestSchema.parse({
      ...CLOUD_ENRICHMENT_FIXTURE, cloud_entity_id: 'not-a-ce-id',
    })).toThrow();
    expect(() => enrichmentRequestSchema.parse({
      ...CLOUD_ENRICHMENT_FIXTURE, extra: true,
    })).toThrow();
    expect(() => suppressionUploadLineSchema.parse({
      ...CLOUD_SUPPRESSION_FIXTURE, contact_hmac: 'TOO SHORT',
    })).toThrow();
    expect(() => suppressionUploadLineSchema.parse({
      ...CLOUD_SUPPRESSION_FIXTURE, reason: 'free text',
    })).toThrow();
  });

  it('validates the IPC request and receipt shapes strictly', () => {
    expect(findContactInfoRequestSchema.parse({ personId: 'p-1' }))
      .toEqual({ personId: 'p-1' });
    expect(() => findContactInfoRequestSchema.parse({ personId: '' })).toThrow();
    expect(() => findContactInfoRequestSchema.parse({ personId: 'p', x: 1 })).toThrow();
    expect(findContactInfoReceiptSchema.parse({ written: true, refusalReason: null }))
      .toEqual({ written: true, refusalReason: null });
    expect(() => findContactInfoReceiptSchema.parse({
      written: false, refusalReason: 'because',
    })).toThrow();
  });
});

describe('EnrichmentRequestWriter', () => {
  it('writes exactly one cloud-schema line and records the rate-limit timestamp', async () => {
    const { gate, domain } = fakeGate(CANDIDATE);
    const { store, puts } = fakeStore();

    const receipt = await buildWriter({ gate, store }).request({ personId: 'p-1' });

    expect(receipt).toEqual({ written: true, refusalReason: null });
    expect(puts).toHaveLength(1);
    const put = puts[0]!;
    expect(put.key.startsWith(`${UPSTREAM_ENRICHMENT_REQUESTS_PREFIX}2026-09-01-`)).toBe(true);
    expect(put.key.endsWith('.ndjson')).toBe(true);
    expect(put.contentType).toBe('application/x-ndjson');
    expect(put.signal).toBeInstanceOf(AbortSignal);
    expect(put.signal.aborted).toBe(false);
    const lines = put.body.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(enrichmentRequestSchema.parse(JSON.parse(lines[0]!)))
      .toEqual(CLOUD_ENRICHMENT_FIXTURE);
    expect(domain.recordEnrichmentRequested).toHaveBeenCalledWith({
      cloudEntityId: CANDIDATE.cloudEntityId,
    });
  });

  it('refuses a request made within the 30-day window without writing', async () => {
    // 29 days before NOW: still inside the window.
    const { gate, domain } = fakeGate({
      ...CANDIDATE,
      lastRequestedAt: '2026-08-03T15:00:00.001Z',
    });
    const { store, puts } = fakeStore();

    const receipt = await buildWriter({ gate, store }).request({ personId: 'p-1' });

    expect(receipt).toEqual({ written: false, refusalReason: 'rate_limited' });
    expect(puts).toEqual([]);
    expect(domain.recordEnrichmentRequested).not.toHaveBeenCalled();
  });

  it('allows a request once the 30-day window has fully elapsed', async () => {
    const { gate } = fakeGate({
      ...CANDIDATE,
      lastRequestedAt: '2026-08-01T15:00:00.000Z',
    });
    const { store, puts } = fakeStore();

    const receipt = await buildWriter({ gate, store }).request({ personId: 'p-1' });

    expect(receipt).toEqual({ written: true, refusalReason: null });
    expect(puts).toHaveLength(1);
  });

  it('refuses ineligible leads (no cloud link or no situs address)', async () => {
    const noLink = fakeGate({ ...CANDIDATE, cloudEntityId: null });
    const noAddress = fakeGate({ ...CANDIDATE, situsAddress: null });
    const { store, puts } = fakeStore();

    await expect(buildWriter({ gate: noLink.gate, store }).request({ personId: 'p-1' }))
      .resolves.toEqual({ written: false, refusalReason: 'not_eligible' });
    await expect(buildWriter({ gate: noAddress.gate, store }).request({ personId: 'p-1' }))
      .resolves.toEqual({ written: false, refusalReason: 'not_eligible' });
    expect(puts).toEqual([]);
  });

  it('surfaces missing credentials as a validated refusal, not a throw', async () => {
    const { gate, domain } = fakeGate(CANDIDATE);
    const writer = buildWriter({
      gate,
      createStore: async () => {
        throw new InboxCredentialsUnavailableError();
      },
    });

    await expect(writer.request({ personId: 'p-1' }))
      .resolves.toEqual({ written: false, refusalReason: 'credentials_unavailable' });
    expect(domain.recordEnrichmentRequested).not.toHaveBeenCalled();
  });

  it('never records the rate limit when the upload fails (so it retries)', async () => {
    const { gate, domain } = fakeGate(CANDIDATE);
    const store: UpstreamObjectStore = {
      putObjectText: async () => {
        throw new Error('AccessDenied');
      },
    };

    await expect(buildWriter({ gate, store }).request({ personId: 'p-1' }))
      .rejects.toThrow('AccessDenied');
    expect(domain.recordEnrichmentRequested).not.toHaveBeenCalled();
  });

  it('generates cloud-shaped ULIDs (26 Crockford chars)', () => {
    const ulid = generateUlid(Date.parse(NOW));
    expect(ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(generateUlid(Date.parse(NOW)).slice(0, 10)).toBe(ulid.slice(0, 10));
  });
});

describe('EnrichmentRequestWriter upload deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('times out a hung upload without recording, ignores late settlement, and later recovers', async () => {
    const { gate, domain } = fakeGate(CANDIDATE);
    let resolveLate!: () => void;
    let uploadAttempts = 0;
    let firstSignal: AbortSignal | undefined;
    const store: UpstreamObjectStore = {
      putObjectText: async ({ signal }) => {
        uploadAttempts += 1;
        if (uploadAttempts === 1) {
          firstSignal = signal;
          await new Promise<void>((resolve) => {
            resolveLate = resolve;
          });
        }
      },
    };
    const writer = buildWriter({ gate, store });
    const firstRequest = writer.request({ personId: 'p-1' });
    const rejection = expect(firstRequest).rejects.toMatchObject({
      name: 'RemoteOperationTimeoutError',
      code: 'S3_UPLOAD_TIMEOUT',
      timeoutMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;

    expect(firstSignal).toBeDefined();
    expect(firstSignal?.aborted).toBe(true);
    expect(firstSignal?.reason).toBeInstanceOf(RemoteOperationTimeoutError);
    expect(domain.recordEnrichmentRequested).not.toHaveBeenCalled();

    resolveLate();
    await Promise.resolve();
    expect(domain.recordEnrichmentRequested).not.toHaveBeenCalled();

    await expect(writer.request({ personId: 'p-1' })).resolves.toEqual({
      written: true,
      refusalReason: null,
    });
    expect(domain.recordEnrichmentRequested).toHaveBeenCalledTimes(1);
    expect(domain.recordEnrichmentRequested).toHaveBeenCalledWith({
      cloudEntityId: CANDIDATE.cloudEntityId,
    });
  });
});
