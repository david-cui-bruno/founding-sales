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
import { randomUUID } from 'node:crypto';
import { createFounderSalesDomain } from '../../../src/main/domain/founderSalesDomain';
import { mapCloudSourceEvent } from '../../../src/main/sourcing/intakeMapper';
import { validParcelEvent } from '../../fixtures/cloudSourceEvents';
import { createDiscoveryDatabase, DISCOVERY_NOW } from '../../fixtures/discoveryDatabase';

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
  qualificationState: 'eligible',
  fitBand: 'high',
  identityReady: true,
  hasUsableDirectContact: false,
  suppressionBlocked: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Each row fails this gate and every later domain gate, pinning precedence.
const GATE_CASES: { reason: string; overrides: Partial<EnrichmentCandidate> }[] = [
  { reason: 'qualification_required', overrides: {
    qualificationState: 'unreviewed', fitBand: 'low', identityReady: false,
    hasUsableDirectContact: true, suppressionBlocked: true, lastRequestedAt: NOW,
  } },
  { reason: 'qualification_required', overrides: { qualificationState: 'disqualified' } },
  { reason: 'qualification_required', overrides: { qualificationState: 'merge_review' } },
  { reason: 'fit_gate_failed', overrides: {
    fitBand: 'low', identityReady: false, hasUsableDirectContact: true,
    suppressionBlocked: true, lastRequestedAt: NOW,
  } },
  { reason: 'fit_gate_failed', overrides: { fitBand: null } },
  { reason: 'identity_or_address_missing', overrides: {
    identityReady: false, hasUsableDirectContact: true,
    suppressionBlocked: true, lastRequestedAt: NOW,
  } },
  { reason: 'identity_or_address_missing', overrides: { cloudEntityId: null } },
  { reason: 'identity_or_address_missing', overrides: { ownerFullName: '  ' } },
  { reason: 'identity_or_address_missing', overrides: { situsAddress: null } },
  { reason: 'direct_contact_exists', overrides: {
    hasUsableDirectContact: true, suppressionBlocked: true, lastRequestedAt: NOW,
  } },
  { reason: 'suppression_blocked', overrides: { suppressionBlocked: true, lastRequestedAt: NOW } },
  { reason: 'rate_limited', overrides: { lastRequestedAt: NOW } },
];

function fakeGate(candidate: EnrichmentCandidate) {
  const recordEnrichmentRequested = vi.fn();
  const domain = {
    getEnrichmentRequestCandidate: vi.fn<(input: { personId: string }) => EnrichmentCandidate>(() => candidate),
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
  it('keeps prepared real source intake single-lead and rechecks changed ownership after credential acquisition', async () => {
    const f = await createDiscoveryDatabase();
    try {
      const domain = createFounderSalesDomain({ database: f.database, services: f.services,
        clock: { now: () => DISCOVERY_NOW }, ids: { next: randomUUID } });
      const event = validParcelEvent(); event.entity.property!.unit_count = 10;
      event.entity.person!.phones = []; event.entity.person!.emails = [];
      const mapped = mapCloudSourceEvent(event); if (mapped.kind !== 'intake') throw new Error('expected real intake');
      const owner = domain.importCloudSourceEvent({ command: mapped.command, cloudEntityId: mapped.cloudEntityId });
      const prospect = f.services.identities.getCanonicalProspect(owner.personId)!;
      const { store, puts } = fakeStore();
      let acquisitions = 0;
      const writer = new EnrichmentRequestWriter({
        domainGate: { withDomain: async (operation: (value: typeof domain) => unknown) => operation(domain) } as never,
        createStore: async () => {
          acquisitions += 1;
          f.database.raw.prepare('UPDATE persons SET provenance_json = ? WHERE id = ?')
            .run(JSON.stringify({ needsIdentity: true }), owner.personId);
          return store;
        }, clock: { now: () => DISCOVERY_NOW },
      });
      domain.assessDiscoveryProspect(prospect.id);
      expect(await writer.request({ personId: owner.personId })).toEqual({ written: false, refusalReason: 'qualification_required' });
      expect(acquisitions).toBe(0);
      const assessment = f.services.discoveryRepository.getCurrent(prospect.id)!;
      domain.beginDiscovery({ commandId: randomUUID(), personId: owner.personId, salesCycleId: assessment.salesCycleId,
        assessmentId: assessment.id, expectedFingerprint: assessment.fingerprint });
      expect(domain.getEnrichmentRequestCandidate({ personId: owner.personId })).toMatchObject({
        qualificationState: 'eligible', fitBand: 'medium', identityReady: true, hasUsableDirectContact: false });
      expect(puts).toEqual([]);
      expect(await writer.request({ personId: owner.personId })).toEqual({ written: false, refusalReason: 'identity_or_address_missing' });
      expect(acquisitions).toBe(1);
      expect(puts).toEqual([]);
      expect(f.database.raw.prepare('SELECT * FROM sourcing_enrichment_requests').all()).toEqual([]);
      expect(f.services.identities.listContactMethodsForPerson(owner.personId)).toEqual([]);
    } finally { f.close(); }
  });

  it.each(GATE_CASES)('refuses $reason at entry before store creation, upload, or recording ($overrides)', async ({ reason, overrides }) => {
    const { gate, domain } = fakeGate({ ...CANDIDATE, ...overrides });
    const { store, puts } = fakeStore();
    const createStore = vi.fn(async () => store);
    await expect(buildWriter({ gate, createStore }).request({ personId: 'p-1' }))
      .resolves.toEqual({ written: false, refusalReason: reason });
    expect(createStore).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
    expect(domain.recordEnrichmentRequested).not.toHaveBeenCalled();
    expect(findContactInfoReceiptSchema.safeParse({ written: false, refusalReason: reason }).success).toBe(true);
  });

  it('rejects the superseded generic refusal vocabulary', () => {
    expect(findContactInfoReceiptSchema.safeParse({ written: false, refusalReason: 'not_eligible' }).success).toBe(false);
  });

  it.each(GATE_CASES)('rechecks $reason after credentials settle without uploading or recording ($overrides)', async ({ reason, overrides }) => {
    const { gate, domain } = fakeGate(CANDIDATE);
    const { store, puts } = fakeStore();
    const credentials = deferred<UpstreamObjectStore>();
    const entered = deferred<void>();
    const createStore = vi.fn(() => { entered.resolve(); return credentials.promise; });
    const request = buildWriter({ gate, createStore }).request({ personId: 'p-1' });
    await entered.promise;
    domain.getEnrichmentRequestCandidate.mockReturnValue({ ...CANDIDATE, ...overrides });
    credentials.resolve(store);
    await expect(request).resolves.toEqual({ written: false, refusalReason: reason });
    expect(createStore).toHaveBeenCalledTimes(1);
    expect(puts).toEqual([]);
    expect(domain.recordEnrichmentRequested).not.toHaveBeenCalled();
  });

  it('uses final current identity and address for the single validated line and ledger', async () => {
    const { gate, domain } = fakeGate(CANDIDATE);
    const { store, puts } = fakeStore();
    const credentials = deferred<UpstreamObjectStore>();
    const entered = deferred<void>();
    const request = buildWriter({ gate, createStore: () => {
      entered.resolve(); return credentials.promise;
    } }).request({ personId: 'p-1' });
    await entered.promise;
    domain.getEnrichmentRequestCandidate.mockReturnValue({
      ...CANDIDATE, cloudEntityId: 'ce_01JC0000000000000000000001', ownerFullName: 'CURRENT OWNER',
      situsAddress: { line1: '45 Current St', locality: 'Cranston', region: 'RI', postalCode: null },
    });
    credentials.resolve(store);
    await expect(request).resolves.toEqual({ written: true, refusalReason: null });
    expect(puts).toHaveLength(1);
    expect(enrichmentRequestSchema.parse(JSON.parse(puts[0]!.body))).toEqual({
      cloud_entity_id: 'ce_01JC0000000000000000000001', requested_at: NOW,
      owner_full_name: 'CURRENT OWNER',
      situs_address: { line1: '45 Current St', locality: 'Cranston', region: 'RI', postal_code: null },
    });
    expect(domain.recordEnrichmentRequested).toHaveBeenCalledTimes(1);
    expect(domain.recordEnrichmentRequested).toHaveBeenCalledWith({
      cloudEntityId: 'ce_01JC0000000000000000000001',
    });
  });

  it('does not yield between the final synchronous decision and invoking upload', async () => {
    const { gate, domain } = fakeGate(CANDIDATE);
    let yielded = false;
    domain.getEnrichmentRequestCandidate.mockImplementation(() => {
      yielded = false;
      queueMicrotask(() => { yielded = true; });
      return CANDIDATE;
    });
    const putObjectText = vi.fn(async () => { expect(yielded).toBe(false); });
    await buildWriter({ gate, store: { putObjectText } }).request({ personId: 'p-1' });
    expect(putObjectText).toHaveBeenCalledTimes(1);
    expect(domain.getEnrichmentRequestCandidate).toHaveBeenCalledTimes(2);
  });

  it('coalesces identical concurrent clicks through upload settlement and only then records once', async () => {
    const { gate, domain } = fakeGate(CANDIDATE);
    const upload = deferred<void>();
    const started = deferred<void>();
    const putObjectText = vi.fn(() => { started.resolve(); return upload.promise; });
    const createStore = vi.fn(async () => ({ putObjectText }));
    const writer = buildWriter({ gate, createStore });
    const first = writer.request({ personId: 'p-1' });
    const second = writer.request({ personId: 'p-1' });
    await started.promise;
    const third = writer.request({ personId: 'p-1' });
    expect(domain.recordEnrichmentRequested).not.toHaveBeenCalled();
    upload.resolve();
    expect(await Promise.all([first, second, third])).toEqual([
      { written: true, refusalReason: null }, { written: true, refusalReason: null },
      { written: true, refusalReason: null },
    ]);
    expect(createStore).toHaveBeenCalledTimes(1);
    expect(putObjectText).toHaveBeenCalledTimes(1);
    expect(domain.recordEnrichmentRequested).toHaveBeenCalledTimes(1);
  });

  it('retains ownership after upload settles until normal recording completes', async () => {
    const { domain } = fakeGate(CANDIDATE);
    const recordingEntered = deferred<void>();
    const allowRecording = deferred<void>();
    let domainVisits = 0;
    const gate = {
      withDomain: async <T,>(operation: (d: typeof domain) => T) => {
        domainVisits += 1;
        if (domainVisits === 3) {
          recordingEntered.resolve();
          await allowRecording.promise;
        }
        return operation(domain);
      },
    };
    const putObjectText = vi.fn(async () => undefined);
    const createStore = vi.fn(async () => ({ putObjectText }));
    const writer = buildWriter({ gate, createStore });
    const first = writer.request({ personId: 'p-1' });
    await recordingEntered.promise;
    expect(putObjectText).toHaveBeenCalledTimes(1);
    expect(domain.recordEnrichmentRequested).not.toHaveBeenCalled();
    const second = writer.request({ personId: 'p-1' });
    allowRecording.resolve();
    expect(await Promise.all([first, second])).toEqual([
      { written: true, refusalReason: null }, { written: true, refusalReason: null },
    ]);
    expect(createStore).toHaveBeenCalledTimes(1);
    expect(putObjectText).toHaveBeenCalledTimes(1);
    expect(domain.recordEnrichmentRequested).toHaveBeenCalledTimes(1);
  });

  it('shares concurrent upload failure without recording or automatically replaying', async () => {
    const { gate, domain } = fakeGate(CANDIDATE);
    const putObjectText = vi.fn(async () => { throw new Error('AccessDenied'); });
    const writer = buildWriter({ gate, store: { putObjectText } });
    const results = await Promise.allSettled([
      writer.request({ personId: 'p-1' }), writer.request({ personId: 'p-1' }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(putObjectText).toHaveBeenCalledTimes(1);
    expect(domain.recordEnrichmentRequested).not.toHaveBeenCalled();
  });

  it('does not serialize unrelated people behind a pending upload', async () => {
    const { gate, domain } = fakeGate(CANDIDATE);
    domain.getEnrichmentRequestCandidate.mockImplementation(({ personId }) => ({
      ...CANDIDATE,
      cloudEntityId: personId === 'p-2' ? 'ce_01JC0000000000000000000001' : CANDIDATE.cloudEntityId,
    }));
    const upload = deferred<void>();
    const started = deferred<void>();
    const putObjectText = vi.fn().mockImplementationOnce(() => {
      started.resolve(); return upload.promise;
    }).mockResolvedValue(undefined);
    const writer = buildWriter({ gate, store: { putObjectText } });
    const first = writer.request({ personId: 'p-1' });
    await started.promise;
    await expect(writer.request({ personId: 'p-2' })).resolves.toEqual({ written: true, refusalReason: null });
    upload.resolve();
    await first;
    expect(putObjectText).toHaveBeenCalledTimes(2);
  });

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
      lastRequestedAt: '2026-08-02T15:00:00.000Z',
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
      .resolves.toEqual({ written: false, refusalReason: 'identity_or_address_missing' });
    await expect(buildWriter({ gate: noAddress.gate, store }).request({ personId: 'p-1' }))
      .resolves.toEqual({ written: false, refusalReason: 'identity_or_address_missing' });
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

  it.each(['resolve', 'reject'] as const)('retains same-person ownership after prompt timeout until the underlying upload can %s', async (settlement) => {
    const { gate, domain } = fakeGate(CANDIDATE);
    const underlying = deferred<void>();
    let firstSignal: AbortSignal | undefined;
    const putObjectText = vi.fn<UpstreamObjectStore['putObjectText']>()
      .mockImplementationOnce(({ signal }) => {
        firstSignal = signal;
        return underlying.promise; // Intentionally ignores abort.
      })
      .mockResolvedValue(undefined);
    const createStore = vi.fn(async () => ({ putObjectText }));
    const writer = buildWriter({ gate, createStore });
    const firstOutcome = vi.fn();
    void writer.request({ personId: 'p-1' }).then(firstOutcome, firstOutcome);

    await vi.advanceTimersByTimeAsync(60_000);
    // The caller must receive the deadline error while the upload is unresolved.
    expect(firstOutcome).toHaveBeenCalledTimes(1);
    expect(firstOutcome).toHaveBeenCalledWith(expect.objectContaining({
      name: 'RemoteOperationTimeoutError', code: 'S3_UPLOAD_TIMEOUT', timeoutMs: 60_000,
    }));
    expect(firstSignal?.aborted).toBe(true);
    expect(domain.recordEnrichmentRequested).not.toHaveBeenCalled();

    // This is the formerly uncovered interval: do not settle the first upload yet.
    const duringTimeout = await writer.request({ personId: 'p-1' }).catch((error: unknown) => error);
    expect(createStore).toHaveBeenCalledTimes(1);
    expect(putObjectText).toHaveBeenCalledTimes(1);
    expect(domain.recordEnrichmentRequested).not.toHaveBeenCalled();
    expect(duringTimeout).toBe(firstSignal?.reason);

    if (settlement === 'resolve') underlying.resolve();
    else underlying.reject(new Error('Late upload failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(domain.recordEnrichmentRequested).not.toHaveBeenCalled();
    expect(createStore).toHaveBeenCalledTimes(1);
    expect(putObjectText).toHaveBeenCalledTimes(1);

    await expect(writer.request({ personId: 'p-1' })).resolves.toEqual({
      written: true, refusalReason: null,
    });
    expect(createStore).toHaveBeenCalledTimes(2);
    expect(putObjectText).toHaveBeenCalledTimes(2);
    expect(domain.recordEnrichmentRequested).toHaveBeenCalledTimes(1);
    expect(domain.recordEnrichmentRequested).toHaveBeenCalledWith({ cloudEntityId: CANDIDATE.cloudEntityId });
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
    // Drain the async upload's settlement handlers, not just its inner promise.
    await vi.advanceTimersByTimeAsync(0);
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
