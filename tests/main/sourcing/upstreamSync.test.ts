import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const s3 = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: class {
      readonly send = s3.send;
    },
  };
});

import type { CloudOutcomeRow, SuppressionOutboxRow } from '../../../src/main/domain/founderSalesDomain';
import { suppressionUploadLineSchema } from '../../../src/shared/contracts/suppressionUploadContract';
import {
  createS3UpstreamObjectStore,
  UpstreamSync,
  contactHmac,
  membershipUploadSchema,
  outcomeUploadLineSchema,
  suppressionObjectKey,
  type UpstreamBatchIdGenerator,
  type UpstreamObjectStore,
} from '../../../src/main/sourcing/upstreamSync';

const NOW = '2026-09-01T12:00:00.000Z';
const SIGNAL = new AbortController().signal;
const CE_A = 'ce_01JC0000000000000000000000';
const CE_B = 'ce_01JC0000000000000000000001';

type FakeDomain = {
  listCloudMembership: ReturnType<typeof vi.fn>;
  listUnflushedCloudOutcomes: ReturnType<typeof vi.fn>;
  markCloudOutcomesFlushed: ReturnType<typeof vi.fn>;
  listUnflushedSuppressionHandles: ReturnType<typeof vi.fn>;
  markSuppressionHandlesFlushed: ReturnType<typeof vi.fn>;
};

function fakeDomain(overrides: Partial<{
  membership: {
    cloudEntityIds: string[];
    manualContacts: { kind: 'phone' | 'email'; normalizedValue: string }[];
  };
  outcomes: CloudOutcomeRow[];
  suppressions: SuppressionOutboxRow[];
}> = {}): { gate: { withDomain<T>(operation: (domain: FakeDomain) => T): Promise<T> }; domain: FakeDomain } {
  const domain: FakeDomain = {
    listCloudMembership: vi.fn(() => overrides.membership ?? {
      cloudEntityIds: [], manualContacts: [],
    }),
    listUnflushedCloudOutcomes: vi.fn(() => overrides.outcomes ?? []),
    markCloudOutcomesFlushed: vi.fn(),
    listUnflushedSuppressionHandles: vi.fn(() => overrides.suppressions ?? []),
    markSuppressionHandlesFlushed: vi.fn(),
  };
  return {
    gate: { withDomain: async (operation) => operation(domain) },
    domain,
  };
}

function fakeStore(): {
  store: UpstreamObjectStore;
  puts: { key: string; body: string; contentType: string; signal: AbortSignal }[];
} {
  const puts: { key: string; body: string; contentType: string; signal: AbortSignal }[] = [];
  return {
    store: {
      putObjectText: async (input) => {
        puts.push(input);
      },
    },
    puts,
  };
}

function buildSync(input: {
  gate: { withDomain<T>(operation: (domain: FakeDomain) => T): Promise<T> };
  salt?: string | null;
  clock?: { now(): string };
  batchIds?: UpstreamBatchIdGenerator;
}): UpstreamSync {
  return new UpstreamSync({
    domainGate: input.gate as never,
    loadHmacSalt: async () => input.salt ?? null,
    clock: input.clock ?? { now: () => NOW },
    batchIds: input.batchIds ?? { next: () => 'batch-1' },
  });
}

describe('UpstreamSync', () => {
  it('uploads membership with salted contact HMACs when the salt is set', async () => {
    const { gate } = fakeDomain({
      membership: {
        cloudEntityIds: [CE_A, CE_B],
        manualContacts: [
          { kind: 'email', normalizedValue: 'Manual@Example.com ' },
          { kind: 'phone', normalizedValue: '+14015550100' },
        ],
      },
    });
    const { store, puts } = fakeStore();

    const report = await buildSync({ gate, salt: 'shared-salt' }).run(store, SIGNAL);

    expect(report.membershipUploaded).toBe(true);
    const upload = puts.find((put) => put.key === 'upstream/membership/2026-09-01.json');
    expect(upload).toBeDefined();
    expect(upload!.contentType).toBe('application/json');
    const body = membershipUploadSchema.parse(JSON.parse(upload!.body));
    expect(body.cloud_entity_ids).toEqual([CE_A, CE_B]);
    // HMAC-SHA256(lowercased trimmed email / E.164 phone) with the shared
    // salt, lowercase hex. Never the cleartext handles.
    expect(body.contact_hmacs).toHaveLength(2);
    for (const hmac of body.contact_hmacs!) {
      expect(hmac).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(upload!.body).not.toContain('manual@example.com');
    expect(upload!.body).not.toContain('+14015550100');
  });

  it('omits contact_hmacs entirely when no salt is provisioned', async () => {
    const { gate } = fakeDomain({
      membership: {
        cloudEntityIds: [CE_A],
        manualContacts: [{ kind: 'phone', normalizedValue: '+14015550100' }],
      },
    });
    const { store, puts } = fakeStore();

    await buildSync({ gate, salt: null }).run(store, SIGNAL);

    const upload = puts.find((put) => put.key.startsWith('upstream/membership/'));
    const parsed = JSON.parse(upload!.body) as Record<string, unknown>;
    expect(parsed).toEqual({ cloud_entity_ids: [CE_A] });
  });

  it('skips the membership upload when there is nothing to report', async () => {
    const { gate } = fakeDomain();
    const { store, puts } = fakeStore();

    const report = await buildSync({ gate }).run(store, SIGNAL);

    expect(report.membershipUploaded).toBe(false);
    expect(puts).toEqual([]);
  });

  it('flushes unflushed outcomes as strict ndjson and marks them flushed', async () => {
    const outcomes: CloudOutcomeRow[] = [
      {
        id: 'stage:event-1', cloudEntityId: CE_A, label: 'interviewed',
        lossReasonCode: null, overrideDirection: null, observedAt: NOW,
      },
      {
        id: 'override-1', cloudEntityId: CE_B, label: 'override',
        lossReasonCode: null, overrideDirection: 'down', observedAt: NOW,
      },
    ];
    const { gate, domain } = fakeDomain({ outcomes });
    const { store, puts } = fakeStore();

    const report = await buildSync({ gate }).run(store, SIGNAL);

    expect(report.outcomesFlushed).toBe(2);
    const upload = puts.find((put) => put.key === 'upstream/outcomes/2026-09-01.ndjson');
    expect(upload).toBeDefined();
    expect(upload!.contentType).toBe('application/x-ndjson');
    const lines = upload!.body.trim().split('\n').map(
      (line) => outcomeUploadLineSchema.parse(JSON.parse(line)),
    );
    expect(lines).toEqual([
      {
        cloud_entity_id: CE_A, label: 'interviewed',
        loss_reason_code: null, override_direction: null, observed_at: NOW,
      },
      {
        cloud_entity_id: CE_B, label: 'override',
        loss_reason_code: null, override_direction: 'down', observed_at: NOW,
      },
    ]);
    expect(domain.markCloudOutcomesFlushed).toHaveBeenCalledWith({
      ids: ['stage:event-1', 'override-1'],
    });
  });

  it('never marks outcomes flushed when the upload fails', async () => {
    const outcomes: CloudOutcomeRow[] = [{
      id: 'stage:event-1', cloudEntityId: CE_A, label: 'won',
      lossReasonCode: null, overrideDirection: null, observedAt: NOW,
    }];
    const { gate, domain } = fakeDomain({ outcomes });
    const store: UpstreamObjectStore = {
      putObjectText: async () => {
        throw new Error('AccessDenied');
      },
    };

    await expect(buildSync({ gate }).run(store, SIGNAL)).rejects.toThrow('AccessDenied');
    expect(domain.markCloudOutcomesFlushed).not.toHaveBeenCalled();
  });

  it('rejects an outcome row whose reason code is not a closed enum value', () => {
    expect(() => outcomeUploadLineSchema.parse({
      cloud_entity_id: CE_A,
      label: 'lost',
      loss_reason_code: 'free text about a person',
      override_direction: null,
      observed_at: NOW,
    })).toThrow();
  });

  it('is deterministic: identical handles produce identical hmacs across runs', async () => {
    const membership = {
      cloudEntityIds: [CE_A],
      manualContacts: [{ kind: 'email' as const, normalizedValue: 'a@b.com' }],
    };
    const first = fakeStore();
    const second = fakeStore();
    await buildSync({ gate: fakeDomain({ membership }).gate, salt: 's' }).run(first.store, SIGNAL);
    await buildSync({ gate: fakeDomain({ membership }).gate, salt: 's' }).run(second.store, SIGNAL);

    expect(first.puts[0]!.body).toBe(second.puts[0]!.body);
  });

  it('marks only the uploaded handle IDs after success', async () => {
    const suppressions: SuppressionOutboxRow[] = [
      {
        handleId: 'handle-1', kind: 'phone', normalizedValue: '+14015550100',
        reason: 'founder_block', observedAt: NOW,
      },
      {
        handleId: 'handle-2', kind: 'email', normalizedValue: 'owner@example.com',
        reason: 'opt_out', observedAt: NOW,
      },
    ];
    const { gate, domain } = fakeDomain({ suppressions });
    const { store, puts } = fakeStore();

    const report = await buildSync({ gate, salt: 'shared-salt' }).run(store, SIGNAL);

    expect(report.suppressionsFlushed).toBe(2);
    const upload = puts.find((put) => put.key.startsWith('upstream/suppression/'));
    expect(upload).toBeDefined();
    expect(upload!.contentType).toBe('application/x-ndjson');
    const lines = upload!.body.trim().split('\n').map(
      (line) => suppressionUploadLineSchema.parse(JSON.parse(line)),
    );
    // The line HMACs must use the EXACT contactHmac canonicalization the
    // membership upload uses, keyed with the same shared salt.
    expect(lines).toEqual([
      {
        contact_hmac: contactHmac({
          salt: 'shared-salt', kind: 'phone', normalizedValue: '+14015550100',
        }),
        kind: 'phone', reason: 'founder_block', observed_at: NOW,
      },
      {
        contact_hmac: contactHmac({
          salt: 'shared-salt', kind: 'email', normalizedValue: 'owner@example.com',
        }),
        kind: 'email', reason: 'opt_out', observed_at: NOW,
      },
    ]);
    expect(domain.markSuppressionHandlesFlushed).toHaveBeenCalledWith({
      handleIds: ['handle-1', 'handle-2'],
    });
    expect(domain.markSuppressionHandlesFlushed).toHaveBeenCalledTimes(1);
  });

  it('uses distinct immutable keys for two suppression uploads on the same day', async () => {
    const suppressions: SuppressionOutboxRow[] = [{
      handleId: 'handle-1', kind: 'phone', normalizedValue: '+14015550100',
      reason: 'opt_out', observedAt: NOW,
    }];
    const { gate } = fakeDomain({ suppressions });
    const { store, puts } = fakeStore();
    const batchIds = ['batch-1', 'batch-2'];
    const sync = buildSync({
      gate,
      salt: 'shared-salt',
      batchIds: { next: () => batchIds.shift()! },
    });

    await sync.run(store, SIGNAL);
    await sync.run(store, SIGNAL);

    const keys = puts
      .filter((put) => put.key.startsWith('upstream/suppression/'))
      .map((put) => put.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it('includes UTC timestamp and batch ID under the singular suppression prefix', () => {
    expect(suppressionObjectKey({
      now: '2026-09-04T11:49:23.599-04:00',
      batchId: 'batch:/A B',
    })).toBe(
      'upstream/suppression/2026-09-04/20260904T154923599Z-batch-A-B.ndjson',
    );
  });

  it('never reuses a key after clock advancement or retry', async () => {
    const suppressions: SuppressionOutboxRow[] = [{
      handleId: 'handle-1', kind: 'phone', normalizedValue: '+14015550100',
      reason: 'opt_out', observedAt: NOW,
    }];
    const { gate } = fakeDomain({ suppressions });
    const attemptedKeys: string[] = [];
    let now = '2026-09-04T15:49:23.599Z';
    let fail = true;
    const batchIds = ['batch-1', 'batch-2'];
    const sync = buildSync({
      gate,
      salt: 'shared-salt',
      clock: { now: () => now },
      batchIds: { next: () => batchIds.shift()! },
    });
    const store: UpstreamObjectStore = {
      putObjectText: async ({ key }) => {
        if (!key.startsWith('upstream/suppression/')) return;
        attemptedKeys.push(key);
        if (fail) throw new Error('ambiguous put result');
      },
    };

    await expect(sync.run(store, SIGNAL)).rejects.toThrow('ambiguous put result');
    fail = false;
    now = '2026-09-04T15:50:00.000Z';
    await sync.run(store, SIGNAL);

    expect(attemptedKeys).toHaveLength(2);
    expect(attemptedKeys[1]).not.toBe(attemptedKeys[0]);
    expect(attemptedKeys).toEqual([
      'upstream/suppression/2026-09-04/20260904T154923599Z-batch-1.ndjson',
      'upstream/suppression/2026-09-04/20260904T155000000Z-batch-2.ndjson',
    ]);
  });

  it('contains no cleartext contact values in the key or body', async () => {
    const cleartextPhone = '+14015550100';
    const cleartextEmail = 'owner@example.com';
    const suppressions: SuppressionOutboxRow[] = [
      {
        handleId: 'handle-1', kind: 'phone', normalizedValue: cleartextPhone,
        reason: 'founder_block', observedAt: NOW,
      },
      {
        handleId: 'handle-2', kind: 'email', normalizedValue: cleartextEmail,
        reason: 'opt_out', observedAt: NOW,
      },
    ];
    const { gate } = fakeDomain({ suppressions });
    const { store, puts } = fakeStore();

    await buildSync({ gate, salt: 'shared-salt' }).run(store, SIGNAL);

    const upload = puts.find((put) => put.key.startsWith('upstream/suppression/'))!;
    const serializedUpload = `${upload.key}\n${upload.body}`;
    expect(serializedUpload).not.toContain(cleartextPhone);
    expect(serializedUpload).not.toContain(cleartextEmail);
  });

  it('matches the pinned HMAC vector so cloud and app hashes agree', () => {
    // createHmac('sha256', 'salt').update('+14015550100').digest('hex')
    expect(contactHmac({
      salt: 'salt', kind: 'phone', normalizedValue: '+14015550100',
    })).toBe(createHmac('sha256', 'salt').update('+14015550100', 'utf8').digest('hex'));
    // Emails are lowercased and trimmed before hashing.
    expect(contactHmac({
      salt: 'salt', kind: 'email', normalizedValue: ' Owner@Example.com ',
    })).toBe(createHmac('sha256', 'salt').update('owner@example.com', 'utf8').digest('hex'));
  });

  it('SKIPS the suppression step entirely when no salt is provisioned', async () => {
    const suppressions: SuppressionOutboxRow[] = [{
      handleId: 'handle-1', kind: 'phone', normalizedValue: '+14015550100',
      reason: 'opt_out', observedAt: NOW,
    }];
    const { gate, domain } = fakeDomain({ suppressions });
    const { store, puts } = fakeStore();

    const report = await buildSync({ gate, salt: null }).run(store, SIGNAL);

    expect(report.suppressionsFlushed).toBe(0);
    expect(puts.some((put) => put.key.startsWith('upstream/suppression/'))).toBe(false);
    // Never listed, never flushed: the rows retry once a salt exists.
    expect(domain.listUnflushedSuppressionHandles).not.toHaveBeenCalled();
    expect(domain.markSuppressionHandlesFlushed).not.toHaveBeenCalled();
  });

  it('does not mark handles flushed when the put fails', async () => {
    const suppressions: SuppressionOutboxRow[] = [{
      handleId: 'handle-1', kind: 'phone', normalizedValue: '+14015550100',
      reason: 'opt_out', observedAt: NOW,
    }];
    const { gate, domain } = fakeDomain({ suppressions });
    const store: UpstreamObjectStore = {
      putObjectText: async ({ key }) => {
        if (key.startsWith('upstream/suppression/')) {
          throw new Error('AccessDenied');
        }
      },
    };

    await expect(buildSync({ gate, salt: 's' }).run(store, SIGNAL)).rejects.toThrow('AccessDenied');
    expect(domain.markSuppressionHandlesFlushed).not.toHaveBeenCalled();
  });
});

describe('UpstreamSync upload deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not flush outcomes after a hung upload times out or settles late, then recovers', async () => {
    const outcomes: CloudOutcomeRow[] = [{
      id: 'stage:event-1', cloudEntityId: CE_A, label: 'won',
      lossReasonCode: null, overrideDirection: null, observedAt: NOW,
    }];
    const { gate, domain } = fakeDomain({ outcomes });
    const sync = buildSync({ gate, salt: null });
    let resolveLate!: () => void;
    let hang = true;
    let uploadSignal: AbortSignal | undefined;
    const store: UpstreamObjectStore = {
      putObjectText: async ({ signal }) => {
        uploadSignal = signal;
        if (hang) {
          await new Promise<void>((resolve) => {
            resolveLate = resolve;
          });
        }
      },
    };
    const result = sync.run(store, SIGNAL);
    const rejection = expect(result).rejects.toMatchObject({
      code: 'S3_UPLOAD_TIMEOUT',
      timeoutMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    expect(uploadSignal?.aborted).toBe(true);
    expect(domain.markCloudOutcomesFlushed).not.toHaveBeenCalled();

    resolveLate();
    await Promise.resolve();
    expect(domain.markCloudOutcomesFlushed).not.toHaveBeenCalled();

    hang = false;
    await sync.run(store, SIGNAL);
    expect(domain.markCloudOutcomesFlushed).toHaveBeenCalledWith({ ids: ['stage:event-1'] });
  });

  it('does not flush suppression handles after a hung upload times out or settles late, then recovers', async () => {
    const suppressions: SuppressionOutboxRow[] = [{
      handleId: 'handle-1', kind: 'phone', normalizedValue: '+14015550100',
      reason: 'opt_out', observedAt: NOW,
    }];
    const { gate, domain } = fakeDomain({ suppressions });
    const sync = buildSync({ gate, salt: 'shared-salt' });
    let resolveLate!: () => void;
    let hang = true;
    const store: UpstreamObjectStore = {
      putObjectText: async ({ signal }) => {
        if (!signal.aborted && hang) {
          await new Promise<void>((resolve) => {
            resolveLate = resolve;
          });
        }
      },
    };
    const result = sync.run(store, SIGNAL);
    const rejection = expect(result).rejects.toMatchObject({ code: 'S3_UPLOAD_TIMEOUT' });

    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    expect(domain.markSuppressionHandlesFlushed).not.toHaveBeenCalled();

    resolveLate();
    await Promise.resolve();
    expect(domain.markSuppressionHandlesFlushed).not.toHaveBeenCalled();

    hang = false;
    await sync.run(store, SIGNAL);
    expect(domain.markSuppressionHandlesFlushed).toHaveBeenCalledWith({
      handleIds: ['handle-1'],
    });
  });

  async function expectParentAbortReachesUpload(input: {
    domain: Parameters<typeof fakeDomain>[0];
    salt: string | null;
  }): Promise<{ domain: FakeDomain; uploadSignal: AbortSignal }> {
    const { gate, domain } = fakeDomain(input.domain);
    const sync = buildSync({ gate, salt: input.salt });
    let uploadSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const store: UpstreamObjectStore = {
      putObjectText: async ({ signal }) => {
        uploadSignal = signal;
        markStarted();
        return new Promise<void>(() => undefined);
      },
    };
    const parent = new AbortController();
    const reason = new Error('poll total deadline');
    const result = sync.run(store, parent.signal);
    await started;

    parent.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(uploadSignal).toBeDefined();
    expect(uploadSignal).not.toBe(parent.signal);
    expect(uploadSignal?.aborted).toBe(true);
    expect(uploadSignal?.reason).toBe(reason);
    return { domain, uploadSignal: uploadSignal! };
  }

  it('forwards the parent abort into the membership upload child deadline', async () => {
    await expectParentAbortReachesUpload({
      domain: {
        membership: { cloudEntityIds: [CE_A], manualContacts: [] },
      },
      salt: null,
    });
  });

  it('forwards the parent abort into the outcome upload child deadline without flushing', async () => {
    const { domain } = await expectParentAbortReachesUpload({
      domain: {
        outcomes: [{
          id: 'stage:event-1', cloudEntityId: CE_A, label: 'won',
          lossReasonCode: null, overrideDirection: null, observedAt: NOW,
        }],
      },
      salt: null,
    });
    expect(domain.markCloudOutcomesFlushed).not.toHaveBeenCalled();
  });

  it('forwards the parent abort into the suppression upload child deadline without flushing', async () => {
    const { domain } = await expectParentAbortReachesUpload({
      domain: {
        suppressions: [{
          handleId: 'handle-1', kind: 'phone', normalizedValue: '+14015550100',
          reason: 'opt_out', observedAt: NOW,
        }],
      },
      salt: 'shared-salt',
    });
    expect(domain.markSuppressionHandlesFlushed).not.toHaveBeenCalled();
  });
});

describe('S3 upstream object store cancellation', () => {
  afterEach(() => {
    s3.send.mockReset();
  });

  it('passes the exact upload child signal to S3 send', async () => {
    s3.send.mockResolvedValue({});
    const store = await createS3UpstreamObjectStore({
      credentialProvider: async () => ({ accessKeyId: 'AKIA', secretAccessKey: 'secret' }),
    });
    const signal = new AbortController().signal;

    await store.putObjectText({
      key: 'upstream/outcomes/2026-09-01.ndjson',
      body: '{}\n',
      contentType: 'application/x-ndjson',
      signal,
    });

    expect(s3.send.mock.calls[0]?.[1]).toEqual({ abortSignal: signal });
  });
});
